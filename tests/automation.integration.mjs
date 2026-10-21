import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { inflateSync } from "node:zlib";

// Explicit launch creates an isolated, hidden test instance. Existing instances
// are touched only when their discovery file is supplied explicitly.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const launch = args.includes("--launch");
const discoveryIndex = args.indexOf("--discovery");
if (!launch && discoveryIndex < 0 && !process.env.COMPOSITOR_AUTOMATION_FILE) {
  throw new Error(
    "Usage: node tests/automation.integration.mjs --launch | --discovery PATH",
  );
}
const scratch = path.join(
  root,
  "work",
  "automation-integration",
  `${Date.now()}-${process.pid}`,
);
await fs.mkdir(scratch, { recursive: true });
const discoveryPath = launch
  ? path.join(scratch, "automation.json")
  : path.resolve(
      discoveryIndex >= 0
        ? args[discoveryIndex + 1]
        : process.env.COMPOSITOR_AUTOMATION_FILE,
    );
let child;
let discovery;
let logs = "";
const results = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function rpc(action, args = {}) {
  const response = await fetch(`http://127.0.0.1:${discovery.port}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${discovery.token}`,
    },
    body: JSON.stringify({ action, args }),
    signal: AbortSignal.timeout(35_000),
  });
  const payload = await response.json();
  if (!response.ok || payload.error)
    throw new Error(payload.error || `RPC HTTP ${response.status}`);
  return payload.result;
}
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({
      name,
      passed: false,
      error: String(error.message || error),
    });
    console.error(`FAIL ${name}: ${error.message || error}`);
  }
}
const active = (state) => {
  const search = (layers) => {
    for (const layer of layers) {
      if (layer.id === state.activeLayerId) return layer;
      if (layer.children) {
        const found = search(layer.children);
        if (found) return found;
      }
    }
  };
  return search(state.document.layers);
};

// Canvas PNG exports use non-interlaced 8-bit RGB(A). Decode them independently
// of the editor to check actual exported pixels instead of only layer metadata.
function decodePNG(base64) {
  const buffer = Buffer.from(base64, "base64");
  assert.deepEqual(
    [...buffer.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  let offset = 8,
    width,
    height,
    channels,
    palette,
    transparency;
  const chunks = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset),
      type = buffer.toString("ascii", offset + 4, offset + 8),
      data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, "8-bit PNG expected");
      assert.equal(data[12], 0, "non-interlaced PNG expected");
      channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[data[9]];
      assert(channels, "unsupported PNG color type");
    }
    if (type === "IDAT") chunks.push(data);
    if (type === "PLTE") palette = data;
    if (type === "tRNS") transparency = data;
    offset += length + 12;
    if (type === "IEND") break;
  }
  const raw = inflateSync(Buffer.concat(chunks)),
    stride = width * channels,
    pixels = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)],
      row = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + x + 1],
        a = x >= channels ? pixels[row + x - channels] : 0,
        b = y ? pixels[row - stride + x] : 0,
        c = y && x >= channels ? pixels[row - stride + x - channels] : 0;
      pixels[row + x] =
        (value +
          (filter === 0
            ? 0
            : filter === 1
              ? a
              : filter === 2
                ? b
                : filter === 3
                  ? Math.floor((a + b) / 2)
                  : filter === 4
                    ? paeth(a, b, c)
                    : (() => {
                        throw Error("invalid PNG filter");
                      })())) &
        255;
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const i = (y * width + x) * channels;
      if (palette) {
        const p = pixels[i];
        return [
          palette[p * 3],
          palette[p * 3 + 1],
          palette[p * 3 + 2],
          transparency?.[p] ?? 255,
        ];
      }
      if (channels === 4) return [...pixels.subarray(i, i + 4)];
      if (channels === 3) return [...pixels.subarray(i, i + 3), 255];
      return [
        pixels[i],
        pixels[i],
        pixels[i],
        channels === 2 ? pixels[i + 1] : 255,
      ];
    },
  };
}
const png = async () =>
  decodePNG((await rpc("export", { format: "png" })).base64);
const newDoc = async (name, background = "transparent") =>
  rpc("new_document", { name, width: 64, height: 48, background });
const stable = (state) => ({
  document: state.document,
  selection: state.selection,
  activeLayerId: state.activeLayerId,
  history: state.history,
});

try {
  if (launch) {
    await fs.access(path.join(root, "dist", "index.html"));
    const require = createRequire(import.meta.url),
      executable = require("electron");
    const env = {
      ...process.env,
      COMPOSITOR_HEADLESS: "1",
      COMPOSITOR_AUTOMATION_FILE: discoveryPath,
      COMPOSITOR_USER_DATA: path.join(scratch, "profile"),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.COMPOSITOR_DEV_URL;
    child = spawn(executable, [root, "--disable-gpu"], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      logs += chunk;
    });
    child.stderr.on("data", (chunk) => {
      logs += chunk;
    });
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error(`Electron exited ${child.exitCode}\n${logs}`);
      try {
        discovery = JSON.parse(await fs.readFile(discoveryPath, "utf8"));
        break;
      } catch {}
      await sleep(200);
    }
    if (!discovery)
      throw new Error(`Electron did not create automation discovery\n${logs}`);
  } else discovery = JSON.parse(await fs.readFile(discoveryPath, "utf8"));
  await rpc("get_state");

  await check(
    "new document, editable shape, transform, adjustment, mask and PNG pixels",
    async () => {
      const created = await newDoc("Integration layers");
      assert.equal(created.document.width, 64);
      assert.equal(created.document.height, 48);
      let state = await rpc("add_shape", {
        kind: "rectangle",
        x: 8,
        y: 8,
        width: 20,
        height: 16,
        color: "#ff0000",
      });
      const shapeId = state.activeLayerId;
      assert.equal(active(state).type, "shape");
      assert.equal(active(state).shape.fill, "#ff0000");
      assert.deepEqual((await png()).pixel(10, 10), [255, 0, 0, 255]);
      state = await rpc("transform", {
        layerId: shapeId,
        x: 12,
        y: 10,
        scaleX: 1.5,
        scaleY: 1,
      });
      assert.equal(active(state).x, 12);
      assert.equal(active(state).scaleX, 1.5);
      assert.deepEqual((await png()).pixel(40, 12), [255, 0, 0, 255]);
      await rpc("adjust", { layerId: shapeId, invert: true });
      assert.deepEqual((await png()).pixel(15, 12), [0, 255, 255, 255]);
      await rpc("select_rect", { x: 12, y: 10, width: 10, height: 16 });
      state = await rpc("add_mask", { layerId: shapeId });
      assert.equal(active(state).mask, true);
      await rpc("deselect");
      const image = await png();
      assert.deepEqual(image.pixel(15, 12), [0, 255, 255, 255]);
      assert.equal(image.pixel(30, 12)[3], 0);
    },
  );

  await check(
    "editable text and cwdoc export/reopen retain layer metadata and exact composite",
    async () => {
      const state = await rpc("add_text", {
        text: "Windows 测试",
        x: 2,
        y: 31,
        fontSize: 12,
        color: "#ffffff",
        fontFamily: "Arial",
      });
      assert.equal(active(state).type, "text");
      assert.equal(active(state).text.content, "Windows 测试");
      const beforePNG = await rpc("export", { format: "png" });
      const project = await rpc("export", { format: "cwdoc" });
      assert(project.base64.length > 50);
      await fs.writeFile(
        path.join(scratch, "roundtrip.cwdoc"),
        Buffer.from(project.base64, "base64"),
      );
      const reopened = await rpc("open_image", {
        name: "roundtrip.cwdoc",
        base64: project.base64,
      });
      assert.equal(
        reopened.document.layers.length,
        state.document.layers.length,
      );
      const text = reopened.document.layers.find(
        (layer) => layer.type === "text",
      );
      assert.equal(text.text.content, "Windows 测试");
      const shape = reopened.document.layers.find(
        (layer) => layer.type === "shape",
      );
      assert.equal(shape.mask, true);
      assert.equal(shape.adjustments.invert, true);
      assert.equal(
        (await rpc("export", { format: "png" })).base64,
        beforePNG.base64,
      );
      await fs.writeFile(
        path.join(scratch, "roundtrip.png"),
        Buffer.from(beforePNG.base64, "base64"),
      );
    },
  );

  await check("undo and redo restore actual edited pixels", async () => {
    await newDoc("Undo pixels");
    await rpc("fill", { color: "#ff0000" });
    await rpc("fill", { color: "#0000ff" });
    assert.deepEqual((await png()).pixel(3, 3), [0, 0, 255, 255]);
    await rpc("undo");
    assert.deepEqual((await png()).pixel(3, 3), [255, 0, 0, 255]);
    await rpc("redo");
    assert.deepEqual((await png()).pixel(3, 3), [0, 0, 255, 255]);
  });

  await check("successful batch is exactly one undo operation", async () => {
    const before = await newDoc("Batch success");
    const state = await rpc("batch", {
      label: "Integration batch",
      commands: [
        {
          action: "add_shape",
          args: {
            kind: "rectangle",
            x: 4,
            y: 4,
            width: 24,
            height: 20,
            color: "#ff0000",
          },
        },
        { action: "transform", args: { x: 10, y: 8 } },
        { action: "adjust", args: { invert: true } },
      ],
    });
    assert.equal(state.history.length, before.history.length + 1);
    assert.deepEqual((await png()).pixel(12, 10), [0, 255, 255, 255]);
    const undone = await rpc("undo");
    assert.equal(undone.document.layers.length, before.document.layers.length);
    assert.equal((await png()).pixel(12, 10)[3], 0);
    await rpc("redo");
    assert.deepEqual((await png()).pixel(12, 10), [0, 255, 255, 255]);
  });

  await check(
    "failed batch rolls back pixels, selection and history without losing redo",
    async () => {
      await newDoc("Batch rollback");
      await rpc("fill", { color: "#ff0000" });
      await rpc("fill", { color: "#0000ff" });
      await rpc("undo");
      await rpc("select_rect", { x: 1, y: 2, width: 8, height: 9 });
      const before = await rpc("get_state");
      const beforePNG = await rpc("export", { format: "png" });
      await assert.rejects(
        rpc("batch", {
          commands: [
            {
              action: "select_rect",
              args: { x: 20, y: 20, width: 12, height: 10 },
            },
            { action: "fill", args: { color: "#00ff00" } },
            { action: "does_not_exist", args: {} },
          ],
        }),
        /命令|支持|unknown/i,
      );
      assert.deepEqual(stable(await rpc("get_state")), stable(before));
      assert.equal(
        (await rpc("export", { format: "png" })).base64,
        beforePNG.base64,
      );
      await rpc("redo");
      assert.deepEqual((await png()).pixel(2, 2), [0, 0, 255, 255]);
    },
  );

  await check(
    "unknown filter rejects without changing history or redo",
    async () => {
      await newDoc("Invalid filter");
      await rpc("fill", { color: "#ff0000" });
      await rpc("fill", { color: "#0000ff" });
      await rpc("undo");
      const before = await rpc("get_state");
      await assert.rejects(
        rpc("filter", { kind: "not-a-filter", amount: 20 }),
        /滤镜|filter/i,
      );
      assert.deepEqual(stable(await rpc("get_state")), stable(before));
      await rpc("redo");
      assert.deepEqual((await png()).pixel(2, 2), [0, 0, 255, 255]);
    },
  );

  await check(
    "locked layers reject content edits, transform, deletion and masks",
    async () => {
      await newDoc("Locked layer");
      await rpc("add_text", { text: "Locked", fontSize: 18, x: 2, y: 2 });
      await rpc("set_layer", { locked: true });
      const before = await rpc("get_state");
      for (const [action, args] of [
        ["transform", { x: 20 }],
        ["adjust", { brightness: 20 }],
        ["set_text", { content: "Changed" }],
        ["delete_layer", {}],
        ["add_mask", {}],
        ["remove_background", {}],
      ]) {
        await assert.rejects(
          rpc(action, args),
          /锁定|locked/i,
          `${action} must reject a locked layer`,
        );
      }
      assert.deepEqual(stable(await rpc("get_state")), stable(before));
      await rpc("set_layer", { locked: false });
    },
  );

  await check("new document clears mask editing state", async () => {
    await newDoc("Mask source");
    await rpc("add_mask");
    await newDoc("New after mask");
    const state = await rpc("fill", { color: "#0033ff" });
    assert.equal(active(state).mask, false);
    assert.deepEqual((await png()).pixel(2, 2), [0, 51, 255, 255]);
  });

  await check("AI pixel and mask targets are explicit and independent of UI editing state", async () => {
    const created = await newDoc("Explicit mask target");
    await assert.rejects(rpc("paint", { target: "mask", erase: true, size: 10, points: [{ x: 20, y: 20 }] }), /蒙版/);
    await rpc("fill", { color: "#ff0000" });
    await rpc("add_mask");
    const painted = await rpc("paint", { layerId: created.activeLayerId, target: "mask", erase: true, size: 10, points: [{ x: 20, y: 20 }] });
    assert.equal(painted.editingTarget, "mask");
    assert.equal(active(painted).mask, true);
    assert.equal((await png()).pixel(20, 20)[3], 0);
    assert.deepEqual((await png()).pixel(2, 2), [255, 0, 0, 255]);
    const filled = await rpc("fill", { color: "#0000ff" });
    assert.equal(filled.editingTarget, "pixels");
    assert.equal(active(filled).mask, true);
    assert.deepEqual((await png()).pixel(2, 2), [0, 0, 255, 255]);
    assert.equal((await png()).pixel(20, 20)[3], 0);
    await rpc("set_layer", { maskEnabled: false });
    assert.deepEqual((await png()).pixel(20, 20), [0, 0, 255, 255]);
    await assert.rejects(rpc("filter", { target: "unknown", kind: "noise", amount: 10 }), /target/);
  });

  await check(
    "rasterizing a hidden layer preserves its recoverable content",
    async () => {
      await newDoc("Hidden rasterization");
      await rpc("add_shape", {
        kind: "rectangle",
        x: 2,
        y: 2,
        width: 20,
        height: 20,
        color: "#ff0000",
      });
      await rpc("set_layer", { visible: false });
      const before = await rpc("get_state");
      try {
        await rpc("rasterize");
      } catch {
        assert.deepEqual(stable(await rpc("get_state")), stable(before));
      }
      await rpc("set_layer", { visible: true });
      assert.deepEqual((await png()).pixel(5, 5), [255, 0, 0, 255]);
    },
  );

  await check(
    "feathered selection filtering does not punch alpha holes",
    async () => {
      await newDoc("Feather filter", "#808080");
      await rpc("select_rect", { x: 12, y: 12, width: 20, height: 20 });
      await rpc("feather_selection", { radius: 3 });
      await rpc("filter", { kind: "noise", amount: 10 });
      const image = await png();
      for (let y = 8; y < 36; y++)
        for (let x = 8; x < 36; x++)
          assert.equal(
            image.pixel(x, y)[3],
            255,
            `selection filtering lost alpha at ${x},${y}`,
          );
    },
  );

  await check("PNG roundtrip retains dimensions and pixels", async () => {
    await newDoc("PNG export", "#123456");
    const exported = await rpc("export", { format: "png" });
    const state = await rpc("open_image", {
      name: "image.png",
      base64: exported.base64,
    });
    assert.equal(state.document.width, 64);
    assert.equal(state.document.height, 48);
    assert.deepEqual((await png()).pixel(4, 4), [18, 52, 86, 255]);
  });

  await check(
    "place_image adds a layer to the current document and preserves source pixels",
    async () => {
      await newDoc("Place source", "#00aa55");
      const source = await rpc("export", { format: "png" });
      const target = await newDoc("Place destination");
      const placed = await rpc("place_image", {
        name: "placed.png",
        base64: source.base64,
        x: 10,
        y: 6,
        scaleToFit: true,
      });
      assert.equal(placed.document.id, target.document.id);
      assert.equal(
        placed.document.layers.length,
        target.document.layers.length + 1,
      );
      assert.equal(active(placed).name, "placed.png");
      assert.equal(active(placed).x, 10);
      assert.equal(active(placed).y, 6);
      assert.deepEqual((await png()).pixel(12, 8), [0, 170, 85, 255]);
      assert.equal((await png()).pixel(2, 2)[3], 0);
      await rpc("undo");
      assert.equal(
        (await rpc("get_state")).document.layers.length,
        target.document.layers.length,
      );
    },
  );

  await check(
    "extreme dimensions, unsupported blend and invalid transforms fail without mutation",
    async () => {
      const before = await newDoc("Validation");
      for (const [action, args] of [
        ["add_shape", { width: 20000, height: 20000 }],
        ["add_text", { text: "Too large", fontSize: 1e8 }],
        ["transform", { scaleX: 0 }],
        ["transform", { scaleY: 1e12 }],
        ["set_layer", { blendMode: "not-supported" }],
      ])
        await assert.rejects(rpc(action, args));
      assert.deepEqual(stable(await rpc("get_state")), stable(before));
    },
  );

  await check("duplicate groups receive unique descendant IDs", async () => {
    await newDoc("Group duplicate");
    await rpc("add_shape", {
      kind: "rectangle",
      width: 12,
      height: 12,
      color: "#ff0000",
    });
    await rpc("group");
    const state = await rpc("duplicate_layer");
    const ids = [];
    const visit = (layers) =>
      layers.forEach((layer) => {
        ids.push(layer.id);
        if (layer.children) visit(layer.children);
      });
    visit(state.document.layers);
    assert.equal(new Set(ids).size, ids.length);
  });
} catch (error) {
  results.push({
    name: "Integration setup/runtime",
    passed: false,
    error: String(error.stack || error),
  });
  console.error(error);
} finally {
  if (child && child.exitCode === null) {
    // This process owns the isolated test instance. Do not terminate any existing instance.
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(5000),
    ]);
  }
  const report = {
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    results,
    artifacts: scratch,
  };
  await fs.writeFile(
    path.join(scratch, "results.json"),
    JSON.stringify(report, null, 2),
  );
  if (logs) await fs.writeFile(path.join(scratch, "electron.log"), logs);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.failed ? 1 : 0;
}
