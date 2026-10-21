import type {
  Adjustments,
  EditorDocument,
  Layer,
  LayerEffects,
  Rect,
} from "./types";

const clamp = (v: number, min = 0, max = 255): number =>
  Math.max(min, Math.min(max, Number.isFinite(v) ? v : min));
const uid = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `layer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const context = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D rendering is unavailable.");
  return ctx;
};

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(clamp(width, 1, 32767));
  canvas.height = Math.round(clamp(height, 1, 32767));
  return canvas;
}

export function cloneCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const copy = createCanvas(canvas.width, canvas.height);
  context(copy).drawImage(canvas, 0, 0);
  return copy;
}

export function defaultAdjustments(): Adjustments {
  return {
    brightness: 0,
    contrast: 0,
    saturation: 0,
    hue: 0,
    exposure: 0,
    temperature: 0,
    tint: 0,
    shadows: 0,
    highlights: 0,
    blur: 0,
    grayscale: false,
    invert: false,
    sepia: 0,
    gamma: 1,
    blackPoint: 0,
    whitePoint: 255,
  };
}

export function defaultEffects(): LayerEffects {
  return {
    shadow: false,
    shadowColor: "#00000080",
    shadowBlur: 12,
    shadowX: 5,
    shadowY: 5,
    stroke: false,
    strokeColor: "#ffffff",
    strokeWidth: 2,
  };
}

export function makeLayer(
  name: string,
  canvas?: HTMLCanvasElement,
  type: Layer["type"] = "raster",
): Layer {
  const layer: Layer = {
    id: uid(),
    name,
    type,
    width: canvas?.width ?? 512,
    height: canvas?.height ?? 512,
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: "normal",
    clip: false,
    maskEnabled: true,
    adjustments: defaultAdjustments(),
    effects: defaultEffects(),
  };
  if (type === "raster")
    layer.canvas = canvas ?? createCanvas(layer.width, layer.height);
  if (type === "group") layer.children = [];
  if (type === "text")
    layer.text = {
      content: "Text",
      fontFamily: "Arial",
      fontSize: 64,
      fontWeight: "400",
      color: "#ffffff",
      align: "left",
      lineHeight: 1.2,
    };
  if (type === "shape")
    layer.shape = {
      kind: "rectangle",
      fill: "#ffffff",
      stroke: "#000000",
      strokeWidth: 0,
      radius: 0,
    };
  return layer;
}

export function makeDocument(
  name: string,
  width: number,
  height: number,
): EditorDocument {
  return {
    id: uid(),
    name,
    width: Math.round(clamp(width, 1, 32767)),
    height: Math.round(clamp(height, 1, 32767)),
    layers: [],
    activeId: "",
    dirty: false,
  };
}

/** A history snapshot preserves IDs; callers duplicating a layer should assign a new ID. */
export function cloneLayer(layer: Layer): Layer {
  return {
    ...layer,
    canvas: layer.canvas ? cloneCanvas(layer.canvas) : undefined,
    mask: layer.mask ? cloneCanvas(layer.mask) : undefined,
    text: layer.text ? { ...layer.text } : undefined,
    shape: layer.shape ? { ...layer.shape } : undefined,
    adjustments: { ...layer.adjustments },
    effects: { ...layer.effects },
    children: layer.children?.map(cloneLayer),
  };
}

export function cloneDocument(doc: EditorDocument): EditorDocument {
  return { ...doc, layers: doc.layers.map(cloneLayer) };
}

export function findLayer(layers: Layer[], id: string): Layer | undefined {
  for (const layer of layers) {
    if (layer.id === id) return layer;
    const found = layer.children && findLayer(layer.children, id);
    if (found) return found;
  }
  return undefined;
}

/** Bottom-to-top, depth first, including group containers. */
export function flattenLayers(layers: Layer[]): Layer[] {
  const all: Layer[] = [];
  for (const layer of layers) {
    all.push(layer);
    if (layer.children) all.push(...flattenLayers(layer.children));
  }
  return all;
}

/** Removes a layer in place and returns the removed layer, if present. */
export function removeLayer(layers: Layer[], id: string): Layer | undefined {
  const index = layers.findIndex((layer) => layer.id === id);
  if (index >= 0) return layers.splice(index, 1)[0];
  for (const layer of layers) {
    const found = layer.children && removeLayer(layer.children, id);
    if (found) return found;
  }
  return undefined;
}

/** Unadjusted layer-local pixels; text and shapes remain editable in their specifications. */
export function sourceCanvas(layer: Layer): HTMLCanvasElement {
  if (layer.type === "raster" && layer.canvas) return layer.canvas;
  const canvas = createCanvas(layer.width, layer.height);
  const ctx = context(canvas);
  if (layer.type === "group")
    return compositeLayers(
      layer.children ?? [],
      canvas.width,
      canvas.height,
      canvas,
    );
  if (layer.type === "text" && layer.text) {
    const text = layer.text;
    const size = clamp(text.fontSize, 1, 4096);
    ctx.font = `${text.fontWeight || "400"} ${size}px ${text.fontFamily || "sans-serif"}`;
    ctx.fillStyle = text.color;
    ctx.textAlign = text.align;
    ctx.textBaseline = "top";
    const x =
      text.align === "center"
        ? canvas.width / 2
        : text.align === "right" || text.align === "end"
          ? canvas.width
          : 0;
    const step = size * clamp(text.lineHeight, 0.1, 10);
    text.content
      .split(/\r?\n/)
      .forEach((line, index) => ctx.fillText(line, x, index * step));
  } else if (layer.type === "shape" && layer.shape) {
    const shape = layer.shape;
    const lineWidth = clamp(
      shape.strokeWidth,
      0,
      Math.max(canvas.width, canvas.height),
    );
    const inset = lineWidth / 2;
    const w = Math.max(0, canvas.width - lineWidth),
      h = Math.max(0, canvas.height - lineWidth);
    ctx.beginPath();
    if (shape.kind === "ellipse")
      ctx.ellipse(
        canvas.width / 2,
        canvas.height / 2,
        w / 2,
        h / 2,
        0,
        0,
        Math.PI * 2,
      );
    else if (shape.kind === "line") {
      ctx.moveTo(inset, inset);
      ctx.lineTo(canvas.width - inset, canvas.height - inset);
    } else
      ctx.roundRect(
        inset,
        inset,
        w,
        h,
        clamp(shape.radius, 0, Math.min(w, h) / 2),
      );
    if (shape.kind !== "line" && shape.fill && shape.fill !== "none") {
      ctx.fillStyle = shape.fill;
      ctx.fill();
    }
    if (lineWidth > 0 && shape.stroke && shape.stroke !== "none") {
      ctx.lineWidth = lineWidth;
      ctx.lineCap = "round";
      ctx.strokeStyle = shape.stroke;
      ctx.stroke();
    }
  }
  return canvas;
}

/** Scaling is around the local origin; rotation is around the resulting layer centre. */
export function layerMatrix(layer: Layer): DOMMatrix {
  const sx = Number.isFinite(layer.scaleX) ? layer.scaleX : 1;
  const sy = Number.isFinite(layer.scaleY) ? layer.scaleY : 1;
  const cx = (layer.width * sx) / 2,
    cy = (layer.height * sy) / 2;
  return new DOMMatrix()
    .translate(layer.x + cx, layer.y + cy)
    .rotate(layer.rotation || 0)
    .translate(-cx, -cy)
    .scale(sx, sy);
}

export function layerBounds(layer: Layer): Rect {
  const matrix = layerMatrix(layer);
  const points = [
    new DOMPoint(0, 0),
    new DOMPoint(layer.width, 0),
    new DOMPoint(layer.width, layer.height),
    new DOMPoint(0, layer.height),
  ].map((p) => matrix.transformPoint(p));
  const x = Math.min(...points.map((p) => p.x)),
    y = Math.min(...points.map((p) => p.y));
  return {
    x,
    y,
    width: Math.max(...points.map((p) => p.x)) - x,
    height: Math.max(...points.map((p) => p.y)) - y,
  };
}

function adjustCanvas(
  source: HTMLCanvasElement,
  adjustment: Adjustments,
): HTMLCanvasElement {
  const a = { ...defaultAdjustments(), ...adjustment };
  const changed =
    a.brightness ||
    a.contrast ||
    a.saturation ||
    a.hue ||
    a.exposure ||
    a.temperature ||
    a.tint ||
    a.shadows ||
    a.highlights ||
    a.grayscale ||
    a.invert ||
    a.sepia ||
    a.gamma !== 1 ||
    a.blackPoint ||
    a.whitePoint !== 255;
  let canvas = source;
  if (changed) {
    canvas = cloneCanvas(source);
    const ctx = context(canvas),
      pixels = ctx.getImageData(0, 0, canvas.width, canvas.height),
      data = pixels.data;
    const brightness = clamp(a.brightness, -100, 100) * 2.55;
    const contrast = clamp(a.contrast, -100, 100) * 2.54;
    const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
    const saturation = clamp(1 + a.saturation / 100, 0, 5);
    const exposure = Math.pow(2, clamp(a.exposure, -12, 12));
    const gamma = 1 / clamp(a.gamma, 0.05, 10);
    const black = clamp(a.blackPoint, 0, 254),
      white = clamp(a.whitePoint, black + 1, 255),
      range = 255 / (white - black);
    const sepia = clamp(a.sepia / 100, 0, 1);
    const hue = (a.hue * Math.PI) / 180,
      cs = Math.cos(hue),
      sn = Math.sin(hue);
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++)
      lut[i] =
        255 * Math.pow(clamp((i - black) / (white - black), 0, 1), gamma);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      let r = data[i] * exposure,
        g = data[i + 1] * exposure,
        b = data[i + 2] * exposure;
      r =
        contrastFactor * (r - 128) +
        128 +
        brightness +
        a.temperature * 0.5 +
        a.tint * 0.3;
      g =
        contrastFactor * (g - 128) +
        128 +
        brightness +
        a.temperature * 0.08 -
        a.tint * 0.4;
      b =
        contrastFactor * (b - 128) +
        128 +
        brightness -
        a.temperature * 0.5 +
        a.tint * 0.3;
      const light = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
      const shift =
        a.shadows * 1.5 * Math.pow(1 - clamp(light, 0, 1), 2) +
        a.highlights * 1.5 * Math.pow(clamp(light, 0, 1), 2);
      r += shift;
      g += shift;
      b += shift;
      if (a.hue) {
        const nr =
          (0.213 + 0.787 * cs - 0.213 * sn) * r +
          (0.715 - 0.715 * cs - 0.715 * sn) * g +
          (0.072 - 0.072 * cs + 0.928 * sn) * b;
        const ng =
          (0.213 - 0.213 * cs + 0.143 * sn) * r +
          (0.715 + 0.285 * cs + 0.14 * sn) * g +
          (0.072 - 0.072 * cs - 0.283 * sn) * b;
        b =
          (0.213 - 0.213 * cs - 0.787 * sn) * r +
          (0.715 - 0.715 * cs + 0.715 * sn) * g +
          (0.072 + 0.928 * cs + 0.072 * sn) * b;
        r = nr;
        g = ng;
      }
      const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
      r = lum + (r - lum) * saturation;
      g = lum + (g - lum) * saturation;
      b = lum + (b - lum) * saturation;
      if (a.grayscale) r = g = b = r * 0.2126 + g * 0.7152 + b * 0.0722;
      if (sepia) {
        const sr = r * 0.393 + g * 0.769 + b * 0.189,
          sg = r * 0.349 + g * 0.686 + b * 0.168,
          sb = r * 0.272 + g * 0.534 + b * 0.131;
        r += (sr - r) * sepia;
        g += (sg - g) * sepia;
        b += (sb - b) * sepia;
      }
      if (a.gamma !== 1 || black || white !== 255) {
        if (a.gamma === 1) {
          r = (r - black) * range;
          g = (g - black) * range;
          b = (b - black) * range;
        } else {
          r = lut[Math.round(clamp(r))];
          g = lut[Math.round(clamp(g))];
          b = lut[Math.round(clamp(b))];
        }
      }
      if (a.invert) {
        r = 255 - r;
        g = 255 - g;
        b = 255 - b;
      }
      data[i] = clamp(r);
      data[i + 1] = clamp(g);
      data[i + 2] = clamp(b);
    }
    ctx.putImageData(pixels, 0, 0);
  }
  if (a.blur > 0) canvas = applyFilter(canvas, "gaussian", a.blur);
  return canvas;
}

function maskedSource(layer: Layer): HTMLCanvasElement {
  let source = adjustCanvas(sourceCanvas(layer), layer.adjustments);
  if (layer.mask && layer.maskEnabled) {
    source = cloneCanvas(source);
    const ctx = context(source);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(layer.mask, 0, 0, source.width, source.height);
    ctx.globalCompositeOperation = "source-over";
  }
  return source;
}

export function renderLayer(
  layer: Layer,
  docWidth: number,
  docHeight: number,
): HTMLCanvasElement {
  const output = createCanvas(docWidth, docHeight);
  if (!layer.visible || layer.type === "adjustment") return output;
  const source = maskedSource(layer),
    ctx = context(output);
  ctx.setTransform(layerMatrix(layer));
  const effects = layer.effects;
  if (effects?.stroke && effects.strokeWidth > 0) {
    const tint = cloneCanvas(source),
      tintCtx = context(tint);
    tintCtx.globalCompositeOperation = "source-in";
    tintCtx.fillStyle = effects.strokeColor;
    tintCtx.fillRect(0, 0, tint.width, tint.height);
    const radius = clamp(effects.strokeWidth, 0, 256),
      steps = Math.max(12, Math.min(64, Math.ceil(radius * 3)));
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      ctx.drawImage(
        tint,
        Math.cos(angle) * radius,
        Math.sin(angle) * radius,
        layer.width,
        layer.height,
      );
    }
  }
  if (effects?.shadow) {
    ctx.shadowColor = effects.shadowColor;
    ctx.shadowBlur = clamp(effects.shadowBlur, 0, 256);
    ctx.shadowOffsetX = effects.shadowX;
    ctx.shadowOffsetY = effects.shadowY;
  }
  ctx.drawImage(source, 0, 0, layer.width, layer.height);
  return output;
}

const nativeBlends = new Set([
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);
function normalizeBlend(mode: string): string {
  return (mode || "normal")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/_/g, "-")
    .replace(/\(add\)/g, "")
    .replace(/-$/, "");
}

function blendChannel(backdrop: number, source: number, mode: string): number {
  switch (mode) {
    case "linear-burn":
      return Math.max(0, backdrop + source - 1);
    case "linear-dodge":
    case "add":
    case "plus-lighter":
      return Math.min(1, backdrop + source);
    case "subtract":
      return Math.max(0, backdrop - source);
    case "divide":
      return source <= 0 ? 1 : Math.min(1, backdrop / source);
    case "linear-light":
      return clamp(backdrop + 2 * source - 1, 0, 1);
    case "pin-light":
      return source < 0.5
        ? Math.min(backdrop, 2 * source)
        : Math.max(backdrop, 2 * source - 1);
    case "vivid-light":
      return source < 0.5
        ? source <= 0
          ? 0
          : 1 - Math.min(1, (1 - backdrop) / (2 * source))
        : source >= 1
          ? 1
          : Math.min(1, backdrop / (2 * (1 - source)));
    case "hard-mix":
      return backdrop + source < 1 ? 0 : 1;
    default:
      return source;
  }
}

function composite(
  target: HTMLCanvasElement,
  source: HTMLCanvasElement,
  opacity: number,
  mode: string,
): void {
  opacity = clamp(opacity, 0, 1);
  if (!opacity) return;
  const ctx = context(target),
    blend = normalizeBlend(mode);
  if (
    blend === "normal" ||
    blend === "pass-through" ||
    blend === "source-over" ||
    nativeBlends.has(blend)
  ) {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = (
      nativeBlends.has(blend) ? blend : "source-over"
    ) as GlobalCompositeOperation;
    ctx.drawImage(source, 0, 0);
    ctx.restore();
    return;
  }
  const backdrop = ctx.getImageData(0, 0, target.width, target.height),
    front = context(source).getImageData(0, 0, target.width, target.height);
  const b = backdrop.data,
    s = front.data;
  for (let i = 0; i < b.length; i += 4) {
    let sa = (s[i + 3] / 255) * opacity;
    if (!sa) continue;
    if (blend === "dissolve") {
      const index = i >>> 2;
      const random =
        ((Math.imul(index ^ 0x9e3779b9, 0x85ebca6b) ^ (index >>> 7)) >>> 0) /
        4294967296;
      sa = random < sa ? 1 : 0;
      if (!sa) continue;
    }
    const ba = b[i + 3] / 255,
      outA = sa + ba * (1 - sa);
    let pickSource = true;
    if (blend === "darker-color" || blend === "lighter-color") {
      const sl = s[i] * 0.2126 + s[i + 1] * 0.7152 + s[i + 2] * 0.0722;
      const bl = b[i] * 0.2126 + b[i + 1] * 0.7152 + b[i + 2] * 0.0722;
      pickSource = blend === "darker-color" ? sl <= bl : sl >= bl;
    }
    for (let c = 0; c < 3; c++) {
      const bc = b[i + c] / 255,
        sc = s[i + c] / 255;
      const mixed =
        blend === "darker-color" || blend === "lighter-color"
          ? pickSource
            ? sc
            : bc
          : blendChannel(bc, sc, blend);
      b[i + c] =
        (255 * ((1 - sa) * ba * bc + (1 - ba) * sa * sc + sa * ba * mixed)) /
        outA;
    }
    b[i + 3] = outA * 255;
  }
  ctx.putImageData(backdrop, 0, 0);
}

function alphaCopy(
  source: HTMLCanvasElement,
  opacity: number,
): HTMLCanvasElement {
  const output = createCanvas(source.width, source.height),
    ctx = context(output);
  ctx.globalAlpha = clamp(opacity, 0, 1);
  ctx.drawImage(source, 0, 0);
  return output;
}

function compositeLayers(
  layers: Layer[],
  width: number,
  height: number,
  output = createCanvas(width, height),
): HTMLCanvasElement {
  const ctx = context(output);
  let clipBase: HTMLCanvasElement | undefined;
  for (const layer of layers) {
    if (!layer.visible) {
      if (!layer.clip && layer.type !== "adjustment")
        clipBase = createCanvas(width, height);
      continue;
    }
    if (layer.type === "adjustment") {
      const adjusted = adjustCanvas(output, layer.adjustments);
      if (adjusted === output || layer.opacity <= 0) continue;
      let weight: HTMLCanvasElement | undefined;
      if (layer.mask && layer.maskEnabled) {
        weight = createCanvas(width, height);
        const wc = context(weight);
        wc.setTransform(layerMatrix(layer));
        wc.drawImage(layer.mask, 0, 0, layer.width, layer.height);
      }
      if (layer.clip) {
        if (!clipBase) continue;
        if (!weight) weight = cloneCanvas(clipBase);
        else {
          const wc = context(weight);
          wc.resetTransform();
          wc.globalCompositeOperation = "destination-in";
          wc.drawImage(clipBase, 0, 0);
        }
      }
      // Interpolate original and adjusted pixels so transparent edges retain their alpha.
      const original = ctx.getImageData(0, 0, width, height),
        changed = context(adjusted).getImageData(0, 0, width, height);
      const mask = weight
        ? context(weight).getImageData(0, 0, width, height).data
        : undefined;
      const opacity = clamp(layer.opacity, 0, 1);
      for (let i = 0; i < original.data.length; i += 4) {
        const mix = opacity * (mask ? mask[i + 3] / 255 : 1);
        for (let c = 0; c < 4; c++)
          original.data[i + c] +=
            (changed.data[i + c] - original.data[i + c]) * mix;
      }
      ctx.putImageData(original, 0, 0);
      continue;
    }
    const pixels = renderLayer(layer, width, height);
    if (layer.clip) {
      if (!clipBase) continue;
      const pc = context(pixels);
      pc.globalCompositeOperation = "destination-in";
      pc.drawImage(clipBase, 0, 0);
      pc.globalCompositeOperation = "source-over";
    } else clipBase = alphaCopy(pixels, layer.opacity);
    composite(output, pixels, layer.opacity, layer.blendMode);
  }
  return output;
}

export function renderDocument(
  doc: EditorDocument,
  target?: HTMLCanvasElement,
): HTMLCanvasElement {
  const canvas = target ?? createCanvas(doc.width, doc.height);
  if (canvas.width !== doc.width) canvas.width = doc.width;
  if (canvas.height !== doc.height) canvas.height = doc.height;
  const ctx = context(canvas);
  ctx.resetTransform();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  return compositeLayers(doc.layers, canvas.width, canvas.height, canvas);
}

function convolve(
  source: HTMLCanvasElement,
  kernel: number[],
  divisor = 1,
  bias = 0,
): HTMLCanvasElement {
  const output = cloneCanvas(source),
    ctx = context(output),
    input = context(source).getImageData(0, 0, source.width, source.height),
    pixels = ctx.createImageData(source.width, source.height);
  const w = source.width,
    h = source.height,
    d = input.data,
    o = pixels.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let ky = -1; ky <= 1; ky++)
          for (let kx = -1; kx <= 1; kx++)
            sum +=
              d[
                (clamp(y + ky, 0, h - 1) * w + clamp(x + kx, 0, w - 1)) * 4 + c
              ] * kernel[(ky + 1) * 3 + kx + 1];
        o[p + c] = clamp(sum / divisor + bias);
      }
      o[p + 3] = d[p + 3];
    }
  ctx.putImageData(pixels, 0, 0);
  return output;
}

/** Filter amounts: blur/motion/pixelate in pixels; other filters use 0–100 strength. */
export function applyFilter(
  source: HTMLCanvasElement,
  kind: string,
  amount = 20,
): HTMLCanvasElement {
  const filter = kind.toLowerCase();
  if (
    ![
      "gaussian",
      "blur",
      "motion",
      "sharpen",
      "noise",
      "pixelate",
      "pixel",
      "emboss",
      "edges",
      "edge",
      "vignette",
      "bloom",
    ].includes(filter)
  )
    throw new Error(`不支持的滤镜：${kind}`);
  if (!Number.isFinite(amount)) throw new Error("滤镜强度必须是有限数字");
  const output = cloneCanvas(source),
    ctx = context(output),
    w = source.width,
    h = source.height;
  const strength = clamp(amount, 0, 100);
  if (amount <= 0) return output;
  if (filter === "gaussian" || filter === "blur") {
    ctx.clearRect(0, 0, w, h);
    ctx.filter = `blur(${clamp(amount, 0, 256)}px)`;
    ctx.drawImage(source, 0, 0);
    ctx.filter = "none";
    return output;
  }
  if (filter === "pixelate" || filter === "pixel") {
    const size = Math.max(1, Math.round(amount)),
      small = createCanvas(Math.ceil(w / size), Math.ceil(h / size));
    context(small).drawImage(source, 0, 0, small.width, small.height);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, w, h);
    return output;
  }
  if (filter === "sharpen") {
    const a = strength / 25;
    return convolve(source, [0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0]);
  }
  if (filter === "emboss") {
    const a = strength / 100;
    return convolve(source, [-2 * a, -a, 0, -a, 1, a, 0, a, 2 * a], 1, 128 * a);
  }
  if (filter === "bloom") {
    const blurred = applyFilter(source, "gaussian", Math.max(2, strength / 2));
    const original = ctx.getImageData(0, 0, w, h),
      glow = context(blurred).getImageData(0, 0, w, h).data;
    for (let i = 0; i < original.data.length; i += 4) {
      const weight = ((strength / 100) * glow[i + 3]) / 255;
      for (let c = 0; c < 3; c++)
        original.data[i + c] +=
          (((255 - original.data[i + c]) * glow[i + c]) / 255) * weight;
    }
    ctx.putImageData(original, 0, 0);
    return output;
  }
  const pixels = ctx.getImageData(0, 0, w, h),
    data = pixels.data;
  if (filter === "motion") {
    const radius = Math.min(Math.max(w, 1), Math.round(clamp(amount, 1, 256))),
      original = new Uint8ClampedArray(data);
    const windowSize = radius * 2 + 1;
    for (let y = 0; y < h; y++) {
      const sums = [0, 0, 0, 0];
      const accumulate = (x: number, sign: number) => {
        const p = (y * w + clamp(x, 0, w - 1)) * 4,
          alpha = original[p + 3] / 255;
        sums[0] += original[p] * alpha * sign;
        sums[1] += original[p + 1] * alpha * sign;
        sums[2] += original[p + 2] * alpha * sign;
        sums[3] += alpha * sign;
      };
      for (let x = -radius; x <= radius; x++) accumulate(x, 1);
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        for (let c = 0; c < 3; c++)
          data[p + c] = sums[3] > 0 ? sums[c] / sums[3] : 0;
        data[p + 3] = (sums[3] / windowSize) * 255;
        accumulate(x - radius, -1);
        accumulate(x + radius + 1, 1);
      }
    }
  } else if (filter === "edges" || filter === "edge") {
    const original = new Uint8ClampedArray(data),
      gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1],
      gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let sx = 0,
          sy = 0;
        for (let ky = -1; ky <= 1; ky++)
          for (let kx = -1; kx <= 1; kx++) {
            const p =
                (clamp(y + ky, 0, h - 1) * w + clamp(x + kx, 0, w - 1)) * 4,
              gray =
                original[p] * 0.2126 +
                original[p + 1] * 0.7152 +
                original[p + 2] * 0.0722,
              k = (ky + 1) * 3 + kx + 1;
            sx += gray * gx[k];
            sy += gray * gy[k];
          }
        const p = (y * w + x) * 4,
          value = clamp((Math.hypot(sx, sy) * strength) / 50);
        data[p] = data[p + 1] = data[p + 2] = value;
      }
  } else if (filter === "noise") {
    let seed = 0x12345678;
    for (let i = 0; i < data.length; i += 4) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const offset = ((seed >>> 0) / 4294967296 - 0.5) * strength * 2.55;
      data[i] += offset;
      data[i + 1] += offset;
      data[i + 2] += offset;
    }
  } else if (filter === "vignette") {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const distance = Math.hypot(
          (x + 0.5 - w / 2) / (w / 2),
          (y + 0.5 - h / 2) / (h / 2),
        );
        const factor =
            1 -
            (clamp((distance - 0.25) / 1.164, 0, 1) ** 1.5 * strength) / 100,
          p = (y * w + x) * 4;
        data[p] *= factor;
        data[p + 1] *= factor;
        data[p + 2] *= factor;
      }
  }
  ctx.putImageData(pixels, 0, 0);
  return output;
}

/** White alpha selection, with tolerance in 0–255 and four-neighbour connectivity. */
export function floodMask(
  source: HTMLCanvasElement,
  x: number,
  y: number,
  tolerance: number,
  contiguous = true,
): HTMLCanvasElement {
  const w = source.width,
    h = source.height,
    mask = createCanvas(w, h),
    ctx = context(mask);
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return mask;
  const input = context(source).getImageData(0, 0, w, h).data,
    output = ctx.createImageData(w, h),
    o = output.data;
  const start = y * w + x,
    p = start * 4,
    alpha = input[p + 3],
    r = input[p],
    g = input[p + 1],
    b = input[p + 2],
    threshold = clamp(tolerance, 0, 255);
  const matches = (index: number) => {
    const offset = index * 4;
    if (alpha === 0 && input[offset + 3] === 0) return true;
    return (
      Math.max(
        Math.abs(input[offset] - r),
        Math.abs(input[offset + 1] - g),
        Math.abs(input[offset + 2] - b),
        Math.abs(input[offset + 3] - alpha),
      ) <= threshold
    );
  };
  const mark = (index: number) => {
    const offset = index * 4;
    o[offset] = o[offset + 1] = o[offset + 2] = o[offset + 3] = 255;
  };
  if (!contiguous) {
    for (let index = 0; index < w * h; index++) if (matches(index)) mark(index);
  } else {
    // Each pixel enters the queue at most once, avoiding recursive stack overflow.
    const visited = new Uint8Array(w * h),
      queue = new Uint32Array(w * h);
    let head = 0,
      tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    const enqueue = (index: number) => {
      if (!visited[index]) {
        visited[index] = 1;
        if (matches(index)) queue[tail++] = index;
      }
    };
    while (head < tail) {
      const index = queue[head++],
        col = index % w;
      mark(index);
      if (col > 0) enqueue(index - 1);
      if (col < w - 1) enqueue(index + 1);
      if (index >= w) enqueue(index - w);
      if (index < w * (h - 1)) enqueue(index + w);
    }
  }
  ctx.putImageData(output, 0, 0);
  return mask;
}

export function selectionBounds(mask: HTMLCanvasElement): Rect | null {
  const w = mask.width,
    h = mask.height,
    data = context(mask).getImageData(0, 0, w, h).data;
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[(y * w + x) * 4 + 3]) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
  return maxX < 0
    ? null
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function combineMasks(
  a: HTMLCanvasElement | null | undefined,
  b: HTMLCanvasElement,
  mode: "replace" | "add" | "subtract" | "intersect",
): HTMLCanvasElement {
  if (mode === "replace" || !a)
    return mode === "subtract" || mode === "intersect"
      ? createCanvas(b.width, b.height)
      : cloneCanvas(b);
  const result = createCanvas(a.width, a.height),
    ctx = context(result),
    first = context(a).getImageData(0, 0, a.width, a.height),
    secondCanvas = createCanvas(a.width, a.height);
  context(secondCanvas).drawImage(b, 0, 0);
  const second = context(secondCanvas).getImageData(
      0,
      0,
      a.width,
      a.height,
    ).data,
    d = first.data;
  for (let i = 0; i < d.length; i += 4) {
    const alpha =
      mode === "add"
        ? Math.max(d[i + 3], second[i + 3])
        : mode === "intersect"
          ? Math.min(d[i + 3], second[i + 3])
          : d[i + 3] * (1 - second[i + 3] / 255);
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = alpha;
  }
  ctx.putImageData(first, 0, 0);
  return result;
}

export function featherMask(
  mask: HTMLCanvasElement,
  radius: number,
): HTMLCanvasElement {
  return radius > 0 ? applyFilter(mask, "gaussian", radius) : cloneCanvas(mask);
}
