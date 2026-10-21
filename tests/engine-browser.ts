import {
  applyFilter,
  cloneDocument,
  combineMasks,
  createCanvas,
  defaultAdjustments,
  featherMask,
  findLayer,
  flattenLayers,
  floodMask,
  layerBounds,
  layerMatrix,
  makeDocument,
  makeLayer,
  removeLayer,
  renderDocument,
  renderLayer,
  selectionBounds,
  sourceCanvas,
} from "../src/engine";

/** Run in a real Chromium document via Vite; Canvas alpha/compositing cannot be checked in a DOM mock. */
export function runEngineTests(): string[] {
  const passed: string[] = [];
  const assert = (value: unknown, message: string) => {
    if (!value) throw new Error(message);
  };
  const near = (a: number, b: number, tolerance = 2) =>
    Math.abs(a - b) <= tolerance;
  const solid = (color: string, w = 4, h = 4) => {
    const c = createCanvas(w, h),
      ctx = c.getContext("2d")!;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    return c;
  };
  const pixel = (canvas: HTMLCanvasElement, x = 0, y = 0) =>
    Array.from(canvas.getContext("2d")!.getImageData(x, y, 1, 1).data);
  const test = (name: string, fn: () => void) => {
    fn();
    passed.push(name);
  };

  test("Layer opacity belongs to composition, not renderLayer", () => {
    const layer = makeLayer("red", solid("#ff0000"));
    layer.opacity = 0.5;
    assert(
      pixel(renderLayer(layer, 4, 4))[3] === 255,
      "renderLayer prematurely applies opacity",
    );
    const doc = makeDocument("test", 4, 4);
    doc.layers = [layer];
    assert(
      near(pixel(renderDocument(doc))[3], 128),
      "document opacity incorrect",
    );
  });
  test("Bottom-to-top ordering and native blend", () => {
    const doc = makeDocument("test", 4, 4),
      base = makeLayer("base", solid("#ff0000")),
      top = makeLayer("top", solid("#0000ff"));
    doc.layers = [base, top];
    assert(pixel(renderDocument(doc))[2] === 255, "last layer must be on top");
    top.blendMode = "multiply";
    assert(
      pixel(renderDocument(doc))[0] === 0 &&
        pixel(renderDocument(doc))[2] === 0,
      "multiply incorrect",
    );
  });
  test("Masks use alpha rather than RGB and may be disabled", () => {
    const layer = makeLayer("masked", solid("#ff0000"));
    layer.mask = createCanvas(4, 4);
    const ctx = layer.mask.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(1, 1, 2, 2);
    assert(
      pixel(renderLayer(layer, 4, 4), 0, 0)[3] === 0,
      "transparent mask must hide",
    );
    assert(
      pixel(renderLayer(layer, 4, 4), 1, 1)[3] === 255,
      "opaque black mask must retain alpha",
    );
    layer.maskEnabled = false;
    assert(
      pixel(renderLayer(layer, 4, 4))[3] === 255,
      "disabled mask still applied",
    );
  });
  test("Centre rotation and scaled bounds", () => {
    const layer = makeLayer("transform", solid("#fff", 2, 4));
    layer.x = 10;
    layer.y = 20;
    layer.rotation = 90;
    const bounds = layerBounds(layer),
      centre = layerMatrix(layer).transformPoint(new DOMPoint(1, 2));
    assert(
      near(bounds.x, 9, 0.001) &&
        near(bounds.y, 21, 0.001) &&
        near(bounds.width, 4, 0.001) &&
        near(bounds.height, 2, 0.001),
      "rotated bounds incorrect",
    );
    assert(
      near(centre.x, 11, 0.001) && near(centre.y, 22, 0.001),
      "rotation moved layer centre",
    );
    layer.rotation = 0;
    layer.scaleX = -2;
    assert(
      near(layerBounds(layer).width, 4, 0.001),
      "negative scale bounds incorrect",
    );
  });
  test("Clipping uses underlying non-clipped alpha", () => {
    const doc = makeDocument("clip", 4, 4),
      base = makeLayer("base", solid("#f00", 2, 2)),
      clip = makeLayer("clip", solid("#00f"));
    base.x = base.y = 1;
    clip.clip = true;
    doc.layers = [base, clip];
    const rendered = renderDocument(doc);
    assert(pixel(rendered)[3] === 0, "clip leaked outside base");
    assert(pixel(rendered, 1, 1)[2] === 255, "clip missing inside base");
    base.visible = false;
    assert(
      !selectionBounds(renderDocument(doc)),
      "hidden clipping base should hide clipped layers",
    );
  });
  test("Group opacity applies after isolated child composition", () => {
    const doc = makeDocument("group", 4, 4),
      group = makeLayer("group", createCanvas(4, 4), "group");
    group.children = [
      makeLayer("red", solid("#f00")),
      makeLayer("blue", solid("#00f")),
    ];
    group.opacity = 0.5;
    doc.layers = [group];
    const p = pixel(renderDocument(doc));
    assert(
      p[2] === 255 && p[0] === 0 && near(p[3], 128),
      "group opacity must apply once",
    );
  });
  test("Adjustment layers preserve semi-transparent alpha", () => {
    const doc = makeDocument("adjustment", 4, 4),
      base = makeLayer("base", solid("#ff000080")),
      adjustment = makeLayer("invert", createCanvas(4, 4), "adjustment");
    adjustment.adjustments.invert = true;
    doc.layers = [base, adjustment];
    const p = pixel(renderDocument(doc));
    assert(
      p[0] === 0 && p[1] === 255 && p[2] === 255 && near(p[3], 128),
      "adjustment changed alpha or failed to invert",
    );
  });
  test("Layer adjustments preserve source pixels", () => {
    const layer = makeLayer("adjust", solid("#804020"));
    layer.adjustments = {
      ...defaultAdjustments(),
      grayscale: true,
      exposure: 1,
    };
    const p = pixel(renderLayer(layer, 4, 4));
    assert(p[0] === p[1] && p[1] === p[2], "grayscale failed");
    assert(
      pixel(sourceCanvas(layer))[0] === 128 &&
        pixel(sourceCanvas(layer))[1] === 64,
      "adjustments mutated raster source",
    );
  });
  test("Additional blend modes use source-over alpha math", () => {
    const doc = makeDocument("blend", 4, 4),
      base = makeLayer("base", solid("rgb(100,100,100)")),
      top = makeLayer("top", solid("rgb(200,200,200)"));
    top.blendMode = "linear-burn";
    doc.layers = [base, top];
    assert(
      near(pixel(renderDocument(doc))[0], 45),
      "linear burn formula incorrect",
    );
    const modes = [
      "normal",
      "dissolve",
      "darken",
      "multiply",
      "color-burn",
      "linear-burn",
      "darker-color",
      "lighten",
      "screen",
      "color-dodge",
      "linear-dodge",
      "lighter-color",
      "overlay",
      "soft-light",
      "hard-light",
      "vivid-light",
      "linear-light",
      "pin-light",
      "hard-mix",
      "difference",
      "exclusion",
      "subtract",
      "divide",
      "hue",
      "saturation",
      "color",
      "luminosity",
    ];
    for (const mode of modes) {
      top.blendMode = mode;
      assert(pixel(renderDocument(doc))[3] === 255, `${mode} corrupted alpha`);
    }
  });
  test("Flood selection distinguishes connectivity and tolerance", () => {
    const source = solid("#ff0000", 5, 3),
      ctx = source.getContext("2d")!;
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(2, 0, 1, 3);
    const contiguous = floodMask(source, 0, 0, 0),
      global = floodMask(source, 0, 0, 0, false);
    assert(
      selectionBounds(contiguous)?.width === 2,
      "contiguous flood crossed barrier",
    );
    assert(
      selectionBounds(global)?.width === 5 && pixel(global, 2, 1)[3] === 0,
      "global flood incorrect",
    );
    assert(
      selectionBounds(floodMask(source, -1, 0, 10)) === null,
      "off-canvas flood should be empty",
    );
    assert(
      selectionBounds(floodMask(source, 0, 0, 255))?.width === 5,
      "maximum tolerance failed",
    );
  });
  test("Mask boolean operations and feather", () => {
    const a = solid("#fff", 4, 4),
      b = createCanvas(4, 4);
    b.getContext("2d")!.fillRect(1, 1, 2, 2);
    assert(
      selectionBounds(combineMasks(a, b, "intersect"))?.width === 2,
      "mask intersection failed",
    );
    assert(
      pixel(combineMasks(a, b, "subtract"), 1, 1)[3] === 0,
      "mask subtraction failed",
    );
    assert(
      selectionBounds(combineMasks(a, b, "add"))?.width === 4,
      "mask union failed",
    );
    const feather = featherMask(b, 1);
    assert(
      pixel(feather, 0, 0)[3] > 0 && pixel(feather, 1, 1)[3] < 255,
      "feather did not soften",
    );
  });
  test("All filters preserve dimensions and source", () => {
    const source = solid("#808080", 8, 8);
    source.getContext("2d")!.clearRect(0, 0, 1, 1);
    for (const filter of [
      "gaussian",
      "motion",
      "sharpen",
      "noise",
      "pixelate",
      "emboss",
      "edges",
      "vignette",
      "bloom",
    ]) {
      const result = applyFilter(source, filter, 3);
      assert(
        result.width === 8 && result.height === 8 && result !== source,
        `${filter} canvas invalid`,
      );
    }
    assert(
      pixel(source)[3] === 0 && pixel(source, 1, 1)[0] === 128,
      "filter modified source",
    );
    assert(
      near(pixel(applyFilter(solid("#80808080"), "bloom", 50))[3], 128),
      "bloom changed semi-transparent alpha",
    );
    let rejected = false;
    try {
      applyFilter(source, "not-a-filter", 10);
    } catch {
      rejected = true;
    }
    assert(rejected, "unknown filter silently succeeded");
  });
  test("History snapshots own independent pixels and nested metadata", () => {
    const doc = makeDocument("history", 4, 4),
      group = makeLayer("group", createCanvas(4, 4), "group"),
      child = makeLayer("child", solid("#ff0000"));
    group.children = [child];
    doc.layers = [group];
    const copy = cloneDocument(doc),
      copyChild = findLayer(copy.layers, child.id)!;
    copyChild.canvas!.getContext("2d")!.clearRect(0, 0, 4, 4);
    copyChild.adjustments.brightness = 100;
    assert(
      pixel(child.canvas!)[3] === 255 && child.adjustments.brightness === 0,
      "snapshot aliases source",
    );
    assert(
      flattenLayers(doc.layers).length === 2 &&
        removeLayer(copy.layers, child.id)?.id === child.id,
      "nested layer helpers failed",
    );
    assert(
      findLayer(doc.layers, child.id) === child &&
        !findLayer(copy.layers, child.id),
      "removal mutated original",
    );
  });
  test("Render target reuse clears stale image data", () => {
    const doc = makeDocument("reuse", 4, 4);
    doc.layers = [makeLayer("red", solid("#f00"))];
    const target = renderDocument(doc);
    doc.layers = [];
    assert(
      renderDocument(doc, target) === target && pixel(target)[3] === 0,
      "target was not cleared",
    );
  });
  test("Editable shapes and text rasterize without modifying specifications", () => {
    const shape = makeLayer("ellipse", createCanvas(32, 32), "shape");
    shape.shape!.kind = "ellipse";
    assert(
      pixel(sourceCanvas(shape), 16, 16)[3] === 255 &&
        pixel(sourceCanvas(shape))[3] === 0,
      "ellipse rasterization failed",
    );
    const text = makeLayer("text", createCanvas(128, 64), "text");
    text.text!.fontSize = 24;
    text.text!.content = "Hello";
    assert(
      selectionBounds(sourceCanvas(text)) !== null &&
        text.type === "text" &&
        text.text.content === "Hello",
      "text rasterization failed",
    );
  });
  return passed;
}
