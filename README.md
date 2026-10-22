# Compositor Windows 社区重写版

一个可由 AI 操作的 Windows 图层图像编辑器。你可以在桌面里查看和修改作品，也可以让 Codex 通过本地 MCP 工具打开图片、看画布、调色、裁剪、改文字、编辑图层、执行批处理并导出。

本项目参考 [Robbie Tilton / Wonder Assembly 的 Compositor](https://github.com/robbietilton/Compositor) 的工作流与 `.comp` 文件规范，用 Electron、TypeScript 和 Canvas 重新实现。它是独立的社区版本，未获得原作者或 Adobe 的官方背书。目前不是原版的完整复刻，实际覆盖范围见 [FEATURE_PARITY.md](FEATURE_PARITY.md)。

## 下载与安装

从 [GitHub Releases](https://github.com/xwpwl/compositor-windows/releases/latest) 下载 Windows x64 安装包。`v0.1.0` 的文件名为 `Compositor-Windows-Setup-0.1.0-x64.exe`，内含运行时、MCP 桥接脚本和配套 Codex Skill，无需另装 Node.js。

运行安装程序，选择安装范围和目录，按向导完成安装，再从桌面或开始菜单打开 Compositor Windows。安装结束后不会自动启动应用。此版本未进行代码签名，Windows 可能显示“未知发布者”或 SmartScreen 提示；请核对下载来源和 Release 中提供的 SHA-256 校验值。

安装目录中的 `skills/compositor-windows-edit` 是配套 Skill，按下文说明复制到 Codex 技能目录并配置应用路径。Releases 也提供独立 Skill ZIP，便于单独安装或更新。安装程序不会自动修改 Codex 配置。

## 先运行，再连接 AI

1. 安装上述 Release，或按下文“从源码运行”构建程序；需要便携目录时运行 `npm run package`，保留生成目录里的 `resources`、DLL、`scripts` 等文件。
2. 双击 `Compositor Windows.exe`。桌面版已经带运行时，无需安装 Node.js。
3. 用“文件 → 打开”打开图片，或让已连接的 Codex 打开本地图片路径。
4. 按 [AI_WORKFLOW.md](AI_WORKFLOW.md) 配置本地 MCP 服务，重新加载服务后在 Codex 中提出修图要求。仓库不会自动修改你的 Codex 配置。

应用里的“AI”面板是结构化命令调试界面。自然语言请求由连接后的 Codex 理解和执行；桌面应用自身不带聊天模型、模型账号或 API 密钥。

推荐先试：

> 用 Compositor 查看当前图片，调成稍暖的色调、提亮阴影，保留主体细节。每轮调整后检查画布，最后同时导出 PNG 和可继续编辑的 CWDoc。

需要 AI 精修蒙版时，可以说：“给当前图层添加蒙版，在蒙版上隐藏右下角的小块背景，保留原图像素，再检查透明边缘。”接口中的 `paint`、`fill`、`filter` 默认修改像素；修改蒙版必须传 `target:"mask"`。蒙版画笔 `erase:true` 隐藏，白色普通绘制恢复。

## 配套 Codex Skill

仓库包含 [compositor-windows-edit](skills/compositor-windows-edit/SKILL.md)，提供画布检查、主体保留、局部蒙版调色、导出和大工程打开流程，以及不依赖另装 Node.js 的 MCP 调用脚本。

1. 将安装目录、仓库或独立 Skill ZIP 中的 `compositor-windows-edit` 整个文件夹复制到 `%USERPROFILE%\.codex\skills`，或已配置的 `$CODEX_HOME/skills`；复制后应能找到 `skills/compositor-windows-edit/SKILL.md`。
2. 若使用随附调用脚本，将 skill 中的 `local-config.example.json` 复制为 `local-config.json`，把 `appDirectory` 改为包含 `Compositor Windows.exe` 的安装目录或完整便携目录；也可用 `-AppDir` 或 `COMPOSITOR_APP_DIR` 指定。个人配置已被 Git 忽略。
3. 重新加载技能后，可使用 `$compositor-windows-edit 用 Windows 版修这张图，保留中间人物，自然调色`。

已加载 MCP 时 skill 优先直接调用工具；尚未加载时可使用随附脚本。具体连接方式见 [Skill 连接说明](skills/compositor-windows-edit/references/connection.md)。

## 保存哪一种文件

| 格式 | 用途 | 要知道的区别 |
| --- | --- | --- |
| `.cwdoc` | 本版本的可编辑工程 | 保留本版本的文字、形状、图层、蒙版、调整和效果；继续编辑优先保存它 |
| `.png` | 最终无损图像 | 支持透明背景，导出为合成图 |
| `.jpg` / `.jpeg` | 照片与发布 | 有损合成图，透明区域填白 |
| `.psd` | 与 Photoshop 交换像素图层 | 文字、形状、变换和效果可能烘焙；含调整图层的文档会合成为单层 |
| `.comp` 文件夹 | 与原版 Compositor 交换 | 读入版本 1–15 的 sRGB 工程；部分属性简化或烘焙，不能保证往返无损 |

`Ctrl+S` 保存 `.cwdoc`；此版每次保存会打开保存对话框。关闭时若存在未保存更改，会提示保存或放弃。没有崩溃恢复和后台自动保存，请在重要修改后保存工程。

## 当前主要功能

- 多文档标签、图层和组、排序、显隐、锁定、不透明度、27 种混合模式、图层蒙版与剪贴。
- 移动、缩放、旋转、翻转，矩形/椭圆/套索/颜色选区、羽化、裁剪、图像与画布大小。
- 画笔、橡皮擦、仿制图章、模糊画笔、填充、渐变、文字和基础形状。
- 非破坏亮度、对比度、曝光、饱和度、色相、色温、阴影、高光、色阶与伽马；投影与描边。
- 高斯模糊、运动模糊、锐化、噪点、像素化、浮雕、边缘、暗角、辉光。
- 本地 MCP：AI 可以获取文档结构和画布图像，执行可撤销的编辑与事务式批处理，读取本地文件并导出。

当前按 8 位 RGB/sRGB 工作。Camera RAW、语义主体分割、内容感知填充、液化、16/32 位编辑、ICC/CMYK 印刷流程、复杂 PSD 对象尚未实现。去背景适合与边缘连通的纯色背景，不能代替头发等复杂主体抠图。完整细节见功能表。

## 文件与 AI 数据

打开、渲染、调色和导出在本机完成，应用本身不调用云图像服务。使用 Codex 时，`compositor_get_canvas` 返回的画布预览、文档状态和图层文字会作为工具结果交给 Codex；因此不能把整个 AI 工作流描述为完全离线。

本地自动化服务仅监听 `127.0.0.1` 的随机端口，每次启动使用随机令牌。发现文件位于 `%APPDATA%\Compositor Windows\automation.json`，无需手动复制或分享它。脚本读取令牌连接当前桌面实例。

## 从源码运行

开发构建需要 Windows、Node.js 22.12 或更新版本，以及 npm。仓库不包含依赖、用户图像、工程或编译后的 EXE。

```powershell
git clone https://github.com/xwpwl/compositor-windows.git
cd compositor-windows
npm ci
npm run build
npm start
```

生成 Windows 便携目录：

```powershell
npm run package
```

输出位于 `release/win-unpacked`。打包配置自动包含 `scripts` 目录、`skills/compositor-windows-edit`、`启动AI桥接.cmd` 和说明文档；分发时保留完整目录，供外部 MCP 客户端运行。Skill 的 `local-config.json` 不会打包。

生成 Windows x64 安装包：

```powershell
npm run package:installer
```

`v0.1.0` 输出为 `release/Compositor-Windows-Setup-0.1.0-x64.exe`。该命令构建 NSIS 向导安装包，可选择安装目录、创建桌面及开始菜单快捷方式；不会自动发布到 GitHub，也不会进行代码签名。首次构建需要下载 Electron 与 NSIS 打包工具。

验证命令：

```powershell
npm test
node tests/run-engine.mjs
node tests/automation.integration.mjs --launch
```

图像引擎测试默认启动系统 Edge 无界面浏览器，离线执行 15 项 Canvas 像素与图层回归检查，结果写入 `work/engine-tests/results.json`。真实桌面测试会启动自己独立的隐藏窗口。若执行环境禁止 loopback 访问，需要在允许本机网络连接的环境运行。测试结果应以实际测试输出为准。

## 项目与许可

源代码采用 MIT 许可。原版 Compositor 的 `Copyright (c) 2026 Wonder Assembly LLC` 声明已保留；依赖的许可和版权见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与随运行时附带的许可证文件。

本仓库包含编辑器源码、测试、文档和配套 Skill。程序不注册文件关联，也不安装后台常驻服务。应用配置存于 Windows 用户的 AppData；移动程序目录后需更新 MCP 和 Skill 的本机路径。
