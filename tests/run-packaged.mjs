import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(".");
const executable = path.join(
  root,
  "release",
  "win-unpacked",
  "Compositor Windows.exe",
);
await fs.mkdir(path.join(root, "work"), { recursive: true });
const folder = await fs.mkdtemp(path.join(root, "work", "packaged-smoke-"));
const discovery = path.join(folder, "automation.json");
const env = {
  ...process.env,
  COMPOSITOR_HEADLESS: "1",
  COMPOSITOR_USER_DATA: path.join(folder, "user-data"),
  COMPOSITOR_AUTOMATION_FILE: discovery,
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.COMPOSITOR_DEV_URL;
const app = spawn(executable, [], {
  cwd: root,
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let errors = "";
app.stderr.on("data", (chunk) => {
  errors += chunk.toString();
});
let exited = false;
const exit = new Promise((resolve) =>
  app.once("exit", (code) => {
    exited = true;
    resolve(code);
  }),
);
app.on("error", (error) => {
  errors += error.message;
  exited = true;
});
try {
  let auth;
  for (let i = 0; i < 120; i++) {
    try {
      auth = JSON.parse(await fs.readFile(discovery, "utf8"));
      break;
    } catch {
      /* Renderer is starting. */
    }
    if (exited)
      throw new Error(`Packaged app exited before readiness: ${errors}`);
    await delay(250);
  }
  if (!auth || auth.pid !== app.pid)
    throw new Error(`Packaged app automation was not ready: ${errors}`);
  const response = await fetch(`http://127.0.0.1:${auth.port}/rpc`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "get_state", args: {} }),
    signal: AbortSignal.timeout(15000),
  });
  const state = await response.json();
  if (!response.ok || state.error || !state.result)
    throw new Error(`Packaged state request failed: ${JSON.stringify(state)}`);
  await fs.writeFile(
    path.join(folder, "state.json"),
    JSON.stringify(state.result, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        packaged: true,
        executable,
        stateFile: path.join(folder, "state.json"),
        state: state.result,
      },
      null,
      2,
    ),
  );
} finally {
  if (!exited) app.kill();
  await Promise.race([exit, delay(5000)]);
  await fs.unlink(discovery).catch(() => {});
}
