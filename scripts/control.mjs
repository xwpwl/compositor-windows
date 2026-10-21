#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rpc, openImage, exportImage, saveCanvas } from "./client.mjs";

const HELP = `Compositor Windows 本地控制命令（请先启动桌面应用）

用法：
  node scripts/control.mjs state
  node scripts/control.mjs canvas <输出.png> [maxSize=1200]
  node scripts/control.mjs command <action> [argsJSON={}]
  node scripts/control.mjs open <图片或工程路径>
  node scripts/control.mjs place <图片或工程路径>
  node scripts/control.mjs export <输出路径> [png|jpeg|psd|cwdoc]
  node scripts/control.mjs help

示例：
  node scripts/control.mjs command new_document '{"name":"海报","width":1080,"height":1350}'
  node scripts/control.mjs command adjust '{"brightness":10,"saturation":15}'
  node scripts/control.mjs export outputs/result.png png

可通过 COMPOSITOR_AUTOMATION_FILE 环境变量指定自动化发现 JSON 路径。
所有图像处理在本地桌面应用执行。令牌不会显示在输出中。`;

export async function run(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || ["help", "--help", "-h"].includes(command)) return HELP;
  switch (command) {
    case "state":
      if (args.length) throw new Error("state 不需要参数。");
      return rpc("get_state");
    case "canvas":
      if (!args[0] || args.length > 2)
        throw new Error("用法：canvas <输出.png> [maxSize]");
      return saveCanvas(
        args[0],
        args[1] === undefined ? 1200 : Number(args[1]),
      );
    case "open":
      if (args.length !== 1) throw new Error("用法：open <图片或工程路径>");
      return openImage(args[0]);
    case "place":
      if (args.length !== 1) throw new Error("用法：place <图片或工程路径>");
      return openImage(args[0], rpc, { asLayer: true });
    case "export": {
      if (!args[0] || args.length > 2)
        throw new Error("用法：export <输出路径> [png|jpeg|psd|cwdoc]");
      const extension = path.extname(args[0]).slice(1).toLowerCase();
      return exportImage(
        args[0],
        args[1] ||
          (extension === "jpg"
            ? "jpeg"
            : ["png", "jpeg", "psd", "cwdoc"].includes(extension)
              ? extension
              : "png"),
      );
    }
    case "command": {
      if (!args[0] || args.length > 2)
        throw new Error("用法：command <action> [argsJSON]");
      let payload;
      try {
        payload = JSON.parse(args[1] || "{}");
      } catch {
        throw new Error("argsJSON 必须是有效的 JSON 对象。");
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new Error("argsJSON 必须是 JSON 对象。");
      return rpc(args[0], payload);
    }
    default:
      throw new Error(
        `未知命令 ${command}。运行 node scripts/control.mjs help 查看用法。`,
      );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run()
    .then((result) =>
      process.stdout.write(
        `${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`,
      ),
    )
    .catch((error) => {
      process.stderr.write(`错误：${error.message}\n`);
      process.exitCode = 1;
    });
}
