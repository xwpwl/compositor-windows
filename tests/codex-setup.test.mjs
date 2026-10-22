import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCodexSetup } = require("../electron/codex-setup.cjs");
const nativeFs = require("node:fs/promises");
const server = "compositor_windows";
const skill = "compositor-windows-edit";
const marker = "# test-registration=";

async function fixture(t, { legacy = false, customHome = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "compositor-setup-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "User with 空格");
  const appDirectory = path.join(root, "Apps & safe", "Compositor Windows");
  const codexHome = customHome ? path.join(root, "custom codex") : path.join(home, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  const source = path.join(appDirectory, "skills", skill);
  const executablePath = path.join(appDirectory, "Compositor Windows.exe");
  const codexExe = path.join(root, "codex.exe");
  const skillPath = path.join(legacy ? path.join(codexHome, "skills") : path.join(home, ".agents", "skills"), skill);
  for (const directory of [codexHome, path.join(source, "scripts"), path.join(appDirectory, "scripts")]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(codexExe, "fake executable");
  await fs.writeFile(executablePath, "fake executable");
  await fs.writeFile(path.join(appDirectory, "scripts", "mcp-server.mjs"), "// fixture");
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: compositor-windows-edit\ndescription: fixture\n---\nNew skill\n");
  await fs.writeFile(path.join(source, "scripts", "mcp-client.mjs"), "// fixture client\n");
  await fs.writeFile(path.join(source, "local-config.example.json"), '{}\n');
  if (legacy) {
    await fs.cp(source, skillPath, { recursive: true });
    await fs.writeFile(path.join(skillPath, "custom-notes.txt"), "My prior notes");
  }
  const initial = '# Preserve this comment\nmodel = "chosen-model"\napproval_policy = "on-request"\n[agents.foo]\nconfig_file = "agents/foo.toml"\n[mcp_servers.other]\ncommand = "other-command"\n';
  await fs.writeFile(configPath, initial);
  const calls = [];
  const transportUpdates = [];
  let failAdd = false;
  let onAdd;
  const expectedRegistration = { name: server, enabled: true, disabled_reason: null,
    transport: { type: "stdio", command: executablePath, args: [path.join(appDirectory, "scripts", "mcp-server.mjs")], env: { ELECTRON_RUN_AS_NODE: "1" } },
    enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null };
  const runner = async (request) => {
    calls.push(request);
    assert.equal(request.executable, codexExe);
    assert.equal(request.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(request.cwd, appDirectory);
    const file = path.join(request.env.CODEX_HOME, "config.toml");
    const contents = await fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    if (request.args[1] === "get") {
      const encoded = contents.split("\n").find(line => line.startsWith(marker));
      if (!encoded) throw Object.assign(new Error("fake missing registration"), { stderr: `Error: No MCP server named '${server}' found.\n` });
      return { stdout: Buffer.from(encoded.slice(marker.length), "base64").toString("utf8") };
    }
    assert.deepEqual(request.args, ["mcp", "add", server, "--env", "ELECTRON_RUN_AS_NODE=1", "--", executablePath, path.join(appDirectory, "scripts", "mcp-server.mjs")]);
    assert.notEqual(request.env.CODEX_HOME, codexHome, "CLI must never write the user's real configuration");
    if (failAdd) throw Object.assign(new Error("secret configuration details"), { stderr: "SECRET_KEY=do-not-expose" });
    await fs.writeFile(file, `${contents}${marker}${Buffer.from(JSON.stringify(expectedRegistration)).toString("base64")}\n`);
    if (onAdd) await onAdd();
    return { stdout: "Added global MCP server" };
  };
  const updateTransport = async request => {
    transportUpdates.push(request);
    assert.notEqual(request.configPath, configPath);
    assert.equal(request.env.CODEX_HOME, path.dirname(request.configPath));
    const contents = await fs.readFile(request.configPath, "utf8");
    const encoded = contents.split("\n").find(line => line.startsWith(marker));
    const existing = JSON.parse(Buffer.from(encoded.slice(marker.length), "base64").toString("utf8"));
    existing.transport.command = request.appExe;
    existing.transport.args = [request.serverScript];
    existing.transport.env.ELECTRON_RUN_AS_NODE = "1";
    await fs.writeFile(request.configPath, contents.replace(encoded, `${marker}${Buffer.from(JSON.stringify(existing)).toString("base64")}`));
  };
  const options = { appDirectory, executablePath, homeDirectory: home, env: { PATH: root, CODEX_HOME: codexHome, ELECTRON_RUN_AS_NODE: "1" }, runProcess: runner, updateTransport };
  return { root, home, appDirectory, codexHome, configPath, source, skillPath, codexExe, initial, calls, transportUpdates, options,
    manager: createCodexSetup(options), setFailAdd: value => { failAdd = value; }, setOnAdd: value => { onAdd = value; },
    writeRegistration: async value => fs.writeFile(configPath, `${initial}${marker}${Buffer.from(JSON.stringify({ ...expectedRegistration, ...value })).toString("base64")}\n`),
    expectedRegistration };
}

test("one-click setup stages official CLI changes, preserves unrelated config, installs canonical skill, and is repeatable", async t => {
  const f = await fixture(t, { customHome: true });
  assert.equal((await f.manager.status()).configured, false);
  const result = await f.manager.install();
  assert.equal(result.configured, true);
  assert.equal(result.reloadRequired, true, "Configuration cannot prove that Codex reloaded");
  assert.equal(result.skill.path, f.skillPath);
  assert.equal(result.codex.home, f.codexHome);
  assert.equal(await fs.readFile(path.join(result.backupDirectory, "config.toml"), "utf8"), f.initial);
  assert.ok((await fs.readFile(f.configPath, "utf8")).startsWith(f.initial));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.skillPath, "local-config.json"), "utf8")), { appDirectory: f.appDirectory });
  assert.equal((await f.manager.status()).configured, true);
  const firstConfig = await fs.readFile(f.configPath, "utf8");
  const second = await f.manager.install();
  assert.equal(second.configured, true);
  assert.equal(second.backupDirectory, undefined);
  assert.equal(await fs.readFile(f.configPath, "utf8"), firstConfig);
  assert.equal(f.calls.filter(call => call.args[1] === "add").length, 1);
});

test("an existing recognized legacy skill is upgraded in place with a complete backup", async t => {
  const f = await fixture(t, { legacy: true, customHome: true });
  const result = await f.manager.install();
  assert.equal(result.skill.path, f.skillPath);
  assert.equal(await fs.readFile(path.join(result.backupDirectory, skill, "custom-notes.txt"), "utf8"), "My prior notes");
  await assert.rejects(fs.stat(path.join(f.home, ".agents", "skills", skill)), { code: "ENOENT" });
});

test("CLI failure exposes no config content and leaves existing configuration and skill intact", async t => {
  const f = await fixture(t, { legacy: true });
  f.setFailAdd(true);
  await assert.rejects(f.manager.install(), error => error.code === "CLI_FAILED" && !error.message.includes("SECRET"));
  assert.equal(await fs.readFile(f.configPath, "utf8"), f.initial);
  assert.equal(await fs.readFile(path.join(f.skillPath, "custom-notes.txt"), "utf8"), "My prior notes");
  assert.ok(!(await fs.readdir(f.codexHome)).some(name => name.startsWith(".compositor-setup")));
});

test("concurrent configuration edits during staging are retained and installation aborts", async t => {
  const f = await fixture(t);
  f.setOnAdd(async () => fs.writeFile(f.configPath, `${f.initial}# concurrently edited\n`));
  await assert.rejects(f.manager.install(), { code: "CONFIG_CHANGED" });
  assert.equal(await fs.readFile(f.configPath, "utf8"), `${f.initial}# concurrently edited\n`);
  await assert.rejects(fs.stat(f.skillPath), { code: "ENOENT" });
});

test("a commit failure after replacing skill restores the original skill and config", async t => {
  const f = await fixture(t, { legacy: true });
  const rename = nativeFs.rename;
  nativeFs.rename = async (from, to) => {
    if (to === f.configPath && from.endsWith(path.join("codex", "config.toml"))) throw Object.assign(new Error("test write failure"), { code: "EACCES" });
    return rename(from, to);
  };
  try { await assert.rejects(f.manager.install(), { code: "SETUP_FAILED" }); }
  finally { nativeFs.rename = rename; }
  assert.equal(await fs.readFile(f.configPath, "utf8"), f.initial);
  assert.equal(await fs.readFile(path.join(f.skillPath, "custom-notes.txt"), "utf8"), "My prior notes");
  await assert.rejects(fs.stat(path.join(f.skillPath, ".compositor-setup.json")), { code: "ENOENT" });
});

test("existing matching server keeps invisible approval policy bytes and is never re-added", async t => {
  const f = await fixture(t);
  await f.writeRegistration({});
  await fs.appendFile(f.configPath, '# Simulate fields not exposed by mcp get JSON\ndefault_tools_approval_mode = "prompt"\n');
  const before = await fs.readFile(f.configPath, "utf8");
  await f.manager.install();
  assert.equal(await fs.readFile(f.configPath, "utf8"), before);
  assert.equal(f.calls.filter(call => call.args[1] === "add").length, 0);
});

test("disabled or HTTP MCP servers are not silently reset", async t => {
  const f = await fixture(t);
  await f.writeRegistration({ enabled: false });
  const disabled = await fs.readFile(f.configPath, "utf8");
  assert.equal((await f.manager.status()).mcp.registered, false);
  await assert.rejects(f.manager.install(), { code: "MCP_DISABLED" });
  assert.equal(await fs.readFile(f.configPath, "utf8"), disabled);
  await f.writeRegistration({ transport: { type: "streamable_http", url: "https://example.invalid/mcp" } });
  const different = await fs.readFile(f.configPath, "utf8");
  await assert.rejects(f.manager.install(), { code: "MCP_EXISTING_SERVER" });
  assert.equal(await fs.readFile(f.configPath, "utf8"), different);
  assert.equal(f.calls.filter(call => call.args[1] === "add").length, 0);
});

test("old stdio paths are migrated using a field update, retaining policies and custom environment", async t => {
  const f = await fixture(t);
  await f.writeRegistration({ transport: { ...f.expectedRegistration.transport, command: path.join(f.root, "old.exe"), env: { ELECTRON_RUN_AS_NODE: "0", MY_SETTING: "keep" } }, startup_timeout_sec: 35 });
  await fs.appendFile(f.configPath, '# Approval fields invisible to get JSON must remain\ndefault_tools_approval_mode = "prompt"\n');
  const result = await f.manager.install();
  assert.equal(result.configured, true);
  assert.equal(f.transportUpdates.length, 1);
  assert.equal(f.calls.filter(call => call.args[1] === "add").length, 0);
  const config = await fs.readFile(f.configPath, "utf8");
  assert.ok(config.includes('default_tools_approval_mode = "prompt"'));
  const saved = JSON.parse(Buffer.from(config.split("\n").find(line => line.startsWith(marker)).slice(marker.length), "base64").toString("utf8"));
  assert.equal(saved.transport.env.MY_SETTING, "keep");
  assert.equal(saved.startup_timeout_sec, 35);
});

test("unsupported config API aborts old-path migration without falling back to destructive mcp add", async t => {
  const f = await fixture(t);
  await f.writeRegistration({ transport: { ...f.expectedRegistration.transport, command: path.join(f.root, "old.exe") } });
  const before = await fs.readFile(f.configPath, "utf8");
  const manager = createCodexSetup({ ...f.options, updateTransport: async () => { throw new Error("unsupported API"); } });
  await assert.rejects(manager.install(), { code: "SETUP_FAILED" });
  assert.equal(await fs.readFile(f.configPath, "utf8"), before);
  assert.equal(f.calls.filter(call => call.args[1] === "add").length, 0);
});

test("unrecognized or duplicate skill directories are protected", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.skillPath, { recursive: true });
  await fs.writeFile(path.join(f.skillPath, "valuable.txt"), "Keep this");
  await assert.rejects(f.manager.install(), { code: "SKILL_CONFLICT" });
  assert.equal(await fs.readFile(path.join(f.skillPath, "valuable.txt"), "utf8"), "Keep this");
  await fs.cp(f.source, f.skillPath, { recursive: true });
  await fs.cp(f.source, path.join(f.codexHome, "skills", skill), { recursive: true });
  await assert.rejects(f.manager.install(), { code: "DUPLICATE_SKILL" });
  assert.equal(f.calls.length, 0);
});

test("missing CLI is actionable; selected executables use argv without a shell", async t => {
  const f = await fixture(t);
  const manager = createCodexSetup({ ...f.options, env: { CODEX_HOME: f.codexHome } });
  assert.equal((await manager.status()).codex.available, false);
  await assert.rejects(manager.install(), { code: "MISSING_CODEX" });
  const result = await manager.install({ codexExecutable: f.codexExe });
  assert.equal(result.configured, true);
  assert.ok(f.calls.some(call => call.args.includes(f.appDirectory + path.sep + "Compositor Windows.exe")));
  await assert.rejects(manager.install({ codexExecutable: path.join(f.root, "codex.cmd") }), { code: "INVALID_CODEX" });
});

test("desktop CLI discovery searches versioned directories and installer lock prevents simultaneous writes", async t => {
  const f = await fixture(t);
  const localAppData = path.join(f.root, "Local");
  const native = path.join(localAppData, "OpenAI", "Codex", "bin", "observed-version", "codex.exe");
  await fs.mkdir(path.dirname(native), { recursive: true });
  await fs.copyFile(f.codexExe, native);
  const manager = createCodexSetup({ ...f.options, env: { CODEX_HOME: f.codexHome, LOCALAPPDATA: localAppData }, runProcess: async request => ({ stdout: "null" }) });
  assert.equal((await manager.status()).codex.executable, native);
  await fs.writeFile(path.join(f.codexHome, ".compositor-setup.lock"), "Other instance");
  await assert.rejects(manager.install(), { code: "SETUP_LOCKED" });
  assert.equal(await fs.readFile(path.join(f.codexHome, ".compositor-setup.lock"), "utf8"), "Other instance");
  assert.equal(await fs.readFile(f.configPath, "utf8"), f.initial);
});
