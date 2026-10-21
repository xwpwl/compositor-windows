"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { renameWithRetry } = require("./files.cjs");

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const RPC_TIMEOUT_MS = 30_000;

function authorizedRequest(request, token, port) {
  if (request.headers.origin !== undefined) return false;
  if (request.headers.host !== `127.0.0.1:${port}`) return false;
  const supplied = request.headers.authorization;
  if (typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(`Bearer ${token}`);
  const suppliedBytes = Buffer.from(supplied);
  return (
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

function validateRPC(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload.action !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,99}$/.test(payload.action)
  )
    throw new Error("action 必须是有效的命令名。");
  if (
    payload.args !== undefined &&
    (!payload.args ||
      typeof payload.args !== "object" ||
      Array.isArray(payload.args))
  )
    throw new Error("args 必须是对象。");
  return { action: payload.action, args: payload.args || {} };
}

function createAutomationBridge({ app, getWindow }) {
  const token = randomBytes(32).toString("hex");
  const discoveryPath = process.env.COMPOSITOR_AUTOMATION_FILE
    ? path.resolve(process.env.COMPOSITOR_AUTOMATION_FILE)
    : path.join(app.getPath("userData"), "automation.json");
  const pending = new Map();
  let server;
  let port;
  let disposed = false;

  const sendJSON = (response, status, value) => {
    if (response.destroyed || response.writableEnded) return;
    let body;
    try {
      body = JSON.stringify(value);
    } catch {
      status = 500;
      body = JSON.stringify({ error: "命令结果无法序列化。" });
    }
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  };

  function settle(id, result, error, status = 200) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timeout);
    sendJSON(
      entry.response,
      error ? (status === 200 ? 400 : status) : 200,
      error
        ? { error: String(error) }
        : { result: result === undefined ? null : result },
    );
    return true;
  }

  async function start() {
    if (server || disposed) return discoveryPath;
    server = http.createServer(async (request, response) => {
      if (!authorizedRequest(request, token, port)) {
        sendJSON(response, 403, { error: "未经授权的本地自动化请求。" });
        request.resume();
        return;
      }
      if (request.method !== "POST" || request.url !== "/rpc") {
        sendJSON(response, 405, { error: "仅支持 POST /rpc。" });
        request.resume();
        return;
      }
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          request.headers["content-type"] || "",
        )
      ) {
        sendJSON(response, 415, {
          error: "Content-Type 必须是 application/json。",
        });
        request.resume();
        return;
      }
      if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) {
        sendJSON(response, 413, { error: "请求不能超过 64 MB。" });
        request.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      let oversized = false;
      try {
        for await (const chunk of request) {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            oversized = true;
            sendJSON(response, 413, { error: "请求不能超过 64 MB。" });
            break;
          }
          chunks.push(chunk);
        }
        if (oversized || response.destroyed) return;
        const payload = validateRPC(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        const window = getWindow();
        if (
          !window ||
          window.isDestroyed() ||
          window.webContents.isDestroyed()
        ) {
          sendJSON(response, 503, { error: "编辑器尚未就绪。" });
          return;
        }
        if (pending.size >= 16) {
          sendJSON(response, 429, { error: "自动化命令过多，请稍后重试。" });
          return;
        }
        const id = randomUUID();
        const timeout = setTimeout(
          () => settle(id, null, "自动化命令执行超过 30 秒。", 504),
          RPC_TIMEOUT_MS,
        );
        pending.set(id, { response, timeout });
        response.on("close", () => {
          const entry = pending.get(id);
          if (entry) {
            clearTimeout(entry.timeout);
            pending.delete(id);
          }
        });
        window.webContents.send("automation:request", { id, ...payload });
      } catch (error) {
        sendJSON(response, 400, { error: `自动化请求无效：${error.message}` });
      }
    });
    server.requestTimeout = RPC_TIMEOUT_MS;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 1000;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    port = server.address().port;
    await fs.mkdir(path.dirname(discoveryPath), { recursive: true });
    const temp = `${discoveryPath}.${process.pid}.tmp`;
    await fs.writeFile(
      temp,
      JSON.stringify({ port, token, pid: process.pid }, null, 2),
      { mode: 0o600 },
    );
    await renameWithRetry(temp, discoveryPath);
    return discoveryPath;
  }

  function reply(payload) {
    if (!payload || typeof payload.id !== "string" || !pending.has(payload.id))
      throw new Error("自动化请求已经结束或不存在。");
    return settle(payload.id, payload.result, payload.error);
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    for (const id of pending.keys()) settle(id, null, "编辑器已关闭。", 503);
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      const saved = JSON.parse(await fs.readFile(discoveryPath, "utf8"));
      if (saved.pid === process.pid && saved.token === token)
        await fs.unlink(discoveryPath);
    } catch (error) {
      if (error.code !== "ENOENT")
        console.warn("自动化发现文件清理失败：", error.message);
    }
  }

  return { start, reply, dispose, discoveryPath };
}

module.exports = {
  createAutomationBridge,
  authorizedRequest,
  validateRPC,
  MAX_BODY_BYTES,
  RPC_TIMEOUT_MS,
};
