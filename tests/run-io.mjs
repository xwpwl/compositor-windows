import { createServer } from "vite";
import { chromium } from "playwright";
const server = await createServer({
  server: { port: 5187, strictPort: true, host: "127.0.0.1" },
});
await server.listen();
let browser;
try {
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    browser = await chromium.launch({ channel: "msedge", headless: true });
  }
  const page = await browser.newPage();
  await page.route("http://127.0.0.1:5187/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>IO tests</title>",
    }),
  );
  await page.goto("http://127.0.0.1:5187");
  const tests = await page.evaluate(async () => {
    const { runIOTests } = await import("/tests/io-browser.ts");
    return runIOTests();
  });
  for (const test of tests) console.log(`PASS ${test}`);
  console.log(`${tests.length} browser IO tests passed.`);
} finally {
  await browser?.close();
  await server.close();
}
