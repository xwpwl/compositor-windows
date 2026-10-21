"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { fileURLToPath } = require("node:url");

const LIMITS = Object.freeze({
  file: 256 * 1024 * 1024,
  total: 1024 * 1024 * 1024,
  count: 4096,
  depth: 32,
});

const RENAME_RETRY_DELAYS = Object.freeze([20, 50, 100, 200, 400]);
async function renameWithRetry(source, destination, options = {}) {
  const rename = options.rename || fs.rename;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(source, destination);
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= RENAME_RETRY_DELAYS.length) throw error;
      // Windows scanners can briefly hold an otherwise valid rename target.
      // Retrying never deletes the destination or falls back to a non-atomic copy.
      await sleep(RENAME_RETRY_DELAYS[attempt]);
    }
  }
}

function projectRelativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  )
    throw new Error("工程文件路径无效。");
  const parts = value.split("/");
  if (
    parts.length > LIMITS.depth ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.length > 255 ||
        /[<>:"|?*\x00-\x1f]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new Error("工程文件路径包含不安全的字符。");
  return parts.join("/");
}

function validateProjectFiles(files) {
  if (!files || typeof files !== "object" || Array.isArray(files))
    throw new Error("工程数据无效。");
  const entries = Object.entries(files);
  if (!entries.length || entries.length > LIMITS.count)
    throw new Error("工程文件数量超出限制。");
  let total = 0;
  const seen = new Set();
  for (const [name, bytes] of entries) {
    projectRelativePath(name);
    validateBytes(bytes);
    total += bytes.byteLength;
    if (total > LIMITS.total) throw new Error("工程总大小不能超过 1 GB。");
    const normalized = name.toLowerCase();
    if (seen.has(normalized))
      throw new Error("工程包含 Windows 下重名的文件。");
    seen.add(normalized);
  }
  for (const name of seen) {
    const segments = name.split("/");
    for (let i = 1; i < segments.length; i++)
      if (seen.has(segments.slice(0, i).join("/")))
        throw new Error("工程文件与文件夹名称冲突。");
  }
  return entries;
}

function validateBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength > LIMITS.file)
    throw new Error("文件必须是二进制数据，且不能超过 256 MB。");
  return value;
}

function suggestedName(value, fallback = "未命名") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  let name = value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "")
    .slice(0, 180);
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    name = fallback;
  return name;
}

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function allowedRendererURL(raw, options) {
  try {
    const url = new URL(raw);
    if (options.devURL) {
      const expected = new URL(options.devURL);
      return (
        expected.protocol === "http:" &&
        expected.hostname === "127.0.0.1" &&
        !expected.username &&
        !expected.password &&
        url.origin === expected.origin &&
        url.protocol === "http:" &&
        !url.username &&
        !url.password
      );
    }
    return (
      url.protocol === "file:" &&
      !url.host &&
      !url.search &&
      path.resolve(fileURLToPath(url)).toLowerCase() ===
        path.resolve(options.indexPath).toLowerCase()
    );
  } catch {
    return false;
  }
}

function validatedDevURL(value) {
  if (!value) return undefined;
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password
  )
    throw new Error("COMPOSITOR_DEV_URL 必须使用 http://127.0.0.1。");
  return url.href;
}

async function assertRegularFile(filename) {
  const stat = await fs.lstat(filename);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error("只能打开普通文件，不能打开符号链接。");
  if (stat.size > LIMITS.file) throw new Error("文件大小不能超过 256 MB。");
  return stat;
}

async function readSelectedFile(filename) {
  await assertRegularFile(filename);
  const bytes = await fs.readFile(filename);
  validateBytes(bytes);
  return {
    name: path.basename(filename),
    path: filename,
    bytes: new Uint8Array(bytes),
  };
}

async function readProjectFolder(folder) {
  const rootStat = await fs.lstat(folder);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("请选择普通的 .comp 工程文件夹。");
  const root = await fs.realpath(folder);
  const files = Object.create(null);
  let count = 0;
  let total = 0;
  async function walk(current, prefix, depth) {
    if (depth > LIMITS.depth) throw new Error("工程文件夹层级超出限制。");
    const items = await fs.readdir(current, { withFileTypes: true });
    if (items.length > LIMITS.count) throw new Error("工程文件数量超出限制。");
    for (const item of items) {
      if (++count > LIMITS.count) throw new Error("工程文件数量超出限制。");
      const relative = projectRelativePath(
        prefix ? `${prefix}/${item.name}` : item.name,
      );
      const filename = path.join(current, item.name);
      const stat = await fs.lstat(filename);
      if (stat.isSymbolicLink())
        throw new Error("工程文件夹不能包含符号链接。");
      const real = await fs.realpath(filename);
      if (!isWithin(root, real)) throw new Error("工程文件超出所选文件夹。");
      if (stat.isDirectory()) await walk(filename, relative, depth + 1);
      else if (stat.isFile()) {
        if (stat.size > LIMITS.file || total + stat.size > LIMITS.total)
          throw new Error("工程大小超出限制。");
        const bytes = await fs.readFile(filename);
        validateBytes(bytes);
        total += bytes.byteLength;
        if (total > LIMITS.total) throw new Error("工程总大小不能超过 1 GB。");
        files[relative] = new Uint8Array(bytes);
      } else throw new Error("工程文件夹包含不支持的特殊文件。");
    }
  }
  await walk(root, "", 0);
  if (!Object.keys(files).length) throw new Error("工程文件夹是空的。");
  return {
    name: path.basename(folder),
    path: folder,
    bytes: files["manifest.json"] || files["document.json"] || new Uint8Array(),
    files,
  };
}

async function existingStat(filename) {
  try {
    return await fs.lstat(filename);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWriteFile(filename, bytes) {
  validateBytes(bytes);
  const existing = await existingStat(filename);
  if (existing && (existing.isSymbolicLink() || !existing.isFile()))
    throw new Error("目标必须是普通文件。");
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(temporary, filename);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function atomicWriteProject(folder, files) {
  const entries = validateProjectFiles(files);
  const parent = path.resolve(path.dirname(folder));
  const destination = path.resolve(folder);
  const existing = await existingStat(destination);
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory()))
    throw new Error("工程目标必须是普通文件夹。");
  const id = randomUUID();
  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.${id}.tmp`,
  );
  const backup = path.join(
    parent,
    `.${path.basename(destination)}.${id}.backup`,
  );
  // Only these two exact, generated sibling directories may be removed recursively.
  const removeOwned = async (candidate) => {
    const resolved = path.resolve(candidate);
    if (resolved !== temporary && resolved !== backup)
      throw new Error("拒绝清理未知路径。");
    if (
      !isWithin(parent, resolved) ||
      resolved === parent ||
      resolved === destination
    )
      throw new Error("拒绝清理工程目标。");
    await fs.rm(resolved, { recursive: true, force: true });
  };
  let backedUp = false;
  let committed = false;
  try {
    await fs.mkdir(temporary, { mode: 0o700 });
    for (const [relative, bytes] of entries) {
      const filename = path.join(temporary, ...relative.split("/"));
      if (!isWithin(temporary, filename))
        throw new Error("工程路径超出目标文件夹。");
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
    }
    if (existing) {
      await renameWithRetry(destination, backup);
      backedUp = true;
    }
    try {
      await renameWithRetry(temporary, destination);
      committed = true;
    } catch (error) {
      if (backedUp) {
        try {
          await renameWithRetry(backup, destination);
        } catch (rollbackError) {
          throw new Error(`工程写入失败，自动恢复暂时失败。原工程仍完整保留在：${backup}`, { cause: rollbackError });
        }
        backedUp = false;
      }
      throw error;
    }
  } finally {
    if (!committed) await removeOwned(temporary).catch(() => {});
    if (committed && backedUp)
      await removeOwned(backup).catch((error) =>
        console.warn("旧工程备份未能清理：", error.message),
      );
  }
}

module.exports = {
  LIMITS,
  projectRelativePath,
  validateProjectFiles,
  validateBytes,
  suggestedName,
  isWithin,
  allowedRendererURL,
  validatedDevURL,
  readSelectedFile,
  readProjectFolder,
  atomicWriteFile,
  atomicWriteProject,
  existingStat,
  renameWithRetry,
  RENAME_RETRY_DELAYS,
};
