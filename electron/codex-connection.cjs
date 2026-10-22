"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const TOOL_NAMES = [
  "compositor_edit",
  "compositor_export",
  "compositor_get_canvas",
  "compositor_get_state",
  "compositor_open_image",
];

// Probe only the bundled bridge. Never execute a command obtained from user TOML.
// A successful probe proves the local bridge works, not that Codex reloaded it.
async function checkCodexConnection({ executablePath, appDirectory, discoveryPath,
  env = process.env, timeoutMs = 20000 }) {
  const child = spawn(executablePath, [path.join(appDirectory, "scripts", "mcp-server.mjs")], {
    cwd: appDirectory,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1", COMPOSITOR_AUTOMATION_FILE: discoveryPath },
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let sequence = 0, buffered = "", received = 0, exited = false, failure;
  const pending = new Map();
  function fail(error) {
    failure ||= error;
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
  }
  const exit = new Promise(resolve => {
    child.once("error", () => {
      fail(new Error("无法启动本地 MCP 桥接，请检查安装目录是否完整。"));
      resolve();
    });
    child.once("close", () => {
      exited = true;
      fail(new Error("本地 MCP 桥接已退出，请重试连接检测。"));
      resolve();
    });
  });
  child.stdin.on("error", () => fail(new Error("无法向本地 MCP 桥接发送请求。")));
  // Drain stderr without returning runtime logs or environment data to the UI.
  child.stderr.on("data", () => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    received += Buffer.byteLength(chunk);
    if (received > 8 * 1024 * 1024) {
      fail(new Error("连接检测返回的数据超出限制。"));
      child.kill();
      return;
    }
    buffered += chunk;
    let index;
    while ((index = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (!line) continue;
      let response;
      try { response = JSON.parse(line); }
      catch { fail(new Error("本地 MCP 桥接返回了无效响应。")); return; }
      const waiter = pending.get(response.id);
      if (!waiter) continue;
      pending.delete(response.id);
      if (response.error || response.result === undefined)
        waiter.reject(new Error("本地 MCP 协议检查失败。"));
      else waiter.resolve(response.result);
    }
  });
  const timer = setTimeout(() => {
    fail(new Error("连接检测超时，请等待当前编辑完成后重试。"));
    child.kill();
  }, timeoutMs);
  const send = (method, params) => {
    if (failure) return Promise.reject(failure);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  try {
    const initialized = await send("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "compositor-connection-check", version: "0.1.1" },
    });
    if (!initialized.capabilities?.tools) throw new Error("本地桥接没有提供编辑工具。");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = await send("tools/list", {});
    const names = list.tools?.map(tool => tool.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(TOOL_NAMES))
      throw new Error("本地 MCP 工具不完整，请修复安装后重试。");
    const result = await send("tools/call", { name: "compositor_get_state", arguments: {} });
    if (result.isError) throw new Error("MCP 已启动，但无法读取编辑器。请等待画布就绪后重试。");
    let state;
    try { state = JSON.parse(result.content?.find(item => item.type === "text")?.text); }
    catch { throw new Error("编辑器状态检查失败。"); }
    if (!state?.document || !Array.isArray(state.document.layers))
      throw new Error("编辑器尚未准备好文档状态。");
    const canvas = await send("tools/call", { name: "compositor_get_canvas", arguments: { maxSize: 96 } });
    const preview = canvas.content?.find(item => item.type === "image" && item.mimeType === "image/png");
    if (canvas.isError || typeof preview?.data !== "string" ||
        !Buffer.from(preview.data, "base64").subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error("状态读取成功，但画布预览检查失败。请等待画布就绪后重试。");
    return {
      ok: true,
      toolCount: names.length,
      documentName: String(state.document.name || "未命名"),
      message: "本地连接正常：5 个工具、文档状态和画布预览均可用。请在 Codex 中重新加载连接或重启 Codex 后开始修图。",
    };
  } finally {
    clearTimeout(timer);
    pending.clear();
    child.stdin.end();
    if (!exited) child.kill(); // Only the short-lived bridge spawned above.
    let exitTimer;
    await Promise.race([exit, new Promise(resolve => { exitTimer = setTimeout(resolve, 2000); })]);
    clearTimeout(exitTimer);
  }
}

module.exports = { checkCodexConnection };
