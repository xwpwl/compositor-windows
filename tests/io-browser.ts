import { zipSync } from "fflate";
import { readPsd } from "ag-psd";
import {
  makeDocument,
  makeLayer,
  createCanvas,
  renderDocument,
} from "../src/engine";
import {
  decodeProject,
  encodeProject,
  exportComp,
  exportPSD,
  getPSDExportWarnings,
  importComp,
  importFile,
} from "../src/io";
import { boundedZip, grayscalePNG, pngInfo, text, utf8 } from "../src/io-codec";

export async function runIOTests(): Promise<string[]> {
  const passed: string[] = [];
  const assert = (v: unknown, m: string) => {
    if (!v) throw new Error(m);
  };
  const solid = (value: string, w = 8, h = 8) => {
    const c = createCanvas(w, h),
      ctx = c.getContext("2d")!;
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, w, h);
    return c;
  };
  const pixel = (c: HTMLCanvasElement, x = 0, y = 0) =>
    Array.from(c.getContext("2d")!.getImageData(x, y, 1, 1).data);
  const test = async (name: string, fn: () => Promise<void> | void) => {
    await fn();
    passed.push(name);
  };
  const rejects = async (
    fn: () => unknown | Promise<unknown>,
    label: string,
  ) => {
    let rejected = false;
    try {
      await fn();
    } catch {
      rejected = true;
    }
    assert(rejected, label);
  };

  await test("Native archive preserves text, shape, groups, masks, adjustments, and hidden state", async () => {
    const doc = makeDocument("中文工程", 8, 8),
      raster = makeLayer("pixels", solid("#f00")),
      group = makeLayer("group", undefined, "group"),
      type = makeLayer("editable type", undefined, "text"),
      shape = makeLayer("shape", undefined, "shape"),
      adjustment = makeLayer("grade", undefined, "adjustment");
    raster.mask = solid("#0008");
    raster.opacity = 0.7;
    raster.scaleX = -1;
    raster.x = 8;
    raster.visible = false;
    type.text!.content = "你好 🖼";
    type.text!.fontSize = 22;
    shape.shape!.radius = 12;
    adjustment.adjustments.exposure = 1.25;
    group.children = [raster, type, shape];
    group.width = group.height = 8;
    doc.layers = [group, adjustment];
    doc.activeId = type.id;
    const bytes = await encodeProject(doc),
      out = await decodeProject(bytes);
    assert(
      out.name === "中文工程" && out.activeId === type.id,
      "document metadata lost",
    );
    assert(
      out.layers[0].children![1].text?.content === "你好 🖼",
      "editable text lost",
    );
    assert(
      out.layers[0].children![2].shape?.radius === 12,
      "shape metadata lost",
    );
    assert(out.layers[1].adjustments.exposure === 1.25, "adjustment lost");
    const restored = out.layers[0].children![0];
    assert(
      !restored.visible && restored.scaleX === -1 && restored.opacity === 0.7,
      "layer state lost",
    );
    assert(pixel(restored.mask!)[3] === 136, "mask alpha lost");
  });
  await test("True grayscale PNG mask has no alpha and original .comp roundtrip retains coverage", async () => {
    const doc = makeDocument("mask", 8, 8),
      layer = makeLayer("red", solid("#f00"));
    layer.mask = createCanvas(8, 8);
    layer.mask.getContext("2d")!.fillRect(2, 2, 3, 3);
    doc.layers = [layer];
    doc.activeId = layer.id;
    const g = grayscalePNG(layer.mask);
    assert(
      pngInfo(g)?.color === 0 && pngInfo(g)?.depth === 8,
      "mask PNG is not grayscale",
    );
    const result = await exportComp(doc),
      manifest = JSON.parse(text(result.files["manifest.json"]));
    assert(
      manifest.version === 15 &&
        manifest.layers[0].imageFile === `${layer.id.toUpperCase()}.png`,
      "invalid original filename",
    );
    const out = await importComp(result.files, "mask.comp"),
      rendered = renderDocument(out.document);
    assert(
      pixel(rendered)[3] === 0 &&
        pixel(rendered, 3, 3)[0] === 255 &&
        pixel(rendered, 3, 3)[3] === 255,
      "mask roundtrip wrong",
    );
  });
  await test("Original .comp retains negative flips, groups, visibility and blend order", async () => {
    const doc = makeDocument("geometry", 8, 8),
      group = makeLayer("folder", undefined, "group"),
      layer = makeLayer("red", solid("#f00", 2, 4));
    group.width = group.height = 8;
    layer.x = 5;
    layer.y = 2;
    layer.scaleX = -2;
    layer.rotation = 90;
    layer.blendMode = "multiply";
    layer.opacity = 0.6;
    group.children = [layer];
    doc.layers = [group];
    const exported = await exportComp(doc),
      imported = await importComp(exported.files),
      restored = imported.document.layers[0].children![0];
    assert(
      restored.x === 5 &&
        restored.y === 2 &&
        restored.scaleX === -2 &&
        restored.rotation === 90 &&
        restored.blendMode === "multiply" &&
        restored.opacity === 0.6,
      "transforms changed",
    );
  });
  await test("PSD roundtrip preserves stack, groups, alpha masks, opacity and blend", async () => {
    const doc = makeDocument("PSD test", 8, 8),
      bg = makeLayer("bottom", solid("#f00")),
      group = makeLayer("folder", undefined, "group"),
      top = makeLayer("top", solid("#00f"));
    group.width = group.height = 8;
    top.mask = solid("#0008");
    top.opacity = 0.5;
    top.blendMode = "screen";
    group.children = [top];
    doc.layers = [bg, group];
    const bytes = await exportPSD(doc),
      raw = readPsd(bytes),
      imported = await importFile({ name: "roundtrip.psd", bytes });
    assert(
      raw.children![0].name === "folder" && raw.children![1].name === "bottom",
      "PSD layer order reversed",
    );
    assert(
      imported.document.layers[0].name === "bottom" &&
        imported.document.layers[1].children![0].name === "top",
      "import order reversed",
    );
    const layer = imported.document.layers[1].children![0];
    assert(
      Math.abs(layer.opacity - 0.5) < 0.005 && layer.blendMode === "screen",
      "PSD appearance metadata lost",
    );
    assert(Math.abs(pixel(layer.mask!)[3] - 136) < 2, "PSD mask coverage lost");
  });
  await test("PSD and .comp adjustment flattening emits clear compatibility warnings", async () => {
    const doc = makeDocument("adjusted", 8, 8),
      layer = makeLayer("red", solid("#f00")),
      adjustment = makeLayer("inversion", undefined, "adjustment");
    adjustment.adjustments.invert = true;
    adjustment.width = adjustment.height = 8;
    doc.layers = [layer, adjustment];
    assert(
      getPSDExportWarnings(doc).length > 0,
      "PSD destructive conversion not reported",
    );
    const psd = readPsd(await exportPSD(doc));
    assert(
      psd.children?.length === 1 && pixel(psd.canvas!)[1] > 250,
      "adjustment appearance not retained",
    );
    const comp = await exportComp(doc);
    assert(
      comp.warnings.length > 0 &&
        JSON.parse(text(comp.files["manifest.json"])).layers.length === 1,
      "comp flatten not reported",
    );
  });
  await test("ZIP and project validators reject unsafe paths, wrong format and missing images", async () => {
    await rejects(
      () => boundedZip(zipSync({ "../escape": utf8.encode("bad") })),
      "ZIP traversal accepted",
    );
    await rejects(
      () =>
        decodeProject(
          zipSync({ "manifest.json": utf8.encode('{"format":"unknown"}') }),
        ),
      "wrong format accepted",
    );
    const doc = makeDocument("bad", 8, 8),
      layer = makeLayer("red", solid("#f00"));
    doc.layers = [layer];
    const comp = await exportComp(doc);
    delete comp.files[`images/${layer.id.toUpperCase()}.png`];
    await rejects(() => importComp(comp.files), "missing image accepted");
  });
  await test("Original text fallback and unsupported adjustments produce warnings", async () => {
    const doc = makeDocument("text", 8, 8),
      layer = makeLayer("type", undefined, "text");
    layer.width = layer.height = 8;
    layer.text!.content = "A";
    layer.text!.fontSize = 6;
    doc.layers = [layer];
    const comp = await exportComp(doc),
      imported = await importComp(comp.files);
    assert(
      imported.warnings.some((w) => w.includes("文字排版")),
      "text raster fallback not reported",
    );
    const manifest = JSON.parse(text(comp.files["manifest.json"]));
    delete manifest.layers[0].imageFile;
    delete manifest.layers[0].text;
    manifest.layers[0].adjustment = { kind: "Curves" };
    comp.files["manifest.json"] = utf8.encode(JSON.stringify(manifest));
    const result = await importComp(comp.files);
    assert(
      result.warnings.some((w) => w.includes("Curves")),
      "unsupported curves not reported",
    );
  });
  return passed;
}
