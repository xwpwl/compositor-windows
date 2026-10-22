"use strict";

// Configuration is prepared by the official Codex CLI in an isolated CODEX_HOME.
// This module never parses or edits TOML itself and never returns configuration
// contents or CLI output to the renderer. It does not launch/reload Codex.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execute = promisify(execFile);
const SERVER_NAME = "compositor_windows";
const SKILL_NAME = "compositor-windows-edit";
const MARKER = ".compositor-setup.json";
const MAX_BYTES = 16 * 1024 * 1024;

class SetupError extends Error {
  constructor(code, message, backupDirectory) {
    super(message);
    this.name = "SetupError";
    this.code = code;
    if (backupDirectory) this.backupDirectory = backupDirectory;
  }
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function absolute(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0") || !path.isAbsolute(value)) {
    throw new SetupError("INVALID_PATH", `${label}必须是绝对路径。`);
  }
  return path.resolve(value);
}

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function statMaybe(filename) {
  try { return await fs.lstat(filename); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function noLinks(filename) {
  let current = path.resolve(filename);
  for (;;) {
    const stat = await statMaybe(current);
    if (stat?.isSymbolicLink()) {
      throw new SetupError("LINK_PATH", "配置或 Skill 路径包含符号链接，请选择普通目录后重试。");
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function fileSnapshot(filename) {
  await noLinks(filename);
  const stat = await statMaybe(filename);
  if (!stat) return { exists: false, bytes: null, hash: null };
  if (!stat.isFile() || stat.size > MAX_BYTES) {
    throw new SetupError("INVALID_CONFIG", "配置文件不是普通文件，或超过安全读取大小。");
  }
  const bytes = await fs.readFile(filename);
  return { exists: true, bytes, hash: digest(bytes) };
}

async function treeSnapshot(directory) {
  await noLinks(directory);
  const stat = await statMaybe(directory);
  if (!stat) return { exists: false, hash: null, files: [] };
  if (!stat.isDirectory()) throw new SetupError("INVALID_SKILL", "Skill 路径已被普通文件占用。");
  const files = [];
  const entries = [];
  let size = 0;
  async function visit(relative) {
    const children = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const child of children) {
      const item = path.join(relative, child.name);
      if (child.isSymbolicLink()) throw new SetupError("LINK_PATH", "Skill 内包含符号链接，未覆盖现有文件。");
      if (entries.length >= 2048) throw new SetupError("INVALID_SKILL", "Skill 目录文件过多，未覆盖现有文件。");
      if (child.isDirectory()) {
        entries.push([item, "directory"]);
        await visit(item);
      } else if (child.isFile()) {
        const info = await fs.lstat(path.join(directory, item));
        size += info.size;
        if (size > MAX_BYTES) throw new SetupError("INVALID_SKILL", "Skill 目录过大，未覆盖现有文件。");
        const bytes = await fs.readFile(path.join(directory, item));
        files.push({ relative: item, bytes });
        entries.push([item, digest(bytes)]);
      } else {
        throw new SetupError("INVALID_SKILL", "Skill 内包含不支持的文件类型。");
      }
    }
  }
  await visit("");
  return { exists: true, files, hash: digest(JSON.stringify(entries)) };
}

async function defaultRunProcess({ executable, args, env, cwd, timeoutMs }) {
  return execute(executable, args, {
    env,
    cwd,
    timeout: timeoutMs,
    maxBuffer: 256 * 1024,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
}

// The CLI's `mcp add` replaces an entire existing server table. The official
// app-server config API can update just its transport fields, preserving policies
// that `mcp get --json` does not expose. This helper only edits the staged file.
async function defaultUpdateTransport({ executable, env, cwd, timeoutMs, configPath, appExe, serverScript }) {
  const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
    env, cwd, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let sequence = 0;
  let buffer = "";
  let totalBytes = 0;
  let closed = false;
  const stopped = new Promise(resolve => child.once("close", () => { closed = true; resolve(); }));
  const failure = () => new SetupError("CONFIG_API_FAILED", "当前 Codex 无法安全更新旧 MCP 路径。请更新 Codex 后重试，或在 Codex 中移除旧 compositor_windows 服务后再配置。");
  function failAll() {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(failure()); }
    pending.clear();
  }
  child.on("error", failAll);
  child.on("exit", failAll);
  child.stdin.on("error", failAll);
  child.stderr.on("data", () => {}); // Never return CLI output or user config contents.
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    totalBytes += Buffer.byteLength(chunk);
    if (totalBytes > 256 * 1024) { failAll(); child.kill(); return; }
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let response;
      try { response = JSON.parse(line); } catch { failAll(); child.kill(); return; }
      const request = pending.get(response.id);
      if (!request) continue;
      pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.error) request.reject(failure());
      else request.resolve(response.result);
    }
  });
  function request(method, params) {
    if (closed) return Promise.reject(failure());
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new SetupError("CLI_TIMEOUT", "Codex 配置命令超时，原配置未被覆盖。")); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  try {
    await request("initialize", { clientInfo: { name: "compositor_windows_setup", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const result = await request("config/batchWrite", {
      filePath: configPath,
      reloadUserConfig: false,
      edits: [
        { keyPath: `mcp_servers.${SERVER_NAME}.command`, mergeStrategy: "replace", value: appExe },
        { keyPath: `mcp_servers.${SERVER_NAME}.args`, mergeStrategy: "replace", value: [serverScript] },
        { keyPath: `mcp_servers.${SERVER_NAME}.env.ELECTRON_RUN_AS_NODE`, mergeStrategy: "replace", value: "1" },
      ],
    });
    if (result?.status !== "ok") throw failure();
  } finally {
    failAll();
    child.stdin.end();
    if (!closed) child.kill();
    await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 500))]);
  }
}

/** All injectable paths/runners are main-process inputs, never renderer input. */
function createCodexSetup({
  appDirectory,
  executablePath,
  skillSourceDirectory,
  homeDirectory = os.homedir(),
  env = process.env,
  runProcess = defaultRunProcess,
  updateTransport = defaultUpdateTransport,
  timeoutMs = 15000,
}) {
  const appDir = absolute(appDirectory, "软件目录");
  const appExe = absolute(executablePath, "软件程序");
  const home = absolute(homeDirectory, "用户目录");
  const skillSource = absolute(skillSourceDirectory || path.join(appDir, "skills", SKILL_NAME), "内置 Skill 目录");
  const serverScript = path.join(appDir, "scripts", "mcp-server.mjs");
  // Do not inherit Electron's Node mode when invoking the native Codex binary.
  const baseEnv = { ...env };
  delete baseEnv.ELECTRON_RUN_AS_NODE;
  let busy = false;

  async function discoverExecutable(selected) {
    if (selected) {
      const selectedPath = absolute(selected, "Codex 程序");
      if (path.extname(selectedPath).toLowerCase() !== ".exe") {
        throw new SetupError("INVALID_CODEX", "请选择 Codex 的 codex.exe 程序。");
      }
      const stat = await statMaybe(selectedPath);
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        throw new SetupError("INVALID_CODEX", "选中的 Codex 程序不存在或不是普通文件。");
      }
      return selectedPath;
    }
    const candidates = [];
    const searchPath = baseEnv.PATH || baseEnv.Path || "";
    for (const entry of searchPath.split(path.delimiter)) {
      const clean = entry.replace(/^"|"$/g, "");
      if (clean && path.isAbsolute(clean)) candidates.push(path.join(clean, "codex.exe"));
    }
    if (baseEnv.LOCALAPPDATA) {
      const bin = path.join(baseEnv.LOCALAPPDATA, "OpenAI", "Codex", "bin");
      try {
        const children = await fs.readdir(bin, { withFileTypes: true });
        const versions = [];
        for (const child of children) {
          if (!child.isDirectory() || child.isSymbolicLink()) continue;
          const candidate = path.join(bin, child.name, "codex.exe");
          const stat = await statMaybe(candidate);
          if (stat?.isFile() && !stat.isSymbolicLink()) versions.push({ candidate, mtime: stat.mtimeMs });
        }
        versions.sort((a, b) => b.mtime - a.mtime);
        candidates.push(...versions.map(({ candidate }) => candidate));
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    for (const candidate of candidates) {
      const stat = await statMaybe(candidate);
      if (stat?.isFile() && !stat.isSymbolicLink()) return path.resolve(candidate);
    }
    return null;
  }

  async function locations(options) {
    const codexHome = absolute(options.codexHome || baseEnv.CODEX_HOME || path.join(home, ".codex"), "Codex 配置目录");
    const canonicalSkill = path.join(home, ".agents", "skills", SKILL_NAME);
    const candidates = [canonicalSkill, path.join(codexHome, "skills", SKILL_NAME), path.join(home, ".codex", "skills", SKILL_NAME)]
      .filter((value, index, all) => all.findIndex(other => samePath(value, other)) === index);
    const found = [];
    for (const candidate of candidates) {
      if (await statMaybe(candidate)) found.push(candidate);
    }
    if (found.length > 1) {
      throw new SetupError("DUPLICATE_SKILL", "检测到多个同名 Compositor Skill。请保留一份后重试，以免 Codex 重复加载。");
    }
    const skillPath = found[0] || canonicalSkill;
    const existing = await treeSnapshot(skillPath);
    if (existing.exists) {
      const skillMd = existing.files.find(file => file.relative === "SKILL.md")?.bytes.toString("utf8") || "";
      const hasClient = existing.files.some(file => file.relative === path.join("scripts", "mcp-client.mjs"));
      if (!/^name:\s*compositor-windows-edit\s*$/m.test(skillMd) || !hasClient) {
        throw new SetupError("SKILL_CONFLICT", "同名 Skill 目录中是无法识别的内容，未覆盖。请更名保存该目录后重试。");
      }
    }
    return { codexHome, configPath: path.join(codexHome, "config.toml"), skillPath, executable: await discoverExecutable(options.codexExecutable) };
  }

  async function cli(executable, args, codexHome) {
    try {
      return await runProcess({ executable, args, env: { ...baseEnv, CODEX_HOME: codexHome }, cwd: appDir, timeoutMs });
    } catch (error) {
      if (args[0] === "mcp" && args[1] === "get"
        && String(error.stderr || "").includes(`No MCP server named '${SERVER_NAME}' found.`)) {
        return { stdout: "null" };
      }
      const timeout = error.killed || error.code === "ETIMEDOUT";
      throw new SetupError(timeout ? "CLI_TIMEOUT" : "CLI_FAILED", timeout
        ? "Codex 配置命令超时。请检查 Codex 安装后重试。"
        : "Codex 无法读取或更新配置。请检查 Codex 的版本与配置文件后重试。");
    }
  }

  async function readRegistration(executable, codexHome) {
    const result = await cli(executable, ["mcp", "get", SERVER_NAME, "--json"], codexHome);
    let value;
    try { value = JSON.parse(result.stdout); }
    catch { throw new SetupError("INVALID_CLI_RESPONSE", "Codex 返回了无法识别的配置结果。"); }
    return value;
  }

  function transportMatches(value) {
    const transport = value?.transport;
    return Boolean(value?.name === SERVER_NAME && transport?.type === "stdio" && samePath(transport.command, appExe)
      && Array.isArray(transport.args) && transport.args.length === 1 && samePath(transport.args[0], serverScript)
      && transport.env?.ELECTRON_RUN_AS_NODE === "1");
  }

  function registrationReady(value) {
    return Boolean(transportMatches(value) && policyAllowsTools(value));
  }

  function policyAllowsTools(value) {
    return Boolean(value && value.enabled !== false && !value.disabled_reason
      && (!value.disabled_tools || value.disabled_tools.length === 0)
      && (!value.enabled_tools || ["compositor_get_state", "compositor_get_canvas", "compositor_edit", "compositor_open_image", "compositor_export"].every(tool => value.enabled_tools.includes(tool))));
  }

  async function expectedSkillFiles() {
    const source = await treeSnapshot(skillSource);
    if (!source.exists || !source.files.some(file => file.relative === "SKILL.md")) {
      throw new SetupError("MISSING_BUNDLE", "安装目录缺少配套 Skill，请重新安装 Compositor Windows。");
    }
    const files = source.files.filter(file => !["local-config.json", MARKER].includes(file.relative));
    files.push({ relative: "local-config.json", bytes: Buffer.from(`${JSON.stringify({ appDirectory: appDir }, null, 2)}\n`) });
    files.push({ relative: MARKER, bytes: Buffer.from(`${JSON.stringify({ schema: 1, application: "Compositor Windows", appDirectory: appDir }, null, 2)}\n`) });
    return files;
  }

  async function skillMatches(skillPath) {
    const current = await treeSnapshot(skillPath);
    if (!current.exists) return false;
    const expected = await expectedSkillFiles();
    // Extra user files may coexist; bundled files and the local app path must match.
    return expected.every(item => current.files.some(file => file.relative === item.relative && file.bytes.equals(item.bytes)));
  }

  function statusBase(loc) {
    return {
      configured: false,
      codex: { available: Boolean(loc.executable), executable: loc.executable, home: loc.codexHome },
      skill: { installed: false, path: loc.skillPath },
      mcp: { registered: false, checked: false, name: SERVER_NAME },
      reloadRequired: false,
      message: "尚未完成配置。",
    };
  }

  async function status(options = {}) {
    let loc;
    try { loc = await locations(options); }
    catch (error) {
      return { configured: false, codex: { available: false, executable: null, home: options.codexHome || baseEnv.CODEX_HOME || path.join(home, ".codex") },
        skill: { installed: false, path: path.join(home, ".agents", "skills", SKILL_NAME) }, mcp: { registered: false, checked: false, name: SERVER_NAME },
        reloadRequired: false, errorCode: error.code || "STATUS_FAILED", message: error.message };
    }
    const result = statusBase(loc);
    try {
      result.skill.installed = await skillMatches(loc.skillPath);
      if (loc.executable) {
        // CLI get may report an absent entry with a nonzero exit code. Do not expose
        // its output, which could contain unrelated user configuration details.
        try { result.mcp.registered = registrationReady(await readRegistration(loc.executable, loc.codexHome)); result.mcp.checked = true; }
        catch (error) { result.errorCode = error.code; }
      }
      result.configured = result.skill.installed && result.mcp.registered;
      result.reloadRequired = result.configured;
      result.message = result.configured ? "Skill 和 MCP 已配置。请重启 Codex 或重新加载 MCP 后在新对话中使用。"
        : !loc.executable ? "未找到 Codex 程序。请先安装 Codex，或选择 codex.exe。" : "点击一键配置，安装或修复 Skill 和 MCP。";
    } catch (error) { result.errorCode = error.code || "STATUS_FAILED"; result.message = error.message; }
    return result;
  }

  async function install(options = {}) {
    if (busy) throw new SetupError("SETUP_BUSY", "正在配置 Codex，请等待本次操作完成。");
    busy = true;
    let lock;
    let lockPath;
    let scratch;
    let backupDirectory;
    let retiredSkillDirectory;
    let loc;
    let beforeConfig;
    let beforeSkill;
    let nextConfig;
    let nextSkillHash;
    let skillInstalled = false;
    let skillMoved = false;
    let configInstalled = false;
    let committed = false;
    try {
      loc = await locations(options);
      if (!loc.executable) throw new SetupError("MISSING_CODEX", "未找到 Codex 程序。请先安装 Codex，或选择 codex.exe。");
      for (const file of [appExe, serverScript]) {
        const info = await statMaybe(file);
        if (!info?.isFile() || info.isSymbolicLink()) throw new SetupError("MISSING_BUNDLE", "安装目录缺少程序或 MCP 脚本，请重新安装 Compositor Windows。");
      }
      await noLinks(loc.codexHome);
      await noLinks(path.dirname(loc.skillPath));
      await fs.mkdir(loc.codexHome, { recursive: true });
      lockPath = path.join(loc.codexHome, ".compositor-setup.lock");
      try { lock = await fs.open(lockPath, "wx", 0o600); }
      catch (error) {
        if (error.code === "EEXIST") throw new SetupError("SETUP_LOCKED", "另一个 Compositor 正在配置，或上次配置意外中断。请关闭其他实例；若仍提示，可移除配置目录中的 .compositor-setup.lock 后重试。");
        throw error;
      }
      await lock.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      beforeConfig = await fileSnapshot(loc.configPath);
      beforeSkill = await treeSnapshot(loc.skillPath);
      const expected = await expectedSkillFiles();
      scratch = await fs.mkdtemp(path.join(loc.codexHome, ".compositor-setup-"));
      await fs.chmod(scratch, 0o700);
      const stagedHome = path.join(scratch, "codex");
      const stagedSkill = path.join(scratch, "skill");
      await fs.mkdir(stagedHome);
      await fs.mkdir(stagedSkill);
      if (beforeConfig.exists) await fs.writeFile(path.join(stagedHome, "config.toml"), beforeConfig.bytes, { flag: "wx", mode: 0o600 });
      for (const file of expected) {
        const dest = path.join(stagedSkill, file.relative);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, file.bytes, { flag: "wx", mode: 0o600 });
      }
      const previousRegistration = await readRegistration(loc.executable, stagedHome);
      if (previousRegistration) {
        // `mcp add` replaces the complete existing server table, including policy
        // fields that `mcp get --json` does not expose. Never reset those fields.
        if (previousRegistration.transport?.type !== "stdio") throw new SetupError("MCP_EXISTING_SERVER", "Codex 中已存在其他类型的 compositor_windows 服务。本次未替换；请在 Codex 中移除旧服务后，再点击一键配置。");
        if (!policyAllowsTools(previousRegistration)) throw new SetupError("MCP_DISABLED", "Codex 中的 compositor_windows 已被禁用或限制工具。本次保留这些设置；请先在 Codex 中启用需要的工具后重试。");
        if (!transportMatches(previousRegistration)) {
          await updateTransport({ executable: loc.executable, env: { ...baseEnv, CODEX_HOME: stagedHome }, cwd: appDir, timeoutMs,
            configPath: path.join(stagedHome, "config.toml"), appExe, serverScript });
        }
      } else {
        await cli(loc.executable, ["mcp", "add", SERVER_NAME, "--env", "ELECTRON_RUN_AS_NODE=1", "--", appExe, serverScript], stagedHome);
      }
      if (!registrationReady(await readRegistration(loc.executable, stagedHome))) throw new SetupError("VERIFY_FAILED", "Codex MCP 配置校验失败，未修改现有配置。");
      nextConfig = await fileSnapshot(path.join(stagedHome, "config.toml"));
      if (!nextConfig.exists) throw new SetupError("VERIFY_FAILED", "Codex 未生成配置文件，未修改现有配置。");
      nextSkillHash = (await treeSnapshot(stagedSkill)).hash;
      // Optimistic concurrency check immediately before committing. The app's
      // exclusive lock also prevents simultaneous installers in other instances.
      if ((await fileSnapshot(loc.configPath)).hash !== beforeConfig.hash || (await treeSnapshot(loc.skillPath)).hash !== beforeSkill.hash) {
        throw new SetupError("CONFIG_CHANGED", "配置或 Skill 在操作期间被其他程序修改。本次未覆盖，请重试。");
      }
      if (beforeConfig.hash === nextConfig.hash && await skillMatches(loc.skillPath)) {
        return { ...statusBase(loc), configured: true, skill: { installed: true, path: loc.skillPath }, mcp: { registered: true, checked: true, name: SERVER_NAME }, reloadRequired: true,
          message: "配置已是最新。请重启 Codex 或重新加载 MCP 后在新对话中使用。" };
      }
      const backupRoot = path.join(loc.codexHome, "compositor-backups");
      await noLinks(backupRoot);
      await fs.mkdir(backupRoot, { recursive: true });
      backupDirectory = await fs.mkdtemp(path.join(backupRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-`));
      await fs.chmod(backupDirectory, 0o700);
      if (beforeConfig.exists) await fs.writeFile(path.join(backupDirectory, "config.toml"), beforeConfig.bytes, { flag: "wx", mode: 0o600 });
      await fs.writeFile(path.join(backupDirectory, "restore-info.json"), `${JSON.stringify({ configPath: loc.configPath, configExisted: beforeConfig.exists, skillPath: loc.skillPath, skillExisted: beforeSkill.exists }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await fs.mkdir(path.dirname(loc.skillPath), { recursive: true });
      if (beforeSkill.exists) {
        const skillBackup = path.join(backupDirectory, SKILL_NAME);
        await fs.cp(loc.skillPath, skillBackup, { recursive: true, errorOnExist: true, force: false });
        if ((await treeSnapshot(skillBackup)).hash !== beforeSkill.hash || (await treeSnapshot(loc.skillPath)).hash !== beforeSkill.hash) {
          throw new SetupError("CONFIG_CHANGED", "备份期间 Skill 被其他程序修改，未覆盖现有文件。");
        }
        retiredSkillDirectory = await fs.mkdtemp(path.join(path.dirname(loc.skillPath), ".compositor-previous-"));
        await fs.rename(loc.skillPath, path.join(retiredSkillDirectory, SKILL_NAME));
        skillMoved = true;
      }
      // Skills can reside on another volume when CODEX_HOME is customized.
      const adjacentSkill = await fs.mkdtemp(path.join(path.dirname(loc.skillPath), ".compositor-install-"));
      try {
        const adjacentPayload = path.join(adjacentSkill, SKILL_NAME);
        await fs.cp(stagedSkill, adjacentPayload, { recursive: true, errorOnExist: true, force: false });
        await fs.rename(adjacentPayload, loc.skillPath);
      } finally {
        await fs.rm(adjacentSkill, { recursive: true, force: true }).catch(() => {});
      }
      skillInstalled = true;
      if ((await fileSnapshot(loc.configPath)).hash !== beforeConfig.hash) throw new SetupError("CONFIG_CHANGED", "Codex 配置在操作期间被修改，已停止安装以保护其他设置。");
      // This rename replaces only this user's config.toml. The exact prior bytes
      // remain in the private backup; unrelated Codex files are never copied back.
      await fs.rename(path.join(stagedHome, "config.toml"), loc.configPath);
      configInstalled = true;
      if ((await fileSnapshot(loc.configPath)).hash !== nextConfig.hash || !(await skillMatches(loc.skillPath))) {
        throw new SetupError("VERIFY_FAILED", "写入后校验失败，将尝试恢复本次更改。");
      }
      committed = true;
      return { ...statusBase(loc), configured: true, skill: { installed: true, path: loc.skillPath }, mcp: { registered: true, checked: true, name: SERVER_NAME }, reloadRequired: true, backupDirectory,
        message: "Skill 和 MCP 配置完成。请重启 Codex 或重新加载 MCP 后，在新对话中使用。" };
    } catch (error) {
      let rollbackIncomplete = false;
      if (configInstalled) {
        try {
          if ((await fileSnapshot(loc.configPath)).hash !== nextConfig.hash) rollbackIncomplete = true;
          else if (beforeConfig.exists) {
            const restore = path.join(scratch, "restore-config.toml");
            await fs.writeFile(restore, beforeConfig.bytes, { flag: "wx", mode: 0o600 });
            await fs.rename(restore, loc.configPath);
          } else await fs.unlink(loc.configPath);
        } catch { rollbackIncomplete = true; }
      }
      if (skillInstalled || skillMoved) {
        try {
          const current = await treeSnapshot(loc.skillPath);
          if (skillInstalled && current.hash === nextSkillHash) await fs.rm(loc.skillPath, { recursive: true });
          else if (current.exists) rollbackIncomplete = true;
          if (skillMoved && !(await statMaybe(loc.skillPath))) await fs.rename(path.join(retiredSkillDirectory, SKILL_NAME), loc.skillPath);
        } catch { rollbackIncomplete = true; }
      }
      if (rollbackIncomplete) throw new SetupError("ROLLBACK_INCOMPLETE", "配置过程中发生并发修改或恢复失败；为保护新内容未强行覆盖。原始文件保存在备份目录，请检查后重试。", backupDirectory);
      if (error instanceof SetupError) { if (backupDirectory) error.backupDirectory = backupDirectory; throw error; }
      const failure = new SetupError("SETUP_FAILED", "无法完成配置，已尝试恢复本次更改。请检查目录权限或重新安装软件后重试。", backupDirectory);
      failure.cause = error;
      throw failure;
    } finally {
      if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
      if (retiredSkillDirectory) {
        if (committed) await fs.rm(retiredSkillDirectory, { recursive: true, force: true }).catch(() => {});
        else await fs.rmdir(retiredSkillDirectory).catch(() => {}); // Keep recovery files after an incomplete rollback.
      }
      if (lock) { await lock.close().catch(() => {}); await fs.unlink(lockPath).catch(() => {}); }
      busy = false;
    }
  }

  return { status, install };
}

module.exports = { createCodexSetup, SetupError };
