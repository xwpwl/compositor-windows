import { _electron } from "playwright";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
const root = path.resolve(".");
const dir = path.join(root, "work", "ui-native");
await fs.mkdir(dir, { recursive: true });
const app = await _electron.launch({
  args: ["."],
  cwd: root,
  env: {
    ...process.env,
    COMPOSITOR_HEADLESS: "1",
    COMPOSITOR_USER_DATA: path.join(dir, "profile"),
    COMPOSITOR_AUTOMATION_FILE: path.join(dir, "automation.json"),
  },
});
const page = await app.firstWindow();
page.setDefaultTimeout(15000);
console.log('Desktop ready');
const failures = [];
page.on("pageerror", (error) => failures.push(error.message));
try {
  await page.getByRole("button", { name: "试用示例", exact: true }).click();
  assert.equal(await page.locator(".layer-row").count(), 6);
  const initial = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds(),
  );
  await page.screenshot({ path: path.join(dir, "demo.png"), scale: "css" });
  await page.getByRole("button", { name: "新建画布", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("spinbutton", { name: "宽度", exact: true })
    .fill("640");
  await page
    .getByRole("dialog")
    .getByRole("spinbutton", { name: "高度", exact: true })
    .fill("480");
  await page.getByRole("button", { name: "创建画布", exact: true }).click();
  await page.getByRole("button", { name: "矩形", exact: true }).click();
  const b = await page.getByLabel("编辑画布", { exact: true }).boundingBox();
  await page.mouse.move(b.x + 70, b.y + 70);
  await page.mouse.down();
  await page.mouse.move(b.x + 210, b.y + 170, { steps: 12 });
  await page.mouse.up();
  assert.equal(await page.locator(".layer-row").count(), 2);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator(".layer-row").count(),
    1,
    "native accelerator should undo exactly once",
  );
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".layer-row").count(), 2);
  await page.getByRole("button", { name: "新建图层", exact: true }).click();
  await page.getByRole("button", { name: "画笔", exact: true }).click();
  await page.mouse.move(b.x + 30, b.y + 250);
  await page.mouse.down();
  await page.mouse.move(b.x + 290, b.y + 280, { steps: 20 });
  await page.mouse.up();
  await page.getByRole("button", { name: "矩形选框", exact: true }).click();
  await page.mouse.move(b.x + 45, b.y + 230);
  await page.mouse.down();
  await page.mouse.move(b.x + 190, b.y + 305, { steps: 8 });
  await page.mouse.up();
  await page
    .getByRole("button", { name: "添加蒙版", exact: true })
    .last()
    .click();
  assert.equal(await page.locator(".mask-chip").count(), 1);
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await page
    .getByRole("textbox", { name: "AI 命令 JSON", exact: true })
    .fill(
      JSON.stringify({
        action: "add_text",
        args: {
          text: "AI EDITED",
          x: 50,
          y: 350,
          fontSize: 36,
          color: "#223344",
        },
      }),
    );
  await page.getByRole("button", { name: "执行命令", exact: true }).click();
  await page.getByRole("button", { name: "属性", exact: true }).click();
  console.log('Text properties opened', await page.locator('.inspector').innerText());
  const field = page.getByRole("textbox", { name: "文字内容", exact: true });
  assert.equal(await field.inputValue(), "AI EDITED");
  await page.getByRole("button", { name: "锁定图层", exact: true }).click();
  assert.equal(await field.isDisabled(), true);
  await page.getByRole("button", { name: "解锁图层", exact: true }).click();
  await field.fill("Windows + Codex");
  const layerCount = await page.locator(".layer-row").count();
  await field.press("Control+a");
  await field.press("Control+c");
  await field.press("End");
  await field.press("Control+v");
  assert.equal(
    await page.locator(".layer-row").count(),
    layerCount,
    "editing text must not paste whole layer",
  );
  assert.equal(
    await field.inputValue(),
    "Windows + CodexWindows + Codex",
    "native text paste should work",
  );
  await field.fill("Windows + Codex");
  await page.getByRole("button", { name: "调色", exact: true }).click();
  await page.getByRole("button", { name: "黑白", exact: true }).click();
  await page.getByRole("button", { name: "黑白", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1060, 720),
  );
  await page.screenshot({
    path: path.join(dir, "minimum-window.png"),
    scale: "css",
  });
  const bounds = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  assert.equal(bounds.width, bounds.scrollWidth);
  assert.equal(bounds.height, bounds.scrollHeight);
  assert.deepEqual(failures, []);
  const result = {
    passed: 10,
    initialWindow: initial,
    minimumViewport: bounds,
    checks: [
      "demo",
      "create",
      "shape",
      "native undo redo",
      "brush",
      "selection mask",
      "AI command",
      "lock unlock",
      "native text clipboard",
      "minimum viewport",
    ],
  };
  await fs.writeFile(
    path.join(dir, "results.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
