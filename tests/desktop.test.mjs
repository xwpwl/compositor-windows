import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  projectRelativePath,
  validateProjectFiles,
  allowedRendererURL,
  validatedDevURL,
  readProjectFolder,
  atomicWriteFile,
  atomicWriteProject,
  isWithin,
  renameWithRetry,
} = require("../electron/files.cjs");
const {
  authorizedRequest,
  validateRPC,
  createAutomationBridge,
} = require("../electron/automation.cjs");
const bytes = (value) => new TextEncoder().encode(value);
const scratch = path.resolve("work", "desktop-tests");
await fs.mkdir(scratch, { recursive: true });

test("rename retries only transient Windows errors with a bounded schedule", async () => {
  const delays = [];
  let attempts = 0;
  await renameWithRetry("source", "destination", {
    rename: async () => {
      attempts++;
      if (attempts <= 5) throw Object.assign(new Error("Scanner holds file"), { code: ["EPERM", "EBUSY", "EACCES"][(attempts - 1) % 3] });
    },
    sleep: async milliseconds => { delays.push(milliseconds); },
  });
  assert.equal(attempts, 6);
  assert.deepEqual(delays, [20, 50, 100, 200, 400]);
  for (const code of ["EPERM", "ENOENT", "ENOSPC"]) {
    attempts = 0;
    const waits = [];
    await assert.rejects(renameWithRetry("source", "destination", {
      rename: async () => { attempts++; throw Object.assign(new Error(code), { code }); },
      sleep: async milliseconds => { waits.push(milliseconds); },
    }), error => error.code === code);
    assert.equal(attempts, code === "EPERM" ? 6 : 1);
    assert.equal(waits.length, code === "EPERM" ? 5 : 0);
  }
});

test("project replacement survives transient scanner locks and rolls back a permanent commit failure", async t => {
  const root = await fs.mkdtemp(path.join(scratch, "rename-recovery-"));
  const project = path.join(root, "sample.comp");
  const originalRename = fs.rename;
  let renameMock;
  try {
    await atomicWriteProject(project, { "manifest.json": bytes("original") });
    let remainingLocks = 2;
    renameMock = t.mock.method(fs, "rename", async (source, destination) => {
      if (source === project && remainingLocks-- > 0) throw Object.assign(new Error("Scanner holds directory"), { code: "EPERM" });
      return originalRename(source, destination);
    });
    await atomicWriteProject(project, { "manifest.json": bytes("updated") });
    assert.equal(await fs.readFile(path.join(project, "manifest.json"), "utf8"), "updated");
    renameMock.mock.restore();
    let commitAttempts = 0;
    let rollbackLocks = 2;
    renameMock = t.mock.method(fs, "rename", async (source, destination) => {
      if (source.endsWith(".tmp") && destination === project) { commitAttempts++; throw Object.assign(new Error("Commit remains locked"), { code: "EACCES" }); }
      if (source.endsWith(".backup") && rollbackLocks-- > 0) throw Object.assign(new Error("Backup temporarily locked"), { code: "EBUSY" });
      return originalRename(source, destination);
    });
    await assert.rejects(atomicWriteProject(project, { "manifest.json": bytes("must-not-replace") }), error => error.code === "EACCES");
    assert.equal(commitAttempts, 6);
    assert.equal(await fs.readFile(path.join(project, "manifest.json"), "utf8"), "updated");
    assert.deepEqual(await fs.readdir(root), ["sample.comp"]);
  } finally {
    renameMock?.mock.restore();
    if (!isWithin(scratch, root)) throw new Error("Unexpected temporary test path");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ordinary atomic file saves retry locks while permanent errors preserve prior data", async t => {
  const root = await fs.mkdtemp(path.join(scratch, "file-recovery-"));
  const filename = path.join(root, "image.png");
  const originalRename = fs.rename;
  let renameMock;
  try {
    await fs.writeFile(filename, "original");
    let remainingLocks = 2;
    renameMock = t.mock.method(fs, "rename", async (source, destination) => {
      if (destination === filename && remainingLocks-- > 0) throw Object.assign(new Error("Temporary lock"), { code: "EBUSY" });
      return originalRename(source, destination);
    });
    await atomicWriteFile(filename, bytes("updated"));
    assert.equal(await fs.readFile(filename, "utf8"), "updated");
    renameMock.mock.restore();
    renameMock = t.mock.method(fs, "rename", async () => { throw Object.assign(new Error("Disk full"), { code: "ENOSPC" }); });
    await assert.rejects(atomicWriteFile(filename, bytes("must-not-replace")), error => error.code === "ENOSPC");
    assert.equal(await fs.readFile(filename, "utf8"), "updated");
    assert.deepEqual(await fs.readdir(root), ["image.png"]);
  } finally {
    renameMock?.mock.restore();
    if (!isWithin(scratch, root)) throw new Error("Unexpected temporary test path");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("project files reject traversal, Windows aliases, collisions, and non-binary data", () => {
  for (const value of [
    "../secret",
    "/absolute",
    "C:/absolute",
    "C:\\absolute",
    "a\\..\\b",
    "a/../b",
    "a//b",
    "a/./b",
    "CON.txt",
    "a/PRN",
    "a/hidden.",
    "file:stream",
    "a/file ",
    "\\server\\share",
  ])
    assert.throws(() => projectRelativePath(value), value);
  assert.equal(projectRelativePath("layers/图层-1.png"), "layers/图层-1.png");
  assert.throws(() =>
    validateProjectFiles({ "one.png": bytes("a"), "ONE.png": bytes("b") }),
  );
  assert.throws(() =>
    validateProjectFiles({ layers: bytes("a"), "layers/a.png": bytes("b") }),
  );
  assert.throws(() => validateProjectFiles({ "a.png": "not bytes" }));
  assert.equal(
    validateProjectFiles({
      "manifest.json": bytes("{}"),
      "layers/a.png": bytes("image"),
    }).length,
    2,
  );
});

test("renderer navigation only allows packaged index or explicit loopback development origin", () => {
  const indexPath = path.resolve("dist/index.html");
  const url = pathToFileURL(indexPath).href;
  assert.equal(allowedRendererURL(url, { indexPath }), true);
  assert.equal(allowedRendererURL(`${url}#document`, { indexPath }), true);
  for (const raw of [
    "https://example.com",
    "javascript:alert(1)",
    "data:text/html,test",
    pathToFileURL(path.resolve("dist/other.html")).href,
    `${url}?other=1`,
  ])
    assert.equal(allowedRendererURL(raw, { indexPath }), false, raw);
  const devURL = validatedDevURL("http://127.0.0.1:5173");
  assert.equal(
    allowedRendererURL("http://127.0.0.1:5173/edit", { devURL }),
    true,
  );
  for (const raw of [
    "http://localhost:5173",
    "http://127.0.0.1:8000",
    "http://user@127.0.0.1:5173",
    "https://127.0.0.1:5173",
  ])
    assert.equal(allowedRendererURL(raw, { devURL }), false);
  for (const raw of [
    "http://localhost:5173",
    "https://127.0.0.1",
    "file:///index.html",
    "http://user@127.0.0.1",
  ])
    assert.throws(() => validatedDevURL(raw));
});

test("project saves replace contents safely and invalid saves preserve existing data", async () => {
  const root = await fs.mkdtemp(path.join(scratch, "compositor-desktop-"));
  try {
    const project = path.join(root, "sample.comp");
    await atomicWriteProject(project, {
      "manifest.json": bytes('{"version":1}'),
      "layers/a.png": bytes("original"),
    });
    const opened = await readProjectFolder(project);
    assert.equal(new TextDecoder().decode(opened.bytes), '{"version":1}');
    assert.equal(
      new TextDecoder().decode(opened.files["layers/a.png"]),
      "original",
    );
    await assert.rejects(
      atomicWriteProject(project, { "../escape": bytes("bad") }),
    );
    assert.equal(
      await fs.readFile(path.join(project, "layers/a.png"), "utf8"),
      "original",
    );
    await atomicWriteProject(project, {
      "manifest.json": bytes('{"version":2}'),
    });
    assert.deepEqual(await fs.readdir(project), ["manifest.json"]);
    assert.deepEqual(await fs.readdir(root), ["sample.comp"]);
    const target = path.join(root, "output.png");
    await atomicWriteFile(target, bytes("first"));
    await atomicWriteFile(target, bytes("second"));
    assert.equal(await fs.readFile(target, "utf8"), "second");
    assert.deepEqual((await fs.readdir(root)).sort(), [
      "output.png",
      "sample.comp",
    ]);
  } finally {
    if (!isWithin(scratch, root))
      throw new Error("Unexpected temporary test path");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("folder import refuses symbolic links", async (t) => {
  const root = await fs.mkdtemp(path.join(scratch, "compositor-links-"));
  try {
    await fs.mkdir(path.join(root, "source"));
    await fs.writeFile(path.join(root, "source", "document.json"), "{}");
    try {
      await fs.symlink(
        path.join(root, "source"),
        path.join(root, "link"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error.code)) {
        t.skip("Windows symbolic-link privilege unavailable");
        return;
      }
      throw error;
    }
    await assert.rejects(readProjectFolder(root), /符号链接/);
  } finally {
    if (!isWithin(scratch, root))
      throw new Error("Unexpected temporary test path");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("automation requires bearer token, exact loopback host, no browser Origin, and structured commands", () => {
  const token = "local-token";
  const headers = { authorization: `Bearer ${token}`, host: "127.0.0.1:1234" };
  assert.equal(authorizedRequest({ headers }, token, 1234), true);
  for (const patch of [
    { authorization: "Bearer wrong" },
    { origin: "http://127.0.0.1" },
    { origin: "null" },
    { host: "attacker.test:1234" },
  ])
    assert.equal(
      authorizedRequest({ headers: { ...headers, ...patch } }, token, 1234),
      false,
    );
  assert.deepEqual(validateRPC({ action: "document.info" }), {
    action: "document.info",
    args: {},
  });
  for (const payload of [
    null,
    [],
    { action: "eval(1)" },
    { action: "open", args: [] },
    { action: "open", args: null },
  ])
    assert.throws(() => validateRPC(payload));
});

test("automation discovery and HTTP RPC round trip clean up on disposal", async () => {
  const root = await fs.mkdtemp(path.join(scratch, "compositor-rpc-"));
  const previous = process.env.COMPOSITOR_AUTOMATION_FILE;
  delete process.env.COMPOSITOR_AUTOMATION_FILE;
  let bridge;
  try {
    bridge = createAutomationBridge({
      app: { getPath: () => root },
      getWindow: () => ({
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (_channel, request) =>
            queueMicrotask(() =>
              bridge.reply({
                id: request.id,
                result: { received: request.action, ...request.args },
              }),
            ),
        },
      }),
    });
    await bridge.start();
    const discovery = JSON.parse(
      await fs.readFile(bridge.discoveryPath, "utf8"),
    );
    assert.equal(discovery.token.length, 64);
    assert.equal(discovery.pid, process.pid);
    const url = `http://127.0.0.1:${discovery.port}/rpc`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${discovery.token}`,
    };
    const result = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "document.info", args: { value: 7 } }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), {
      result: { received: "document.info", value: 7 },
    });
    const rejected = await fetch(url, {
      method: "POST",
      headers: { ...headers, Origin: "http://evil.test" },
      body: "{}",
    });
    assert.equal(rejected.status, 403);
    const invalid = await fetch(url, { method: "POST", headers, body: "{" });
    assert.equal(invalid.status, 400);
    await bridge.dispose();
    await assert.rejects(fs.access(bridge.discoveryPath));
  } finally {
    await bridge?.dispose();
    if (previous === undefined) delete process.env.COMPOSITOR_AUTOMATION_FILE;
    else process.env.COMPOSITOR_AUTOMATION_FILE = previous;
    if (!isWithin(scratch, root))
      throw new Error("Unexpected temporary test path");
    await fs.rm(root, { recursive: true, force: true });
  }
});
