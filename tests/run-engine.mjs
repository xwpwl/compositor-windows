import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

// Runs entirely offline, using system Edge by default. Set
// COMPOSITOR_TEST_BROWSER=chrome, or chromium for Playwright's downloaded build.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, "work", "engine-tests");
await fs.mkdir(scratch, { recursive: true });
const bundlePath = path.join(scratch, "engine.bundle.js");
await build({
  entryPoints: [path.join(root, "tests", "engine-browser.ts")],
  bundle: true,
  format: "iife",
  globalName: "EngineTests",
  outfile: bundlePath,
  sourcemap: "inline",
});

let browser;
const browserName = process.env.COMPOSITOR_TEST_BROWSER || "msedge";
try {
  browser = await chromium.launch({
    headless: true,
    ...(browserName === "chromium" ? {} : { channel: browserName }),
  });
  const page = await browser.newPage();
  await page.addScriptTag({ path: bundlePath });
  const tests = await page.evaluate(() => EngineTests.runEngineTests());
  const report = { passed: tests.length, failed: 0, browser: browserName, tests };
  await fs.writeFile(path.join(scratch, "results.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = { passed: 0, failed: 1, browser: browserName, error: String(error.stack || error) };
  await fs.writeFile(path.join(scratch, "results.json"), JSON.stringify(report, null, 2));
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
