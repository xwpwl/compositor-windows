import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await fs.mkdir(path.join(root, "work"), { recursive: true });
const scratch = await fs.mkdtemp(path.join(root, "work", "codex-setup-ui-"));
const home = path.join(scratch, "user");
const codexHome = path.join(home, ".codex");
await fs.mkdir(codexHome, { recursive: true });
const configPath = path.join(codexHome, "config.toml");
const original = '# Keep this comment and the unrelated service.\nmodel = "gpt-6.1"\napproval_policy = "on-request"\n\n[mcp_servers.keep_me]\ncommand = "placeholder-do-not-launch"\nargs = ["keep"]\n';
await fs.writeFile(configPath, original);
const packagedIndex = process.argv.indexOf("--application");
const application = packagedIndex >= 0 ? path.resolve(process.argv[packagedIndex + 1]) : null;
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  CODEX_HOME: codexHome,
  COMPOSITOR_HEADLESS: "1",
  COMPOSITOR_USER_DATA: path.join(scratch, "editor-profile"),
  COMPOSITOR_AUTOMATION_FILE: path.join(scratch, "automation.json"),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.COMPOSITOR_DEV_URL;
let app;
const report = { passed: [], failed: [], scratch };
try {
  app = await _electron.launch({
    ...(application ? { executablePath: path.join(application, "Compositor Windows.exe") } : {}),
    args: application ? [] : [root],
    cwd: root,
    env,
    timeout: 30000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(40000);
  await page.getByRole("button", { name: "连接 Codex", exact: true }).first().click();
  const first = await page.evaluate(() => window.desktop.getCodexStatus());
  // Verify isolation before clicking any button which writes configuration.
  assert.equal(first.codex.home, codexHome);
  assert(first.skill.path.startsWith(home + path.sep), "Skill must remain within the synthetic user profile");
  assert.equal(first.configured, false);
  assert.equal(first.codex.available, true, "Install the Codex CLI before running this opt-in integration test");
  assert.equal(await fs.readFile(configPath, "utf8"), original);
  await assert.rejects(fs.access(first.skill.path), { code: "ENOENT" });
  report.passed.push("Opening the setup panel is read-only and uses isolated user paths");

  await page.getByRole("button", { name: "一键连接 Codex", exact: true }).click();
  await page.getByText("Skill 和 MCP 配置已保存。", { exact: true }).waitFor();
  const installed = await page.evaluate(() => window.desktop.getCodexStatus());
  assert.equal(installed.configured, true);
  assert.equal(installed.skill.installed, true);
  assert.equal(installed.mcp.registered, true);
  assert.equal(installed.reloadRequired, true);
  const config = await fs.readFile(configPath, "utf8");
  assert(config.includes('# Keep this comment and the unrelated service.'));
  assert(config.includes('model = "gpt-6.1"'));
  assert(config.includes('approval_policy = "on-request"'));
  assert(config.includes('[mcp_servers.keep_me]'));
  assert(config.includes('command = "placeholder-do-not-launch"'));
  assert(config.includes('[mcp_servers.compositor_windows]'));
  assert(config.includes('ELECTRON_RUN_AS_NODE'));
  const local = JSON.parse(await fs.readFile(path.join(installed.skill.path, "local-config.json"), "utf8"));
  assert.equal(local.appDirectory, application || root);
  const backups = await fs.readdir(path.join(codexHome, "compositor-backups"));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(codexHome, "compositor-backups", backups[0], "config.toml"), "utf8"), original);
  report.passed.push("One click installs the skill, registers MCP, and backs up unchanged unrelated settings");

  await page.getByRole("button", { name: "更新 / 修复配置", exact: true }).click();
  await page.getByText("Skill 和 MCP 配置已保存。", { exact: true }).waitFor();
  assert.equal(await fs.readFile(configPath, "utf8"), config);
  assert.equal((await fs.readdir(path.join(codexHome, "compositor-backups"))).length, 1);
  report.passed.push("Repeating setup does not duplicate registrations or unnecessary backups");

  await page.getByRole("button", { name: "测试本机连接", exact: true }).click();
  await page.getByText(/本地连接正常：5 个工具/).waitFor();
  assert.equal((await page.evaluate(() => window.desktop.checkCodexConnection())).ok, true);
  report.passed.push("The actual bundled MCP handshake reads the live document and PNG canvas");
  const restart = await page.locator(".codex-restart-note").innerText();
  assert(restart.includes("重启 Codex"));
  assert.equal(await page.locator(".command-input").isVisible(), false);
  report.passed.push("UI explains the reload requirement and hides advanced JSON by default");
  // A hidden packaged window can suspend screenshot compositing on Windows.
  // Keep this optional artifact separate from the completed behavior checks.
  try {
    await page.screenshot({ path: path.join(scratch, "configured.png"), fullPage: true, timeout: 5000 });
    report.screenshot = "configured.png";
  } catch (error) {
    report.screenshotWarning = String(error.message || error);
  }
} catch (error) {
  report.failed.push(String(error.stack || error));
  process.exitCode = 1;
} finally {
  if (app) {
    try { await app.evaluate(({ app: electronApp }) => electronApp.quit()); }
    catch { /* The owned process may already have closed. */ }
    await app.close().catch(() => {});
  }
  await fs.writeFile(path.join(scratch, "results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
