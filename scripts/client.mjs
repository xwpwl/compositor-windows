import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_INPUT_FILE_BYTES = 45 * 1024 * 1024;
export const EXPORT_FORMATS = ["png", "jpeg", "psd", "cwdoc"];
const MAX_RESPONSE_BYTES = 384 * 1024 * 1024;

export function discoveryFilename() {
  return process.env.COMPOSITOR_AUTOMATION_FILE
    ? path.resolve(process.env.COMPOSITOR_AUTOMATION_FILE)
    : path.join(
        process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
        "Compositor Windows",
        "automation.json",
      );
}

export async function readDiscovery(filename = discoveryFilename()) {
  let data;
  try {
    data = JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(
        `尚未找到运行中的 Compositor Windows。请先启动桌面应用。发现文件：${filename}`,
      );
    throw new Error(
      `无法读取自动化发现文件：${filename}。请重新启动桌面应用。`,
    );
  }
  if (
    !Number.isInteger(data.port) ||
    data.port < 1 ||
    data.port > 65535 ||
    typeof data.token !== "string" ||
    !/^[0-9a-f]{64}$/i.test(data.token) ||
    !Number.isInteger(data.pid) ||
    data.pid < 1
  )
    throw new Error("自动化发现文件格式无效，请重新启动 Compositor Windows。");
  return data;
}

export async function rpc(action, args = {}) {
  if (
    typeof action !== "string" ||
    !action ||
    !args ||
    typeof args !== "object" ||
    Array.isArray(args)
  )
    throw new Error("命令需要 action 字符串和 args 对象。");
  const { port, token } = await readDiscovery();
  const body = Buffer.from(JSON.stringify({ action, args }));
  if (body.byteLength > 64 * 1024 * 1024)
    throw new Error("自动化请求超过 64 MB，请缩小图片或拆分命令。");
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/rpc",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": body.byteLength,
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy();
            reject(new Error("编辑器返回的数据过大，请导出较小尺寸。"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", () =>
          reject(new Error("读取编辑器结果失败，请检查桌面应用是否仍在运行。")),
        );
        response.on("end", () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (response.statusCode !== 200 || payload.error) {
              reject(
                new Error(
                  typeof payload.error === "string"
                    ? payload.error
                    : `自动化请求失败，HTTP ${response.statusCode}`,
                ),
              );
              return;
            }
            resolve(payload.result);
          } catch {
            reject(new Error("编辑器返回了无效的 JSON 数据。"));
          }
        });
      },
    );
    request.setTimeout(35_000, () =>
      request.destroy(
        new Error("自动化请求超时，请检查桌面应用是否正在等待操作。"),
      ),
    );
    request.on("error", (error) =>
      reject(
        new Error(
          error.message.startsWith("自动化")
            ? error.message
            : "无法连接 Compositor Windows。请启动或重新启动桌面应用，并确认发现文件属于当前实例。",
        ),
      ),
    );
    request.end(body);
  });
}

export async function openImage(filename, call = rpc, options = {}) {
  if (typeof filename !== "string" || !filename.trim())
    throw new Error("请提供要打开的图片路径。");
  const absolute = path.resolve(filename);
  let stat;
  try {
    stat = await fs.lstat(absolute);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`图片文件不存在：${absolute}`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("图片路径必须指向普通文件。");
  if (stat.size > MAX_INPUT_FILE_BYTES)
    throw new Error("通过自动化打开的文件不能超过 45 MB。");
  const data = await fs.readFile(absolute);
  if (data.length > MAX_INPUT_FILE_BYTES)
    throw new Error("通过自动化打开的文件不能超过 45 MB。");
  const args = {
    name: path.basename(absolute),
    base64: data.toString("base64"),
  };
  if (options.asLayer) {
    for (const coordinate of ["x", "y"])
      if (options[coordinate] !== undefined) {
        if (!Number.isFinite(options[coordinate]))
          throw new Error(`${coordinate} 必须为有限数字。`);
        args[coordinate] = options[coordinate];
      }
    args.scaleToFit = true;
  }
  return call(options.asLayer ? "place_image" : "open_image", args);
}

export function decodeImageData(result) {
  if (
    !result ||
    typeof result.base64 !== "string" ||
    result.base64.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(result.base64) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(result.base64)
  )
    throw new Error("编辑器未返回有效的 base64 文件。");
  const data = Buffer.from(result.base64, "base64");
  if (data.length > 256 * 1024 * 1024)
    throw new Error("导出文件不能超过 256 MB。");
  return data;
}

export async function renameWithRetry(source, destination, options = {}) {
  const rename = options.rename || fs.rename;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const delays = [20, 50, 100, 200, 400];
  for (let attempt = 0; ; attempt++) {
    try { return await rename(source, destination); }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= delays.length) throw error;
      await sleep(delays[attempt]);
    }
  }
}

export async function writeOutput(filename, data) {
  if (typeof filename !== "string" || !filename.trim())
    throw new Error("请提供输出文件路径。");
  const absolute = path.resolve(filename);
  let existing;
  try {
    existing = await fs.lstat(absolute);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error("输出路径必须是普通文件，不能是目录或符号链接。");
  const temporary = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(temporary, absolute);
    return { path: absolute, bytes: data.byteLength };
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(`输出文件夹不存在：${path.dirname(absolute)}`);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

export async function exportImage(filename, format = "png", call = rpc) {
  if (!EXPORT_FORMATS.includes(format))
    throw new Error("导出格式仅支持 png、jpeg、psd、cwdoc。");
  const result = await call("export", { format });
  return { ...(await writeOutput(filename, decodeImageData(result))), format };
}

export async function saveCanvas(filename, maxSize = 1200, call = rpc) {
  if (!Number.isFinite(maxSize) || maxSize < 64 || maxSize > 2048)
    throw new Error("画布预览 maxSize 应在 64 到 2048 之间。");
  const result = await call("get_canvas", { maxSize });
  return {
    ...(await writeOutput(filename, decodeImageData(result))),
    width: result.width,
    height: result.height,
    mimeType: result.mimeType,
  };
}
