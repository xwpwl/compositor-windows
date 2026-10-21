import {
  readPsd,
  writePsdUint8Array,
  type Layer as PSDLayer,
  type BlendMode,
  type Psd,
} from "ag-psd";
import { zipSync } from "fflate";
import type { EditorDocument, Layer, NativeFile } from "./types";
import {
  createCanvas,
  defaultAdjustments,
  defaultEffects,
  flattenLayers,
  layerMatrix,
  makeDocument,
  makeLayer,
  renderDocument,
  renderLayer,
  sourceCanvas,
} from "./engine";
import {
  alphaToGray,
  boundedZip,
  decodeImage,
  dimensions,
  grayscalePNG,
  grayToAlpha,
  LIMITS,
  png,
  pngInfo,
  safePath,
  text,
  utf8,
} from "./io-codec";

type Json = Record<string, any>;
type CompatibleLayer = Layer & { compatibility?: Json };
type CompatibleDocument = EditorDocument & { compatibility?: Json };
type ImportResult = { document: EditorDocument; warnings: string[] };
const unique = (items: string[]): string[] => [...new Set(items)];
const finite = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, v));
const normalizeBlend = (v: string): string =>
  v
    .toLowerCase()
    .replace(/ \(add\)/, "")
    .replace(/\s+/g, "-");
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const id = (): string => crypto.randomUUID().toUpperCase();
const title = (name: string): string =>
  name.replace(/\.(cwdoc|comp|zip|psd|psb)$/i, "");
const rgb = (r: number, g: number, b: number, a = 1): string =>
  `rgba(${Math.round(clamp(r, 0, 1) * 255)},${Math.round(clamp(g, 0, 1) * 255)},${Math.round(clamp(b, 0, 1) * 255)},${clamp(a, 0, 1)})`;
function color(value: string): {
  red: number;
  green: number;
  blue: number;
  opacity: number;
} {
  const canvas = createCanvas(1, 1),
    ctx = canvas.getContext("2d")!;
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return {
    red: d[0] / 255,
    green: d[1] / 255,
    blue: d[2] / 255,
    opacity: d[3] / 255,
  };
}
function parseJSON(bytes: Uint8Array, label = "manifest"): Json {
  if (bytes.length > LIMITS.manifest) throw new Error(`${label} 大于 4 MiB。`);
  const object = JSON.parse(text(bytes));
  if (!object || typeof object !== "object" || Array.isArray(object))
    throw new Error(`${label} 格式不正确。`);
  return object;
}
function rasterBudget(layers: Layer[]): void {
  const all = flattenLayers(layers);
  if (all.length > LIMITS.layers)
    throw new Error("图层数量超过此版本 2000 层限制。");
  let total = 0;
  for (const layer of all) {
    dimensions(layer.width, layer.height);
    total +=
      (layer.canvas ? layer.canvas.width * layer.canvas.height : 0) +
      (layer.mask ? layer.mask.width * layer.mask.height : 0);
  }
  if (total > LIMITS.totalPixels)
    throw new Error("工程图层及蒙版超过 1.28 亿像素限制。");
}

export async function importFile(file: NativeFile): Promise<ImportResult> {
  if (file.files) return importComp(file.files, file.name);
  const ext = file.name.toLowerCase().split(".").pop();
  if (ext === "cwdoc")
    return { document: await decodeProject(file.bytes), warnings: [] };
  if (ext === "zip") {
    const files = boundedZip(file.bytes),
      key = Object.keys(files).find((k) => /(^|\/)manifest\.json$/.test(k));
    if (!key) throw new Error("ZIP 中未找到 manifest.json。");
    const manifest = parseJSON(files[key]);
    if (manifest.format === "com.compositor.windows")
      return { document: await decodeProject(file.bytes), warnings: [] };
    return importComp(files, file.name);
  }
  if (ext === "psd" || ext === "psb") return importPSD(file);
  const canvas = await decodeImage(file.bytes, file.name),
    doc = makeDocument(file.name, canvas.width, canvas.height),
    layer = makeLayer(file.name, canvas);
  doc.layers = [layer];
  doc.activeId = layer.id;
  const warnings: string[] = [];
  if (ext === "gif") warnings.push("GIF 仅导入首帧，动画不会保留。");
  if (ext === "svg")
    warnings.push("SVG 已栅格化为图像图层，矢量路径不可编辑。");
  if (pngInfo(file.bytes)?.depth === 16)
    warnings.push("16 位 PNG 已转换为 8 位 sRGB；高位深数据不会保留。");
  return { document: doc, warnings };
}

export async function encodeProject(doc: EditorDocument): Promise<Uint8Array> {
  dimensions(doc.width, doc.height);
  rasterBudget(doc.layers);
  const files: Record<string, Uint8Array> = {};
  let next = 0;
  async function encode(layer: CompatibleLayer, depth = 0): Promise<Json> {
    if (depth > 64) throw new Error("图层组嵌套过深。");
    const { canvas, mask, children, ...record } = layer;
    const key = String(next++).padStart(5, "0");
    const output: Json = { ...record };
    if (canvas) {
      output.imageFile = `images/${key}.png`;
      files[output.imageFile] = await png(canvas);
    }
    if (mask) {
      output.maskFile = `images/${key}.mask.png`;
      files[output.maskFile] = await png(mask);
    }
    if (children) {
      output.children = [];
      for (const child of children)
        output.children.push(await encode(child, depth + 1));
    }
    return output;
  }
  const layers = [];
  for (const layer of doc.layers) layers.push(await encode(layer));
  const metadata = {
    format: "com.compositor.windows",
    version: 1,
    id: doc.id,
    name: doc.name,
    width: doc.width,
    height: doc.height,
    activeId: doc.activeId,
    layers,
    compatibility: (doc as CompatibleDocument).compatibility,
  };
  files["manifest.json"] = utf8.encode(JSON.stringify(metadata));
  if (files["manifest.json"].length > LIMITS.manifest)
    throw new Error("工程元数据超过 4 MiB。");
  return zipSync(files, { level: 1 });
}

export async function decodeProject(
  bytes: Uint8Array,
): Promise<EditorDocument> {
  const files = boundedZip(bytes),
    manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw new Error("缺少工程 manifest.json。");
  const m = parseJSON(manifestBytes);
  if (m.format !== "com.compositor.windows" || m.version !== 1)
    throw new Error("不是受支持的 Compositor Windows 工程版本。");
  dimensions(m.width, m.height);
  if (!Array.isArray(m.layers)) throw new Error("工程图层列表无效。");
  const seen = new Set<string>();
  let count = 0,
    pixels = 0;
  async function asset(path: unknown): Promise<HTMLCanvasElement> {
    if (typeof path !== "string" || !files[safePath(path)])
      throw new Error("工程图层图片缺失。");
    const info = pngInfo(files[path]);
    if (!info) throw new Error("工程图层必须为 PNG。");
    dimensions(info.width, info.height);
    pixels += info.width * info.height;
    if (pixels > LIMITS.totalPixels) throw new Error("工程像素预算超限。");
    return decodeImage(files[path], path);
  }
  async function decode(r: Json, depth = 0): Promise<Layer> {
    if (
      !r ||
      typeof r !== "object" ||
      depth > 64 ||
      ++count > LIMITS.layers ||
      typeof r.id !== "string" ||
      seen.has(r.id)
    )
      throw new Error("工程图层无效或重复。");
    seen.add(r.id);
    dimensions(r.width, r.height);
    if (!["raster", "text", "shape", "group", "adjustment"].includes(r.type))
      throw new Error("工程包含未知图层类型。");
    const layer = makeLayer(
      String(r.name || "Layer").slice(0, 16384),
      undefined,
      r.type,
    ) as CompatibleLayer;
    layer.id = r.id;
    layer.width = r.width;
    layer.height = r.height;
    layer.x = finite(r.x);
    layer.y = finite(r.y);
    layer.scaleX = finite(r.scaleX, 1);
    layer.scaleY = finite(r.scaleY, 1);
    layer.rotation = finite(r.rotation);
    layer.opacity = clamp(finite(r.opacity, 1), 0, 1);
    layer.visible = r.visible !== false;
    layer.locked = r.locked === true;
    layer.clip = r.clip === true;
    layer.maskEnabled = r.maskEnabled !== false;
    layer.blendMode = typeof r.blendMode === "string" ? r.blendMode : "normal";
    if (r.imageFile) layer.canvas = await asset(r.imageFile);
    if (r.maskFile) layer.mask = await asset(r.maskFile);
    if (r.text && layer.type === "text")
      layer.text = {
        content: String(r.text.content ?? "").slice(0, 100000),
        fontFamily: String(r.text.fontFamily || "Arial"),
        fontSize: clamp(finite(r.text.fontSize, 64), 1, 4096),
        fontWeight: String(r.text.fontWeight || "400"),
        color: String(r.text.color || "#000000"),
        align: ["left", "center", "right", "start", "end"].includes(
          r.text.align,
        )
          ? r.text.align
          : "left",
        lineHeight: clamp(finite(r.text.lineHeight, 1.2), 0.1, 10),
      };
    if (r.shape && layer.type === "shape")
      layer.shape = {
        kind: ["rectangle", "ellipse", "line"].includes(r.shape.kind)
          ? r.shape.kind
          : "rectangle",
        fill: String(r.shape.fill || "#000000"),
        stroke: String(r.shape.stroke || "#000000"),
        strokeWidth: clamp(finite(r.shape.strokeWidth), 0, 500),
        radius: clamp(finite(r.shape.radius), 0, 10000),
      };
    for (const k of Object.keys(
      defaultAdjustments(),
    ) as (keyof Layer["adjustments"])[]) {
      const value = r.adjustments?.[k];
      if (
        typeof value === typeof layer.adjustments[k] &&
        (typeof value !== "number" || Number.isFinite(value))
      )
        (layer.adjustments as any)[k] = value;
    }
    for (const k of Object.keys(
      defaultEffects(),
    ) as (keyof Layer["effects"])[]) {
      const value = r.effects?.[k];
      if (
        typeof value === typeof layer.effects[k] &&
        (typeof value !== "number" || Number.isFinite(value))
      )
        (layer.effects as any)[k] = value;
    }
    if (r.compatibility && typeof r.compatibility === "object")
      layer.compatibility = r.compatibility;
    if (r.type === "group") {
      if (!Array.isArray(r.children)) throw new Error("图层组缺少 children。");
      layer.children = [];
      for (const child of r.children)
        layer.children.push(await decode(child, depth + 1));
    }
    return layer;
  }
  const doc = makeDocument(
    String(m.name || "Untitled"),
    m.width,
    m.height,
  ) as CompatibleDocument;
  doc.id = typeof m.id === "string" ? m.id : doc.id;
  for (const layer of m.layers) doc.layers.push(await decode(layer));
  doc.activeId = seen.has(m.activeId)
    ? m.activeId
    : doc.layers.at(-1)?.id || "";
  doc.compatibility = m.compatibility;
  doc.dirty = false;
  return doc;
}

function psdHeader(bytes: Uint8Array): void {
  if (bytes.length < 26 || bytes.length > LIMITS.bytes)
    throw new Error("PSD 文件损坏或大于 256 MiB。");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (text(bytes.subarray(0, 4)) !== "8BPS" || ![1, 2].includes(v.getUint16(4)))
    throw new Error("不是有效 PSD/PSB 文件。");
  dimensions(v.getUint32(18), v.getUint32(14));
  if (v.getUint16(22) !== 8 || v.getUint16(24) !== 3)
    throw new Error(
      "此版本仅支持 8 位 RGB PSD/PSB。请先在 Photoshop 中转换颜色模式和位深。",
    );
}
async function importPSD(file: NativeFile): Promise<ImportResult> {
  psdHeader(file.bytes);
  const warnings: string[] = [];
  const psd = readPsd(file.bytes, {
    skipThumbnail: true,
    skipLinkedFilesData: true,
    logMissingFeatures: true,
    log: (...args) =>
      warnings.push(
        `PSD 解析提示：${args.map(String).join(" ").slice(0, 300)}`,
      ),
  });
  const doc = makeDocument(title(file.name), psd.width, psd.height);
  let count = 0;
  function convert(source: PSDLayer, depth = 0): Layer {
    if (++count > LIMITS.layers || depth > 64)
      throw new Error("PSD 图层数量或嵌套超过限制。");
    const group = !!source.children,
      layer = makeLayer(
        source.name || "Layer",
        source.canvas,
        group ? "group" : "raster",
      ) as CompatibleLayer;
    layer.x = source.left ?? 0;
    layer.y = source.top ?? 0;
    layer.visible = !source.hidden;
    layer.opacity = source.opacity ?? 1;
    layer.blendMode = normalizeBlend(source.blendMode || "normal");
    layer.clip = !!source.clipping;
    layer.locked = !!source.protected?.composite;
    if (group) {
      layer.x = layer.y = 0;
      layer.width = doc.width;
      layer.height = doc.height;
      layer.children = [...(source.children || [])]
        .reverse()
        .map((c) => convert(c, depth + 1));
    }
    if (source.mask?.canvas) {
      const mask = createCanvas(layer.width, layer.height),
        ctx = mask.getContext("2d")!;
      const defaultAlpha = (source.mask.defaultColor ?? 255) / 255;
      ctx.fillStyle = `rgba(255,255,255,${defaultAlpha})`;
      ctx.fillRect(0, 0, mask.width, mask.height);
      const sourceMask = grayToAlpha(source.mask.canvas);
      ctx.globalCompositeOperation = "copy";
      const mx =
          (source.mask.left ?? layer.x) -
          (source.mask.positionRelativeToLayer ? 0 : layer.x),
        my =
          (source.mask.top ?? layer.y) -
          (source.mask.positionRelativeToLayer ? 0 : layer.y);
      ctx.clearRect(mx, my, sourceMask.width, sourceMask.height);
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(sourceMask, mx, my);
      layer.mask = mask;
      layer.maskEnabled = !source.mask.disabled;
      if (
        source.mask.userMaskDensity !== undefined ||
        source.mask.userMaskFeather
      )
        warnings.push("PSD 蒙版密度或羽化参数未重建；已导入栅格蒙版。");
    }
    const features = [
      source.text && "文字",
      source.vectorMask && "矢量路径",
      source.vectorFill && "填充",
      source.placedLayer && "智能对象",
      source.adjustment && "调整图层",
      source.effects && "图层效果",
      source.realMask && "第二蒙版",
    ].filter(Boolean);
    if (features.length) {
      warnings.push(
        `“${layer.name}”包含${features.join("、")}：使用 PSD 存储的栅格像素，相关编辑参数未重建；调整或效果可能与 Photoshop 显示不同。`,
      );
      layer.compatibility = {
        source: "psd",
        unsupported: features,
        text: source.text?.text,
      };
    }
    if (!group && !source.canvas)
      warnings.push(`“${layer.name}”没有可用栅格预览，导入为空图层。`);
    return layer;
  }
  doc.layers = [...(psd.children || [])].reverse().map((l) => convert(l));
  if (!doc.layers.length && psd.canvas)
    doc.layers = [makeLayer("Composite", psd.canvas)];
  if (!doc.layers.length) throw new Error("PSD 没有可读取的图层或合成预览。");
  rasterBudget(doc.layers);
  doc.activeId = doc.layers.at(-1)!.id;
  if (warnings.length && psd.canvas) {
    const preview = makeLayer(
      "Photoshop 原始合成预览（隐藏，供对照）",
      psd.canvas,
    );
    preview.visible = false;
    doc.layers.push(preview);
    warnings.push(
      "已添加隐藏的 Photoshop 原始合成预览图层，启用后可对照原始外观。",
    );
  }
  return { document: doc, warnings: unique(warnings) };
}

export function getPSDExportWarnings(doc: EditorDocument): string[] {
  const layers = flattenLayers(doc.layers),
    warnings: string[] = [];
  if (layers.some((l) => l.type === "adjustment"))
    warnings.push(
      "PSD 导出将整个文档合成为单个图层，以保留调整图层的最终外观；可编辑结构保留在 .cwdoc 工程中。",
    );
  else {
    if (layers.some((l) => l.type === "text" || l.type === "shape"))
      warnings.push("PSD 中的文字与形状将转为栅格图层；.cwdoc 中仍可编辑。");
    if (
      layers.some(
        (l) =>
          l.rotation ||
          l.scaleX !== 1 ||
          l.scaleY !== 1 ||
          l.effects.shadow ||
          l.effects.stroke,
      )
    )
      warnings.push("PSD 的变换与图层效果会烘焙为图层像素。");
    if (
      layers.some(
        (l) =>
          l.mask && l.maskEnabled && (l.effects.shadow || l.effects.stroke),
      )
    )
      warnings.push(
        "同时使用蒙版和图层效果的图层会将蒙版一起烘焙，以保留阴影和描边的边缘。",
      );
    if (
      layers.some(
        (l) =>
          l.type === "group" &&
          (l.x || l.y || l.rotation || l.scaleX !== 1 || l.scaleY !== 1),
      )
    )
      warnings.push("变换过的图层组会合成为单个栅格图层。");
  }
  return warnings;
}
export async function exportPSD(doc: EditorDocument): Promise<Uint8Array> {
  dimensions(doc.width, doc.height);
  rasterBudget(doc.layers);
  const composite = renderDocument(doc);
  if (flattenLayers(doc.layers).some((l) => l.type === "adjustment"))
    return writePsdUint8Array(
      {
        width: doc.width,
        height: doc.height,
        canvas: composite,
        children: [{ name: doc.name, canvas: composite }],
      },
      { noBackground: true },
    );
  function convert(layer: Layer): PSDLayer {
    const bakeMask =
      !!layer.mask &&
      layer.maskEnabled &&
      (layer.effects.shadow || layer.effects.stroke);
    const grouped =
      layer.type === "group" &&
      !layer.x &&
      !layer.y &&
      !layer.rotation &&
      layer.scaleX === 1 &&
      layer.scaleY === 1 &&
      !layer.effects.shadow &&
      !layer.effects.stroke;
    const base: PSDLayer = {
      name: layer.name,
      hidden: !layer.visible,
      opacity: layer.opacity,
      blendMode: (layer.blendMode === "normal" && grouped
        ? "normal"
        : layer.blendMode.replace(/-/g, " ")) as BlendMode,
      clipping: layer.clip,
      protected: { composite: layer.locked },
    };
    if (grouped)
      base.children = [...(layer.children || [])].reverse().map(convert);
    else {
      base.canvas = renderLayer(
        { ...layer, visible: true, mask: bakeMask ? layer.mask : undefined },
        doc.width,
        doc.height,
      );
      base.left = base.top = 0;
    }
    if (layer.mask && !bakeMask) {
      const localMask = {
        ...layer,
        type: "raster" as const,
        canvas: layer.mask,
        mask: undefined,
        effects: defaultEffects(),
        adjustments: defaultAdjustments(),
        visible: true,
      };
      base.mask = {
        left: 0,
        top: 0,
        canvas: alphaToGray(renderLayer(localMask, doc.width, doc.height)),
        disabled: !layer.maskEnabled,
        defaultColor: 0,
      };
    }
    return base;
  }
  return writePsdUint8Array(
    {
      width: doc.width,
      height: doc.height,
      canvas: composite,
      children: [...doc.layers].reverse().map(convert),
    },
    { noBackground: true },
  );
}

const compBlendNames = [
  "Normal",
  "Darken",
  "Multiply",
  "Color Burn",
  "Linear Burn",
  "Lighten",
  "Screen",
  "Color Dodge",
  "Linear Dodge (Add)",
  "Overlay",
  "Soft Light",
  "Hard Light",
  "Vivid Light",
  "Linear Light",
  "Pin Light",
  "Hard Mix",
  "Difference",
  "Exclusion",
  "Subtract",
  "Divide",
  "Hue",
  "Saturation",
  "Color",
  "Luminosity",
];
function compTransform(layer: Layer): Json {
  return {
    origin: [
      layer.x + Math.min(0, layer.width * layer.scaleX),
      layer.y + Math.min(0, layer.height * layer.scaleY),
    ],
    size: [
      Math.max(1, Math.abs(layer.width * layer.scaleX)),
      Math.max(1, Math.abs(layer.height * layer.scaleY)),
    ],
    rotation: layer.rotation,
    flipX: layer.scaleX < 0,
    flipY: layer.scaleY < 0,
    sampling: "High quality",
  };
}
function applyCompTransform(layer: Layer, t: Json): void {
  if (
    !t ||
    !Array.isArray(t.origin) ||
    !Array.isArray(t.size) ||
    t.origin.length !== 2 ||
    t.size.length !== 2 ||
    ![...t.origin, ...t.size, t.rotation].every(Number.isFinite) ||
    t.size.some((n: number) => n < 1 || n > 300000) ||
    t.origin.some((n: number) => Math.abs(n) > 1000000)
  )
    throw new Error("Compositor 图层变换无效。");
  layer.scaleX = (t.size[0] / layer.width) * (t.flipX ? -1 : 1);
  layer.scaleY = (t.size[1] / layer.height) * (t.flipY ? -1 : 1);
  layer.rotation = t.rotation;
  layer.x = t.origin[0] + (t.flipX ? t.size[0] : 0);
  layer.y = t.origin[1] + (t.flipY ? t.size[1] : 0);
}

export async function importComp(
  input: Record<string, Uint8Array>,
  name = "Compositor",
): Promise<ImportResult> {
  const keys = Object.keys(input);
  if (keys.length > LIMITS.layers * 2 + 20)
    throw new Error("工程文件数量超过限制。");
  keys.forEach(safePath);
  const manifestKey = keys.find((k) => /(^|\/)manifest\.json$/.test(k));
  if (!manifestKey) throw new Error("未找到 .comp 的 manifest.json。");
  const prefix = manifestKey.slice(0, -"manifest.json".length),
    m = parseJSON(input[manifestKey]);
  if (
    m.format !== "com.compositor.project" ||
    !Number.isInteger(m.version) ||
    m.version < 1 ||
    m.version > 15 ||
    m.colorSpace !== "sRGB"
  )
    throw new Error("仅支持 Compositor .comp 版本 1–15、sRGB。");
  dimensions(m.width, m.height);
  if (!Array.isArray(m.layers) || m.layers.length > LIMITS.layers)
    throw new Error("Compositor 图层列表无效或超过限制。");
  const doc = makeDocument(
    title(name),
    m.width,
    m.height,
  ) as CompatibleDocument;
  doc.id = uuid(m.documentID) ? m.documentID : doc.id;
  doc.compatibility = {
    source: "comp",
    version: m.version,
    resolution: m.resolution ?? 72,
    guides: m.guides || [],
  };
  const warnings: string[] = [],
    map = new Map<string, CompatibleLayer>(),
    records = new Map<string, Json>();
  let pixels = 0;
  for (const r of m.layers as Json[]) {
    if (!r || typeof r !== "object" || !uuid(r.id))
      throw new Error("Compositor 图层 UUID 无效。");
    r.id = r.id.toUpperCase();
    if (r.parentID) {
      if (!uuid(r.parentID)) throw new Error("Compositor parentID 无效。");
      r.parentID = r.parentID.toUpperCase();
    }
    if (r.maskSourceID) {
      if (!uuid(r.maskSourceID))
        throw new Error("Compositor maskSourceID 无效。");
      r.maskSourceID = r.maskSourceID.toUpperCase();
    }
    if (
      (m.version < 2 && (r.isGroup || r.parentID)) ||
      (m.version < 3 &&
        ((r.opacity ?? 1) !== 1 || (r.blendMode ?? "Normal") !== "Normal")) ||
      (r.maskFile && m.version < (r.isGroup ? 6 : 4)) ||
      (r.maskSourceID && m.version < 5) ||
      (r.adjustment && m.version < 7) ||
      (r.text?.colorRuns && m.version < 10) ||
      (r.text?.fontRuns && m.version < 11) ||
      (r.shape?.smoothing && m.version < 14) ||
      ((r.shape?.lineStyle || r.shape?.lineCap) && m.version < 15)
    )
      throw new Error("Compositor 图层使用了当前声明版本不允许的字段。");
    if (
      r.isGroup &&
      ((r.blendMode ?? "Normal") !== "Normal" ||
        (m.version < 8 && (r.opacity ?? 1) !== 1))
    )
      throw new Error("原版组混合模式必须为 Normal。");
    if (
      r.opacity !== undefined &&
      (!Number.isFinite(r.opacity) || r.opacity < 0 || r.opacity > 1)
    )
      throw new Error("Compositor 图层透明度无效。");
    if (r.blendMode !== undefined && !compBlendNames.includes(r.blendMode))
      throw new Error("Compositor 混合模式无效。");
    if (
      (r.maskEnabled !== undefined ||
        r.maskPlacement ||
        r.maskLinked !== undefined) &&
      !r.maskFile
    )
      throw new Error("蒙版参数缺少 maskFile。");
  }
  async function asset(
    record: Json,
    mask = false,
  ): Promise<HTMLCanvasElement | undefined> {
    const filename = mask ? record.maskFile : record.imageFile;
    if (!filename) return;
    const expected = `${String(record.id).toUpperCase()}${mask ? ".mask.png" : filename.endsWith(".exr") ? ".exr" : ".png"}`;
    if (filename !== expected)
      throw new Error(`“${record.name}”的图像文件名与 UUID 不匹配。`);
    const bytes = input[`${prefix}images/${filename}`];
    if (!bytes) throw new Error(`工程缺少 images/${filename}。`);
    if (filename.endsWith(".exr"))
      throw new Error(
        "此 .comp 含 HDR/EXR 图层，Windows 版本无法解码。请先在原版转换为 8 位 PNG 图层。",
      );
    const info = pngInfo(bytes);
    if (!info) throw new Error(`无效 PNG：${filename}`);
    dimensions(info.width, info.height);
    pixels += info.width * info.height;
    if (pixels > LIMITS.totalPixels)
      throw new Error("工程图层与蒙版像素预算超限。");
    if (mask && (info.color !== 0 || info.depth !== 8))
      throw new Error("Compositor 蒙版必须为 8 位灰度 PNG。");
    if (!mask && info.depth > 8) {
      if (m.version < 12 || info.depth !== 16)
        throw new Error("此项目版本不支持该 PNG 位深。");
      warnings.push("16 位图层转换为 8 位 sRGB，高位深数据不会保留。");
    }
    const canvas = await decodeImage(bytes, filename);
    return mask ? grayToAlpha(canvas) : canvas;
  }
  for (const r of m.layers as Json[]) {
    if (!uuid(r.id) || map.has(r.id) || !String(r.name || "").trim())
      throw new Error("Compositor 图层 UUID 重复、缺失或名称无效。");
    const canvas = await asset(r),
      group = r.isGroup === true;
    if ((group || r.adjustment) && canvas)
      throw new Error("组和调整图层不能携带图像资产。");
    const layer = makeLayer(
      r.name,
      canvas,
      group ? "group" : r.adjustment ? "adjustment" : "raster",
    ) as CompatibleLayer;
    layer.id = r.id;
    if (!canvas) {
      layer.width = doc.width;
      layer.height = doc.height;
      if (!group && !r.adjustment)
        layer.canvas = createCanvas(doc.width, doc.height);
    }
    layer.opacity = clamp(finite(r.opacity, 1), 0, 1);
    layer.visible = r.isVisible !== false;
    layer.blendMode = normalizeBlend(r.blendMode || "Normal");
    applyCompTransform(layer, r.transform);
    if (group) {
      layer.x = layer.y = layer.rotation = 0;
      layer.scaleX = layer.scaleY = 1;
      warnings.push(
        "原版图层组采用 pass-through 合成；Windows 组采用隔离合成，跨组混合及组透明度可能有差异。",
      );
    }
    const mask = await asset(r, true);
    if (mask) {
      layer.mask = mask;
      layer.maskEnabled = r.maskEnabled !== false;
      if (r.maskPlacement || group) {
        const placed = makeLayer("mask", mask);
        applyCompTransform(placed, r.maskPlacement || r.transform);
        const local = createCanvas(layer.width, layer.height),
          ctx = local.getContext("2d")!;
        ctx.setTransform(
          layerMatrix(layer).inverse().multiply(layerMatrix(placed)),
        );
        ctx.drawImage(mask, 0, 0);
        layer.mask = local;
        warnings.push(
          "独立或组蒙版已转换为当前图层坐标；独立蒙版的后续变换关系不保留。",
        );
      }
    }
    if (r.adjustment) {
      const a = r.adjustment,
        out = layer.adjustments;
      switch (a.kind) {
        case "Hue/Saturation":
          out.hue = finite(a.hue);
          out.saturation = finite(a.saturation);
          out.brightness = finite(a.lightness);
          if (a.colorize || a.hsvSettings)
            warnings.push(
              `“${r.name}”的着色或分色范围被简化为全局色相/饱和度。`,
            );
          break;
        case "Exposure":
          out.exposure = finite(a.exposureSettings?.exposure);
          break;
        case "Invert":
          out.invert = true;
          break;
        case "Black & White":
          out.grayscale = true;
          warnings.push(
            `“${r.name}”采用标准灰度转换，原版通道混合参数未重建。`,
          );
          break;
        case "Gaussian Blur":
          out.blur = finite(a.blurRadius, 10);
          break;
        case "Levels": {
          const range = a.levels?.ranges?.[0];
          if (range) {
            out.blackPoint = finite(range.black);
            out.whitePoint = finite(range.white, 255);
            out.gamma = finite(range.gamma, 1);
          }
          warnings.push(
            `“${r.name}”仅重建 RGB 输入色阶，分通道和输出色阶未重建。`,
          );
          break;
        }
        default:
          warnings.push(
            `“${r.name}”的 ${a.kind} 调整暂不支持，图层已保留但不产生原调整效果。`,
          );
      }
      if (a.kind !== "Invert")
        warnings.push("原版调整算法与 Windows 版本并不逐像素等价。");
    }
    if (r.effects) {
      if (r.effects.shadow) {
        const s = r.effects.shadow;
        layer.effects.shadow = s.enabled !== false;
        layer.effects.shadowColor = rgb(s.red, s.green, s.blue, s.opacity);
        layer.effects.shadowBlur = finite(s.blur, 20);
        layer.effects.shadowX =
          -Math.cos((finite(s.angle, 90) * Math.PI) / 180) *
          finite(s.distance, 20);
        layer.effects.shadowY =
          Math.sin((finite(s.angle, 90) * Math.PI) / 180) *
          finite(s.distance, 20);
      }
      if (r.effects.stroke) {
        const s = r.effects.stroke;
        layer.effects.stroke = s.enabled !== false;
        layer.effects.strokeColor = rgb(s.red, s.green, s.blue, s.opacity);
        layer.effects.strokeWidth = finite(s.size, 4);
        if (s.inside) warnings.push(`“${r.name}”的内描边简化为外描边。`);
      }
      if (Object.keys(r.effects).some((k) => !["stroke", "shadow"].includes(k)))
        warnings.push(`“${r.name}”的颜色叠加、内阴影或发光等效果未重建。`);
    }
    if (r.text || r.shape)
      warnings.push(
        `“${r.name}”使用原版保存的 PNG 外观；原版${r.text ? "文字排版" : "形状路径"}元数据保留在工程记录中，但作为栅格图层编辑。`,
      );
    if (r.transform.sampling !== "High quality")
      warnings.push("原版图层采样模式在 Windows 显示中统一使用浏览器采样。");
    layer.compatibility = { source: "comp", record: r };
    map.set(r.id, layer);
    records.set(r.id, r);
  }
  for (const r of m.layers as Json[]) {
    const layer = map.get(r.id)!;
    if (r.parentID) {
      const parent = map.get(r.parentID);
      if (!parent || parent.type !== "group")
        throw new Error("图层 parentID 不存在或不是组。");
      const ancestors = new Set([r.id]);
      let cursor: Json | undefined = r;
      while (cursor?.parentID) {
        if (ancestors.has(cursor.parentID) || ancestors.size > 64)
          throw new Error("图层组存在循环或嵌套过深。");
        ancestors.add(cursor.parentID);
        cursor = records.get(cursor.parentID);
      }
      parent.children!.push(layer);
    } else doc.layers.push(layer);
  }
  const clipped = new Set<string>();
  function clipLayer(layerId: string, chain = new Set<string>()): void {
    if (clipped.has(layerId)) return;
    const r = records.get(layerId)!;
    if (!r.maskSourceID) {
      clipped.add(layerId);
      return;
    }
    if (
      chain.has(layerId) ||
      chain.size > 256 ||
      !map.has(r.maskSourceID) ||
      map.get(r.maskSourceID)!.type === "group"
    )
      throw new Error("剪贴蒙版引用无效或循环。");
    chain.add(layerId);
    clipLayer(r.maskSourceID, chain);
    chain.delete(layerId);
    const layer = map.get(layerId)!,
      source = map.get(r.maskSourceID)!;
    const coverage = renderLayer(
      { ...source, visible: true, effects: defaultEffects() },
      doc.width,
      doc.height,
    );
    const mask = createCanvas(layer.width, layer.height),
      ctx = mask.getContext("2d")!;
    ctx.globalAlpha = source.opacity;
    ctx.setTransform(layerMatrix(layer).inverse());
    ctx.drawImage(coverage, 0, 0);
    ctx.resetTransform();
    ctx.globalAlpha = 1;
    if (layer.mask && layer.maskEnabled) {
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(layer.mask, 0, 0, layer.width, layer.height);
    }
    layer.mask = mask;
    layer.maskEnabled = true;
    clipped.add(layerId);
  }
  for (const r of m.layers as Json[])
    if (r.maskSourceID) {
      clipLayer(r.id);
      warnings.push(
        "原版实时剪贴引用已烘焙为栅格蒙版；移动源图层后不会自动更新此蒙版。",
      );
    }
  if (m.guides?.length)
    warnings.push("原版参考线保留于工程元数据，但此版本画布不显示这些参考线。");
  const active =
    typeof m.activeLayerID === "string" ? m.activeLayerID.toUpperCase() : "";
  doc.activeId = map.has(active) ? active : doc.layers.at(-1)?.id || "";
  doc.dirty = false;
  return { document: doc, warnings: unique(warnings) };
}

export async function exportComp(
  doc: EditorDocument,
): Promise<{ files: Record<string, Uint8Array>; warnings: string[] }> {
  dimensions(doc.width, doc.height);
  rasterBudget(doc.layers);
  const files: Record<string, Uint8Array> = {},
    warnings: string[] = [],
    records: Json[] = [];
  const ids = new Map(
    flattenLayers(doc.layers).map((l) => [
      l.id,
      uuid(l.id) ? l.id.toUpperCase() : id(),
    ]),
  );
  // A supported .comp adjustment cannot express all of our multi-control adjustments. Preserve the final pixels.
  function clipsGroup(layers: Layer[]): boolean {
    let base: Layer | undefined;
    for (const layer of layers) {
      if (layer.clip && base?.type === "group") return true;
      if (!layer.clip) base = layer;
      if (layer.children && clipsGroup(layer.children)) return true;
    }
    return false;
  }
  if (
    flattenLayers(doc.layers).some((l) => l.type === "adjustment") ||
    clipsGroup(doc.layers)
  ) {
    const raster = makeLayer(doc.name, renderDocument(doc));
    const flat = { ...doc, layers: [raster], activeId: raster.id };
    const result = await exportComp(flat);
    result.warnings.unshift(
      "此文档含调整图层或对组的剪贴蒙版，.comp 导出已合成为一个图层以保留外观；请同时保存 .cwdoc 保留可编辑结构。",
    );
    return result;
  }
  async function convert(
    layer: Layer,
    parentID?: string,
    previousBase?: string,
  ): Promise<void> {
    const bakeMask =
      !!layer.mask &&
      layer.maskEnabled &&
      (layer.effects.shadow || layer.effects.stroke);
    const layerId = ids.get(layer.id)!;
    const grouped =
      layer.type === "group" &&
      !layer.x &&
      !layer.y &&
      !layer.rotation &&
      layer.scaleX === 1 &&
      layer.scaleY === 1 &&
      !layer.effects.shadow &&
      !layer.effects.stroke;
    const record: Json = {
      id: layerId,
      name: layer.name.trim() || "Layer",
      isVisible: layer.visible,
      isGroup: grouped,
      opacity: layer.opacity,
      blendMode:
        compBlendNames.find(
          (b) => normalizeBlend(b) === normalizeBlend(layer.blendMode),
        ) || "Normal",
      transform: compTransform(layer),
    };
    if (parentID) record.parentID = parentID;
    if (
      !compBlendNames.some(
        (b) => normalizeBlend(b) === normalizeBlend(layer.blendMode),
      )
    )
      warnings.push(
        `“${layer.name}”的 ${layer.blendMode} 混合模式在原版格式中不可用，转为 Normal。`,
      );
    if (layer.clip && previousBase) record.maskSourceID = previousBase;
    if (layer.clip && !previousBase) {
      record.isVisible = false;
      warnings.push(`“${layer.name}”没有剪贴基底，导出时保持隐藏。`);
    }
    if (grouped) {
      record.blendMode = "Normal";
      record.transform = {
        origin: [0, 0],
        size: [doc.width, doc.height],
        rotation: 0,
        flipX: false,
        flipY: false,
        sampling: "High quality",
      };
      if (layer.opacity !== 1 || layer.blendMode !== "normal")
        warnings.push(
          `“${layer.name}”在原版是 pass-through 组，组透明度或混合行为可能不同。`,
        );
      records.push(record);
      let base: string | undefined;
      for (const child of layer.children || []) {
        await convert(child, layerId, base);
        if (!child.clip) base = ids.get(child.id);
      }
    } else {
      const adjusted = Object.keys(defaultAdjustments()).some(
        (k) =>
          (layer.adjustments as any)[k] !== (defaultAdjustments() as any)[k],
      );
      let canvas: HTMLCanvasElement;
      if (
        adjusted ||
        layer.effects.shadow ||
        layer.effects.stroke ||
        layer.type === "group"
      ) {
        canvas = renderLayer(
          { ...layer, visible: true, mask: bakeMask ? layer.mask : undefined },
          doc.width,
          doc.height,
        );
        record.transform = {
          origin: [0, 0],
          size: [doc.width, doc.height],
          rotation: 0,
          flipX: false,
          flipY: false,
          sampling: "High quality",
        };
        warnings.push(`“${layer.name}”的调整、效果或组变换已烘焙到像素中。`);
        if (bakeMask)
          warnings.push(
            `“${layer.name}”的蒙版与图层效果一起烘焙，以保留效果边缘。`,
          );
      } else {
        canvas = sourceCanvas(layer);
        if (layer.type === "text" && layer.text) {
          const t = layer.text,
            c = color(t.color);
          record.text = {
            content: t.content,
            fontName: t.fontFamily,
            fontSize: clamp(t.fontSize, 1, 2000),
            red: c.red,
            green: c.green,
            blue: c.blue,
            alignment:
              t.align === "center"
                ? "Center"
                : t.align === "right" || t.align === "end"
                  ? "Right"
                  : "Left",
            tracking: 0,
            leading: clamp(t.lineHeight * t.fontSize, 0, 5000),
          };
          warnings.push(
            "文字包含原版可编辑元数据和 PNG 外观；跨平台字体名称和排版可能在再次编辑时变化。",
          );
        }
        if (layer.type === "shape" && layer.shape) {
          const s = layer.shape,
            c = color(s.kind === "line" ? s.stroke : s.fill);
          if (s.kind === "line" || !s.strokeWidth) {
            record.shape = {
              kind:
                s.kind === "ellipse"
                  ? "Ellipse"
                  : s.kind === "line"
                    ? "Line"
                    : "Rectangle",
              red: c.red,
              green: c.green,
              blue: c.blue,
              cornerRadius: s.radius,
            };
            if (s.kind === "line")
              Object.assign(record.shape, {
                lineWidth: s.strokeWidth,
                start: [0, 0],
                end: [1, 1],
                lineStyle: "Solid",
                lineCap: "Round",
              });
          } else
            warnings.push(`“${layer.name}”含形状描边，原版导出为栅格图层。`);
        }
      }
      record.imageFile = `${layerId}.png`;
      files[`images/${record.imageFile}`] = await png(canvas);
      records.push(record);
    }
    if (layer.mask && !bakeMask) {
      let mask = layer.mask;
      if (
        !grouped &&
        record.transform.origin[0] === 0 &&
        record.transform.origin[1] === 0 &&
        record.transform.size[0] === doc.width &&
        (layer.effects.shadow ||
          layer.effects.stroke ||
          layer.type === "group" ||
          Object.keys(defaultAdjustments()).some(
            (k) =>
              (layer.adjustments as any)[k] !==
              (defaultAdjustments() as any)[k],
          ))
      )
        mask = renderLayer(
          {
            ...layer,
            type: "raster",
            canvas: layer.mask,
            mask: undefined,
            visible: true,
            effects: defaultEffects(),
            adjustments: defaultAdjustments(),
          },
          doc.width,
          doc.height,
        );
      record.maskFile = `${layerId}.mask.png`;
      record.maskEnabled = layer.maskEnabled;
      files[`images/${record.maskFile}`] = grayscalePNG(mask);
    }
  }
  let base: string | undefined;
  for (const layer of doc.layers) {
    await convert(layer, undefined, base);
    if (!layer.clip) base = ids.get(layer.id);
  }
  const meta = (doc as CompatibleDocument).compatibility;
  const manifest: Json = {
    format: "com.compositor.project",
    version: 15,
    colorSpace: "sRGB",
    documentID: uuid(doc.id) ? doc.id.toUpperCase() : id(),
    width: doc.width,
    height: doc.height,
    resolution: clamp(finite(meta?.resolution, 72), 1, 9600),
    layers: records,
  };
  const recordIds = new Set(records.map((r) => r.id));
  if (recordIds.has(ids.get(doc.activeId)))
    manifest.activeLayerID = ids.get(doc.activeId);
  else if (records.length) manifest.activeLayerID = records.at(-1)!.id;
  if (meta?.guides?.length) manifest.guides = meta.guides;
  if (
    flattenLayers(doc.layers).some((l) => (l as CompatibleLayer).compatibility)
  )
    warnings.push(
      "导出按此 Windows 文档的当前可见状态生成；导入时保留但未实现的原版元数据不会自动恢复。",
    );
  files["manifest.json"] = utf8.encode(JSON.stringify(manifest, null, 2));
  if (files["manifest.json"].length > LIMITS.manifest)
    throw new Error("Compositor 元数据超过 4 MiB。");
  return { files, warnings: unique(warnings) };
}
