import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  createDispatcher,
  executeTool,
  TOOLS,
  EDIT_ACTIONS,
} from "../scripts/mcp-server.mjs";
import {
  readDiscovery,
  openImage,
  writeOutput,
  exportImage,
  renameWithRetry,
} from "../scripts/client.mjs";

const scratch = path.resolve("work", "mcp-tests");
await fs.mkdir(scratch, { recursive: true });

test("CLI export rename retries only transient locks with a fixed upper bound", async () => {
  let attempts = 0;
  const delays = [];
  await renameWithRetry("source", "destination", {
    rename: async () => { if (++attempts <= 5) throw Object.assign(new Error("locked"), { code: "EPERM" }); },
    sleep: async milliseconds => { delays.push(milliseconds); },
  });
  assert.equal(attempts, 6);
  assert.deepEqual(delays, [20, 50, 100, 200, 400]);
  attempts = 0;
  await assert.rejects(renameWithRetry("source", "destination", {
    rename: async () => { attempts++; throw Object.assign(new Error("Disk full"), { code: "ENOSPC" }); },
    sleep: async () => { throw new Error("Must not retry permanent errors"); },
  }), error => error.code === "ENOSPC");
  assert.equal(attempts, 1);
});

test("CLI atomic export retries a transient rename without removing the old output", async t => {
  const root = await fs.mkdtemp(path.join(scratch, "rename-export-"));
  const filename = path.join(root, "output.png");
  const originalRename = fs.rename;
  let renameMock;
  try {
    await fs.writeFile(filename, "old");
    let remainingLocks = 2;
    renameMock = t.mock.method(fs, "rename", async (source, destination) => {
      if (destination === filename && remainingLocks-- > 0) {
        assert.equal(await fs.readFile(filename, "utf8"), "old");
        throw Object.assign(new Error("Scanner lock"), { code: "EACCES" });
      }
      return originalRename(source, destination);
    });
    await writeOutput(filename, Buffer.from("new"));
    assert.equal(await fs.readFile(filename, "utf8"), "new");
    assert.deepEqual(await fs.readdir(root), ["output.png"]);
  } finally {
    renameMock?.mock.restore();
    if (!root.startsWith(scratch + path.sep)) throw new Error("Unexpected temporary path");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MCP initialize negotiates protocol and exposes five accurate tool schemas", async () => {
  const dispatch = createDispatcher();
  const init = await dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(
    await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" }),
    null,
  );
  const list = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(list.result.tools.length, 5);
  for (const tool of TOOLS) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.description);
  }
  assert.ok(EDIT_ACTIONS.includes("batch"));
  assert.ok(!EDIT_ACTIONS.includes("eval"));
  assert.ok(!EDIT_ACTIONS.includes("export"));
  assert.equal(
    (await dispatch({ jsonrpc: "2.0", id: 3, method: "ping" })).result
      .constructor,
    Object,
  );
  assert.equal(
    (await dispatch({ jsonrpc: "2.0", id: 4, method: "server/discover" })).error
      .code,
    -32601,
  );
});

test("MCP edit whitelist matches implemented editor automation commands", async () => {
  const source = await fs.readFile(path.resolve("src/editor.ts"), "utf8");
  const section = source.slice(source.indexOf("async automate("));
  const actual = new Set(
    [...section.matchAll(/case\s+(['"])([a-z_]+)\1/g)].map((match) => match[2]),
  );
  actual.add("batch");
  if (/action\s*===\s*(['"])place_image\1/.test(section)) actual.add("place_image");
  assert.deepEqual([...EDIT_ACTIONS].sort(), [...actual].sort());
});

test("MCP calls return images and structured errors without requiring a desktop app", async () => {
  const calls = [];
  const fake = async (action, args) => {
    calls.push({ action, args });
    return action === "get_canvas"
      ? { base64: "aGVsbG8=", mimeType: "image/png", width: 2, height: 1 }
      : { ok: true };
  };
  const image = await executeTool(
    "compositor_get_canvas",
    { maxSize: 256 },
    fake,
  );
  assert.equal(image.content[0].type, "image");
  assert.equal(image.content[0].mimeType, "image/png");
  assert.deepEqual(calls[0], { action: "get_canvas", args: { maxSize: 256 } });
  const edit = await executeTool(
    "compositor_edit",
    { action: "adjust", args: { brightness: 12 } },
    fake,
  );
  assert.equal(edit.isError, undefined);
  for (const [name, args] of [
    ["compositor_edit", { action: "eval", args: {} }],
    ["compositor_edit", { action: "adjust", args: [] }],
    ["compositor_get_canvas", { maxSize: 9000 }],
    ["compositor_get_state", { unexpected: true }],
    ["missing", {}],
  ])
    assert.equal((await executeTool(name, args, fake)).isError, true);
});

test("missing local files and app discovery provide helpful errors", async () => {
  const missing = path.join(scratch, "missing-file-that-does-not-exist.png");
  await assert.rejects(openImage(missing), /图片文件不存在/);
  await assert.rejects(
    readDiscovery(path.join(scratch, "missing-discovery.json")),
    /请先启动桌面应用/,
  );
  const result = await executeTool(
    "compositor_open_image",
    { path: missing },
    () => {
      throw new Error("Should not call app");
    },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /图片文件不存在/);
});

test("local export writes replacement atomically and rejects a directory target", async () => {
  const root = await fs.mkdtemp(path.join(scratch, "export-"));
  try {
    const filename = path.join(root, "out.png");
    await writeOutput(filename, Buffer.from("old"));
    const result = await exportImage(filename, "png", async () => ({
      format: "png",
      base64: Buffer.from("new").toString("base64"),
    }));
    assert.equal(result.path, filename);
    assert.equal(await fs.readFile(filename, "utf8"), "new");
    assert.deepEqual(await fs.readdir(root), ["out.png"]);
    await assert.rejects(writeOutput(root, Buffer.from("bad")), /输出路径必须/);
  } finally {
    if (!root.startsWith(scratch + path.sep))
      throw new Error("Unexpected temporary path");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MCP opens normally or places an image into the current document for compositing", async () => {
  const root = await fs.mkdtemp(path.join(scratch, "place-"));
  try {
    const filename = path.join(root, "sample.png");
    await fs.writeFile(filename, Buffer.from("sample-image"));
    const calls = [];
    const fake = async (action, args) => {
      calls.push({ action, args });
      return { ok: true };
    };
    assert.equal(
      (await executeTool("compositor_open_image", { path: filename }, fake))
        .isError,
      undefined,
    );
    assert.equal(calls[0].action, "open_image");
    assert.equal(
      (
        await executeTool(
          "compositor_open_image",
          { path: filename, asLayer: true, x: 20, y: 35 },
          fake,
        )
      ).isError,
      undefined,
    );
    assert.deepEqual(calls[1], {
      action: "place_image",
      args: {
        name: "sample.png",
        base64: Buffer.from("sample-image").toString("base64"),
        x: 20,
        y: 35,
        scaleToFit: true,
      },
    });
    assert.equal(
      (
        await executeTool(
          "compositor_open_image",
          { path: filename, x: 20 },
          fake,
        )
      ).isError,
      true,
    );
    assert.equal(
      (
        await executeTool(
          "compositor_open_image",
          { path: filename, asLayer: "yes" },
          fake,
        )
      ).isError,
      true,
    );
  } finally {
    if (!root.startsWith(scratch + path.sep))
      throw new Error("Unexpected temporary path");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stdio handles newline-delimited messages and keeps stdout protocol-only", async () => {
  const processResult = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/mcp-server.mjs"], {
      cwd: path.resolve("."),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        "{invalid",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "compositor_edit", arguments: { action: "eval" } },
        }),
      ].join("\n") + "\n",
    );
  });
  assert.equal(processResult.code, 0);
  assert.equal(processResult.stderr, "");
  const messages = processResult.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(messages.length, 4);
  assert.equal(messages[1].result.tools.length, 5);
  assert.equal(messages[2].error.code, -32700);
  assert.equal(messages[3].result.isError, true);
});
