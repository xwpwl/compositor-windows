#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const SKILL_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = new Set([
  "compositor_get_state",
  "compositor_get_canvas",
  "compositor_edit",
  "compositor_open_image",
  "compositor_export",
]);
const PROTOCOL = "2025-06-18";
const MAX_ARGS_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_CHARACTERS = 96 * 1024 * 1024;
const TIMEOUT_GUIDANCE = "请先调用 compositor_get_state 并查看画布核对结果；操作可能已经执行，不要直接重试变更。";

const HELP = `Compositor Windows skill MCP client

Usage:
  node scripts/mcp-client.mjs --list-tools [--result-path NEW.json]
  node scripts/mcp-client.mjs --tool compositor_get_state [--result-path NEW.json]
  node scripts/mcp-client.mjs --tool compositor_get_canvas --image-path NEW.png
  node scripts/mcp-client.mjs --tool TOOL --args-file INPUT.json

Options:
  --tool NAME          One of compositor_get_state, compositor_get_canvas,
                       compositor_edit, compositor_open_image, compositor_export.
  --list-tools         Initialize MCP and list available tools.
  --args-file PATH     UTF-8 JSON object, optionally with a UTF-8 BOM.
  --image-path PATH    Required for get_canvas; a NEW .png file in an existing directory.
  --result-path PATH   Save the parsed JSON result to a NEW file; stdout reports its path.
  --app-dir PATH       Override COMPOSITOR_APP_DIR and skill local-config.json appDirectory.
  --help, -h           Show this help.

Start the desktop editor separately. This client never opens the GUI, never retries
an edit, never reads or prints authentication tokens, and closes only its own MCP
bridge process. Existing image/result files are never overwritten. The bridge
inherits COMPOSITOR_AUTOMATION_FILE for explicitly isolated test instances.
`;

export function parseOptions(argv) {
  const result = {};
  const valueFlags = new Map([
    ["--tool", "tool"], ["--args-file", "argsFile"], ["--image-path", "imagePath"],
    ["--result-path", "resultPath"], ["--app-dir", "appDir"],
  ]);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      if (argv.length !== 1) throw new Error("--help 不能与其他参数同时使用。");
      return { help: true };
    }
    if (flag === "--list-tools") {
      if (result.listTools) throw new Error("--list-tools 不能重复。");
      result.listTools = true;
      continue;
    }
    const key = valueFlags.get(flag);
    if (!key) throw new Error(`未知参数：${flag}。运行 --help 查看用法。`);
    if (result[key] !== undefined) throw new Error(`${flag} 不能重复。`);
    const value = argv[++index];
    if (typeof value !== "string" || !value.trim() || value.startsWith("--") || value.includes("\0")) throw new Error(`${flag} 缺少有效参数值。`);
    result[key] = value;
  }
  if (Boolean(result.listTools) === Boolean(result.tool)) throw new Error("必须且只能指定 --list-tools 或 --tool。");
  if (result.tool && !TOOLS.has(result.tool)) throw new Error(`不支持的工具：${result.tool}。只允许 Compositor 的五个工具。`);
  if (result.listTools && (result.argsFile || result.imagePath)) throw new Error("--list-tools 不接受 --args-file 或 --image-path。");
  if (result.tool === "compositor_get_canvas" && !result.imagePath) throw new Error("compositor_get_canvas 必须指定 --image-path，以保存可查看的 PNG。不会把 base64 输出到终端。");
  if (result.imagePath && result.tool !== "compositor_get_canvas") throw new Error("--image-path 只能与 compositor_get_canvas 一起使用。");
  if (result.imagePath && path.extname(result.imagePath).toLowerCase() !== ".png") throw new Error("--image-path 必须使用 .png 扩展名。");
  if (result.imagePath && result.resultPath && path.resolve(result.imagePath).toLowerCase() === path.resolve(result.resultPath).toLowerCase()) throw new Error("图像路径与 JSON 结果路径不能相同。");
  return result;
}

async function readObject(filename, label, maxBytes) {
  let stat;
  try { stat = await fs.lstat(filename); }
  catch (error) { if (error.code === "ENOENT") throw new Error(`${label}不存在：${filename}`); throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}必须是普通文件：${filename}`);
  if (stat.size > maxBytes) throw new Error(`${label}超过允许大小：${maxBytes} 字节。`);
  const bytes = await fs.readFile(filename);
  if (bytes.byteLength > maxBytes) throw new Error(`${label}超过允许大小。`);
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "")); }
  catch { throw new Error(`${label}必须是有效的 UTF-8 JSON 对象。`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是 JSON 对象，不能是数组或 null。`);
  return value;
}

async function resolveApplication(options) {
  let supplied = options.appDir || process.env.COMPOSITOR_APP_DIR;
  if (!supplied) {
    const config = await readObject(path.join(SKILL_DIRECTORY, "local-config.json"), "skill 本机配置", 64 * 1024);
    if (typeof config.appDirectory !== "string" || !config.appDirectory.trim()) throw new Error("local-config.json 缺少 appDirectory；也可以显式传 --app-dir。");
    supplied = path.resolve(SKILL_DIRECTORY, config.appDirectory);
  }
  const directory = path.resolve(supplied);
  const server = path.join(directory, "scripts", "mcp-server.mjs");
  let stat;
  try { stat = await fs.stat(server); }
  catch { throw new Error(`找不到应用的 MCP 桥接脚本：${server}。请检查 --app-dir / COMPOSITOR_APP_DIR / local-config.json。`); }
  if (!stat.isFile()) throw new Error(`MCP 桥接路径不是文件：${server}`);
  const packagedRuntime = path.join(directory, "Compositor Windows.exe");
  let runtime = process.execPath;
  try { if ((await fs.stat(packagedRuntime)).isFile()) runtime = packagedRuntime; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return { directory, server, runtime };
}

async function reserveOutput(filename, label) {
  const absolute = path.resolve(filename);
  const parent = path.dirname(absolute);
  let parentStat;
  try { parentStat = await fs.stat(parent); }
  catch { throw new Error(`${label}的父目录不存在或不可访问：${parent}`); }
  if (!parentStat.isDirectory()) throw new Error(`${label}的父路径不是目录：${parent}`);
  let handle;
  try { handle = await fs.open(absolute, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`${label}已经存在，拒绝覆盖：${absolute}。请选择新路径。`);
    throw new Error(`无法预留${label}：${absolute}（${error.code || "文件系统错误"}）。`);
  }
  const identity = await handle.stat();
  return { path: absolute, handle, identity, committed: false };
}

async function commitOutput(reservation, contents) {
  await reservation.handle.writeFile(contents);
  await reservation.handle.sync();
  await reservation.handle.close();
  reservation.handle = null;
  reservation.committed = true;
}

async function cleanReservation(reservation) {
  if (!reservation) return;
  await reservation.handle?.close().catch(() => {});
  if (reservation.committed) return;
  // Remove only the new file this invocation reserved, never a pre-existing file.
  try {
    const current = await fs.lstat(reservation.path);
    if (current.isFile() && current.dev === reservation.identity.dev && current.ino === reservation.identity.ino) await fs.unlink(reservation.path);
  } catch (error) { if (error.code !== "ENOENT") process.stderr.write(`未能清理本次预留文件：${reservation.path}\n`); }
}

function startBridge(application) {
  const child = spawn(application.runtime, [application.server], {
    cwd: application.directory,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 1;
  let buffer = "";
  let diagnosticBytes = 0;
  let failure;
  let closing = false;
  let exited = false;
  const pending = new Map();
  let resolveExit;
  const exit = new Promise(resolve => { resolveExit = resolve; });
  const fail = error => {
    if (failure) return;
    failure = error;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    if (failure || closing) return;
    buffer += chunk;
    if (buffer.length > MAX_RESPONSE_CHARACTERS) { fail(new Error("MCP 响应超过客户端大小限制。")); return; }
    for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { fail(new Error("MCP 桥接输出了无效 JSON；未把诊断内容当作成功结果。")); return; }
      if (!message || message.jsonrpc !== "2.0" || typeof message !== "object") { fail(new Error("MCP 响应格式无效。")); return; }
      if (message.id === undefined && typeof message.method === "string") continue;
      const entry = pending.get(message.id);
      if (!entry) { fail(new Error("MCP 返回了不匹配的请求编号。")); return; }
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`MCP 协议错误 ${message.error.code ?? ""}：${String(message.error.message || "请求失败")}`));
      else if (!("result" in message)) entry.reject(new Error("MCP 响应缺少 result。"));
      else entry.resolve(message.result);
    }
  });
  // Diagnostics are counted but never copied to stdout or echoed wholesale;
  // credentials are owned by the existing bridge, not this helper.
  child.stderr.on("data", chunk => { diagnosticBytes += chunk.length; });
  child.on("error", error => { fail(new Error(`无法启动本次 MCP 桥接：${error.message}`)); exited = true; resolveExit(); });
  child.on("close", code => {
    exited = true;
    resolveExit();
    if (!closing) fail(new Error(`本次 MCP 桥接提前退出（退出码 ${code ?? "未知"}${diagnosticBytes ? "，有诊断输出" : ""}）。`));
  });
  child.stdin.on("error", () => { if (!closing) fail(new Error("MCP 桥接输入管道已关闭。")); });
  const killOnExit = () => { if (!exited) child.kill(); };
  const interrupt = () => fail(new Error(`请求已中断。${TIMEOUT_GUIDANCE}`));
  process.once("exit", killOnExit);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  function request(method, params, timeoutMs = 40_000) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new Error(`MCP ${method} 请求超时。${TIMEOUT_GUIDANCE}`);
        reject(error);
        fail(error);
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", error => { if (error) fail(new Error("无法向 MCP 桥接发送请求。")); });
    });
  }

  async function notification(method) {
    if (failure) throw failure;
    await new Promise((resolve, reject) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n", error => error ? reject(new Error("无法完成 MCP 初始化通知。")) : resolve()));
  }

  async function close() {
    closing = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("本次桥接已关闭。")); }
    pending.clear();
    child.stdin.end();
    let timeout;
    await Promise.race([exit, new Promise(resolve => { timeout = setTimeout(resolve, 800); })]);
    clearTimeout(timeout);
    if (!exited) {
      child.kill();
      let killTimeout;
      await Promise.race([exit, new Promise(resolve => { killTimeout = setTimeout(resolve, 800); })]);
      clearTimeout(killTimeout);
    }
    process.removeListener("exit", killOnExit);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  return { request, notification, close };
}

function toolError(result) {
  if (!result || !Array.isArray(result.content)) throw new Error("MCP 工具未返回有效的 content 列表。");
  if (result.isError) {
    const detail = result.content.filter(item => item?.type === "text").map(item => String(item.text || "")).join("\n");
    const suffix = /超时|timeout|timed out/i.test(detail) ? `\n${TIMEOUT_GUIDANCE}` : "";
    throw new Error(`Compositor 工具失败：${detail || "未知错误"}${suffix}`);
  }
}

function parseTextResult(result) {
  if (result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)) return result.structuredContent;
  const blocks = result.content.filter(item => item?.type === "text");
  if (blocks.length !== 1 || result.content.some(item => item?.type !== "text")) throw new Error("工具应返回单个 JSON 文本结果，但实际格式不同。");
  let parsed;
  try { parsed = JSON.parse(blocks[0].text); }
  catch { throw new Error("工具返回的文本不是有效 JSON。未把它当作文档状态保存。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("工具应返回 JSON 对象，实际结果不是文档状态或导出信息。");
  return parsed;
}

function canvasBytes(result) {
  const images = result.content.filter(item => item?.type === "image");
  if (images.length !== 1 || images[0].mimeType !== "image/png" || typeof images[0].data !== "string") throw new Error("画布工具没有返回单个 PNG 图像。");
  const encoded = images[0].data;
  if (encoded.length > 90 * 1024 * 1024 || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) throw new Error("画布图像编码无效或过大。");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("画布结果不是有效的 PNG 数据。");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 2048 || height > 2048) throw new Error("画布预览尺寸超出约定的 2048 像素限制。");
  return { bytes, width, height };
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) return HELP;
  const args = options.argsFile ? await readObject(path.resolve(options.argsFile), "工具参数文件", MAX_ARGS_BYTES) : {};
  const application = await resolveApplication(options);
  let imageOutput, resultOutput, bridge;
  let toolCompleted = false;
  try {
    // All output paths are reserved before a bridge is started or any tool is called.
    if (options.imagePath) imageOutput = await reserveOutput(options.imagePath, "预览文件");
    if (options.resultPath) resultOutput = await reserveOutput(options.resultPath, "结果文件");
    bridge = startBridge(application);
    const initialized = await bridge.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "compositor-windows-skill-cli", version: "1.0.0" } }, 15_000);
    if (!initialized || initialized.protocolVersion !== PROTOCOL || !initialized.capabilities?.tools) throw new Error("MCP 协议版本或工具能力与客户端不兼容。");
    await bridge.notification("notifications/initialized");
    const listing = await bridge.request("tools/list", {}, 15_000);
    if (!listing || !Array.isArray(listing.tools) || listing.tools.some(tool => !tool || typeof tool.name !== "string")) throw new Error("MCP 工具列表格式无效。");
    let output;
    if (options.listTools) output = { tools: listing.tools };
    else {
      if (!listing.tools.some(tool => tool.name === options.tool)) throw new Error(`当前桥接未提供工具：${options.tool}`);
      const result = await bridge.request("tools/call", { name: options.tool, arguments: args });
      toolError(result);
      toolCompleted = true;
      if (options.tool === "compositor_get_canvas") {
        const image = canvasBytes(result);
        await commitOutput(imageOutput, image.bytes);
        output = { imagePath: imageOutput.path, mimeType: "image/png", width: image.width, height: image.height, bytes: image.bytes.length };
      } else output = parseTextResult(result);
    }
    if (resultOutput) {
      await commitOutput(resultOutput, JSON.stringify(output, null, 2) + "\n");
      return { resultPath: resultOutput.path, ...(imageOutput ? { imagePath: imageOutput.path } : {}), ...(options.listTools ? { tools: listing.tools.map(tool => tool.name) } : { tool: options.tool }) };
    }
    return output;
  } catch (error) {
    if (toolCompleted && options.tool && !["compositor_get_state", "compositor_get_canvas"].includes(options.tool)) throw new Error(`${error.message}\n工具已返回成功；后续处理失败不代表编辑已回滚。${TIMEOUT_GUIDANCE}`, { cause: error });
    throw error;
  } finally {
    await bridge?.close();
    await cleanReservation(imageOutput);
    await cleanReservation(resultOutput);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().then(result => process.stdout.write(typeof result === "string" ? result : JSON.stringify(result, null, 2) + "\n")).catch(error => {
    process.stderr.write(`Compositor: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
