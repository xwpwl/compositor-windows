import { unzipSync, zlibSync } from "fflate";
import { createCanvas } from "./engine";

export const LIMITS = {
  bytes: 256 * 1024 * 1024,
  expanded: 512 * 1024 * 1024,
  manifest: 4 * 1024 * 1024,
  pixels: 64_000_000,
  totalPixels: 128_000_000,
  side: 16384,
  layers: 2000,
};
export const utf8 = new TextEncoder();
export const text = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
export function dimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > LIMITS.side ||
    height > LIMITS.side ||
    width * height > LIMITS.pixels
  )
    throw new Error(
      `图像尺寸超过此版本限制：边长 ${LIMITS.side}，单幅 6400 万像素。`,
    );
}
export function safePath(path: string): string {
  if (
    !path ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.includes(":") ||
    path.includes("\0") ||
    path.split("/").some((p) => p === ".." || p === ".")
  )
    throw new Error("工程包含不安全的文件路径。");
  return path;
}
export function boundedZip(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.length > LIMITS.bytes) throw new Error("压缩工程大于 256 MiB。");
  // Check the central directory before fflate allocates any output buffers.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("工程 ZIP 目录损坏。");
  const count = view.getUint16(eocd + 10, true),
    offset = view.getUint32(eocd + 16, true),
    size = view.getUint32(eocd + 12, true);
  if (
    view.getUint16(eocd + 4, true) ||
    view.getUint16(eocd + 6, true) ||
    count === 65535 ||
    count > LIMITS.layers * 2 + 20 ||
    offset + size > eocd
  )
    throw new Error("不支持分卷、ZIP64 或过多文件的工程。");
  let at = offset,
    total = 0;
  const names = new Set<string>();
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || view.getUint32(at, true) !== 0x02014b50)
      throw new Error("工程 ZIP 文件目录损坏。");
    const flags = view.getUint16(at + 8, true),
      method = view.getUint16(at + 10, true),
      compressed = view.getUint32(at + 20, true),
      expanded = view.getUint32(at + 24, true);
    const length = view.getUint16(at + 28, true),
      extra = view.getUint16(at + 30, true),
      comment = view.getUint16(at + 32, true);
    if (at + 46 + length + extra + comment > eocd)
      throw new Error("工程 ZIP 文件目录被截断。");
    const name = safePath(text(bytes.subarray(at + 46, at + 46 + length)));
    total += expanded;
    if (
      names.has(name) ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      expanded > LIMITS.bytes ||
      total > LIMITS.expanded ||
      (expanded > 16 * 1024 * 1024 && expanded / Math.max(1, compressed) > 2000)
    )
      throw new Error("工程 ZIP 文件重复、加密或解压尺寸超过限制。");
    names.add(name);
    at += 46 + length + extra + comment;
  }
  if (at !== offset + size) throw new Error("工程 ZIP 目录长度不正确。");
  return unzipSync(bytes, { filter: (file) => !file.name.endsWith("/") });
}
export async function png(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  dimensions(canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("PNG 编码失败。"))),
      "image/png",
    ),
  );
  return new Uint8Array(await blob.arrayBuffer());
}
export function pngInfo(
  bytes: Uint8Array,
): { width: number; height: number; depth: number; color: number } | null {
  if (
    bytes.length < 33 ||
    bytes[0] !== 137 ||
    bytes[1] !== 80 ||
    bytes[2] !== 78 ||
    bytes[3] !== 71
  )
    return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: v.getUint32(16),
    height: v.getUint32(20),
    depth: bytes[24],
    color: bytes[25],
  };
}
function inspectDimensions(bytes: Uint8Array): void {
  const info = pngInfo(bytes);
  if (info) {
    dimensions(info.width, info.height);
    return;
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 10 &&
    bytes[0] === 71 &&
    bytes[1] === 73 &&
    bytes[2] === 70
  ) {
    dimensions(v.getUint16(6, true), v.getUint16(8, true));
    return;
  }
  if (bytes.length >= 26 && bytes[0] === 66 && bytes[1] === 77) {
    if (v.getUint32(14, true) === 12)
      dimensions(v.getUint16(18, true), v.getUint16(20, true));
    else
      dimensions(
        Math.abs(v.getInt32(18, true)),
        Math.abs(v.getInt32(22, true)),
      );
    return;
  }
  if (
    bytes.length >= 30 &&
    bytes[0] === 82 &&
    bytes[1] === 73 &&
    bytes[8] === 87 &&
    bytes[9] === 69 &&
    bytes[10] === 66 &&
    bytes[11] === 80
  ) {
    if (bytes[15] === 88) {
      dimensions(
        1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      );
      return;
    }
    if (bytes[15] === 76 && bytes[20] === 47) {
      const bits = v.getUint32(21, true);
      dimensions(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
      return;
    }
    if (bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      dimensions(
        v.getUint16(26, true) & 0x3fff,
        v.getUint16(28, true) & 0x3fff,
      );
      return;
    }
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at++] !== 255) break;
      while (at < bytes.length && bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (at + 2 > bytes.length) break;
      const length = v.getUint16(at);
      if (length < 2 || at + length > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        length >= 7
      ) {
        dimensions(v.getUint16(at + 5), v.getUint16(at + 3));
        return;
      }
      at += length;
    }
  }
}
export async function decodeImage(
  bytes: Uint8Array,
  name = "",
): Promise<HTMLCanvasElement> {
  if (bytes.length > LIMITS.bytes) throw new Error("图像文件大于 256 MiB。");
  inspectDimensions(bytes);
  const ext = name.toLowerCase().split(".").pop() ?? "";
  let mime =
    (
      {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
        gif: "image/gif",
        bmp: "image/bmp",
        svg: "image/svg+xml",
      } as Record<string, string>
    )[ext] ?? "";
  if (ext === "svg") {
    const source = text(bytes);
    if (
      /<\s*(script|foreignObject)\b/i.test(source) ||
      /(?:href|src)\s*=\s*["']\s*(?!#|data:image\/)[^"']+/i.test(source) ||
      /url\(\s*["']?\s*(?!#)[^)]+/i.test(source)
    )
      throw new Error("SVG 含外部资源或脚本，请先将其导出为独立图片。");
    mime = "image/svg+xml";
    const root = new DOMParser().parseFromString(
      source,
      "image/svg+xml",
    ).documentElement;
    const width = Number.parseFloat(root.getAttribute("width") || ""),
      height = Number.parseFloat(root.getAttribute("height") || "");
    if (Number.isFinite(width) && Number.isFinite(height))
      dimensions(Math.ceil(width), Math.ceil(height));
  }
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () =>
        reject(
          new Error(
            `无法解码 ${name || "图片"}；此版本不支持相机 RAW、HEIC、TIFF、PDF 或 EXR，请转换为 PNG/JPEG。`,
          ),
        );
      img.src = url;
    });
    dimensions(image.naturalWidth, image.naturalHeight);
    const canvas = createCanvas(image.naturalWidth, image.naturalHeight);
    canvas.getContext("2d")!.drawImage(image, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}
export function grayToAlpha(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const out = createCanvas(canvas.width, canvas.height),
    ctx = out.getContext("2d")!;
  const data = canvas
    .getContext("2d")!
    .getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < data.data.length; i += 4) {
    const alpha = data.data[i];
    data.data[i] = data.data[i + 1] = data.data[i + 2] = 255;
    data.data[i + 3] = alpha;
  }
  ctx.putImageData(data, 0, 0);
  return out;
}
export function alphaToGray(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const out = createCanvas(canvas.width, canvas.height),
    ctx = out.getContext("2d")!;
  const data = canvas
    .getContext("2d")!
    .getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < data.data.length; i += 4) {
    data.data[i] = data.data[i + 1] = data.data[i + 2] = data.data[i + 3];
    data.data[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return out;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 12),
    v = new DataView(out.buffer);
  v.setUint32(0, bytes.length);
  out.set(utf8.encode(type), 4);
  out.set(bytes, 8);
  v.setUint32(bytes.length + 8, crc32(out.subarray(4, bytes.length + 8)));
  return out;
}
// Canvas PNGs are RGBA. Original .comp masks require true 8-bit grayscale without alpha.
export function grayscalePNG(mask: HTMLCanvasElement): Uint8Array {
  dimensions(mask.width, mask.height);
  const data = mask
    .getContext("2d")!
    .getImageData(0, 0, mask.width, mask.height).data;
  const scanlines = new Uint8Array((mask.width + 1) * mask.height);
  for (let y = 0; y < mask.height; y++)
    for (let x = 0; x < mask.width; x++)
      scanlines[y * (mask.width + 1) + x + 1] =
        data[(y * mask.width + x) * 4 + 3];
  const header = new Uint8Array(13),
    v = new DataView(header.buffer);
  v.setUint32(0, mask.width);
  v.setUint32(4, mask.height);
  header[8] = 8;
  const chunks = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlibSync(scanlines)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
