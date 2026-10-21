# 用 Codex 操作 Compositor Windows

先启动 `Compositor Windows.exe`，再连接下面的 MCP 服务。AI 执行的编辑直接出现在桌面画布和图层面板中；你可以继续手动调整或撤销。

## 一次性连接配置

以下示例假设完整便携程序放在该目录；请替换为自己的实际路径：

```text
C:\Apps\Compositor-Windows
```

首次使用前打开桌面程序，然后在 Codex 中注册下面的 MCP 服务。配置后重启 Codex 或重新加载 MCP 服务，检查是否出现五个工具。仓库不会自动注册服务。

如果移动了文件夹，更新配置中的路径。下面选择一种方式，不要重复添加同名服务。

### 方式 A：使用自带 Electron 运行时，无需安装 Node.js

在 Codex 的 MCP 设置中添加 STDIO 服务，或把以下块加入现有 `config.toml`。默认用户配置通常位于 `%USERPROFILE%\.codex\config.toml`；保留文件里的其他设置。

```toml
[mcp_servers.compositor_windows]
command = "cmd.exe"
args = ["/d", "/c", "C:/Apps/Compositor-Windows/scripts/connect-mcp.cmd"]
startup_timeout_sec = 20
tool_timeout_sec = 45
```

`connect-mcp.cmd` 通过 `ELECTRON_RUN_AS_NODE=1` 使用同目录应用的运行时，只在该脚本进程中设置环境变量。它作为 MCP 的标准输入/输出桥接运行，不会开启第二个编辑器窗口。桌面编辑器仍需要事先打开。

也可以直接使用运行时，避免经过命令解释器：

```toml
[mcp_servers.compositor_windows]
command = 'C:\Apps\Compositor-Windows\Compositor Windows.exe'
args = ['C:\Apps\Compositor-Windows\scripts\mcp-server.mjs']
env = { ELECTRON_RUN_AS_NODE = "1" }
startup_timeout_sec = 20
tool_timeout_sec = 45
```

### 方式 B：已经安装 Node.js

```toml
[mcp_servers.compositor_windows]
command = "node"
args = ["C:/Apps/Compositor-Windows/scripts/mcp-server.mjs"]
startup_timeout_sec = 20
tool_timeout_sec = 45
```

保存后重启该 MCP 服务；如果当前客户端未提供单独重启入口，则重启 Codex。服务应列出下面 5 个工具。配置字段依据 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)，该文档也说明了项目级配置与设置界面的入口。

## 工具与推荐流程

| 工具 | AI 用它做什么 |
| --- | --- |
| `compositor_get_state` | 读取画布尺寸、文档列表、图层 ID、属性与历史 |
| `compositor_get_canvas` | 查看当前合成画布，返回 PNG 图像；预览最长边 64–2048 像素 |
| `compositor_edit` | 执行结构化编辑，支持单个命令或 `batch` |
| `compositor_open_image` | 读取本机图片、PSD 或 CWDoc 文件，最多 45 MiB；默认新文档，`asLayer:true` 放入当前文档以便合成 |
| `compositor_export` | 写出 PNG、JPEG、PSD 或 CWDoc；输出目录必须已经存在 |

让 AI 依次：读状态 → 看画布 → 编辑 → 再看画布 → 按目标检查 → 保存结果。若需要多步调整，`batch` 可将最多 100 条兼容命令记作一个撤销步骤；任何一步失败会回滚。批处理中不能新建/切换文档、打开文件、导出、撤销、重做或再嵌套批处理。

可以直接发给 Codex：

> 用 compositor 工具打开 `C:\图片\产品.png`，先查看画布。保留主体，把白色背景变透明，检查边缘，然后导出到 `C:\图片\产品-透明.png`，再保存一份 `C:\图片\产品-透明.cwdoc`。这是边缘纯色去除，如果背景不适合该算法，请根据实际画面说明。

> 查看当前文档，裁成 4:5 的竖版构图，保留人物头部。整体略微提暖、提亮阴影，右下角添加“秋日记录”，使用独立文字图层。检查文字没有被裁切，最后导出 PNG 和 CWDoc。

> 新建 1080 × 1350 海报，深色背景，添加简单几何色块、主标题和副标题。用分开的图层组织内容，完成后查看预览并调整排版。

MCP 返回图层和文档 ID，后续命令应使用这些真实 ID。颜色用 CSS 色值，坐标用文档像素，不透明度是 `0..1`，旋转角度单位为度。文字和形状需栅格化后才能使用像素画笔与滤镜；继续编辑前可以复制图层保留原件。

合成多张素材时，让 AI 用 `compositor_open_image` 的 `asLayer:true`，可选 `x/y` 设置位置。素材默认缩小到能放入当前画布；多层工程作为素材放入时会先合成为像素图层。这样可以把背景、产品图与文字放在同一个文档，避免误开成多个独立文档。

蒙版编辑要明确指定目标：`paint`、`fill`、`filter` 的 `args.target` 可选 `"pixels"` 或 `"mask"`，默认 `"pixels"`，不受界面当前是否编辑蒙版影响。使用 `"mask"` 前先确认已有蒙版，没有时会明确报错。蒙版用透明度表达显隐：`paint` 配合 `erase:true` 隐藏内容；白色且 `erase:false` 的普通绘制恢复。`get_state` 的 `editingTarget` 显示当前界面编辑目标。

## 命令行控制

在便携目录打开 PowerShell，可直接使用自带运行时：

```powershell
.\scripts\control.cmd state
.\scripts\control.cmd open "C:\图片\照片.jpg"
.\scripts\control.cmd place "C:\图片\透明产品.png"
.\scripts\control.cmd canvas "C:\图片\预览.png" 1200
.\scripts\control.cmd export "C:\图片\结果.png" png
.\scripts\control.cmd export "C:\图片\可编辑.cwdoc" cwdoc
```

复杂 JSON 推荐直接交给 MCP。若用命令行，安装了 Node.js 时可以避免 `.cmd` 解析多层引号：

```powershell
node .\scripts\control.mjs command adjust '{"brightness":8,"temperature":12,"shadows":15}'
node .\scripts\control.mjs command add_text '{"text":"秋日记录","x":80,"y":120,"fontSize":64,"color":"#ffffff"}'
```

无 Node.js 时，也可用 PowerShell 调用自带运行时执行同一脚本：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& ".\Compositor Windows.exe" .\scripts\control.mjs command adjust '{"brightness":8,"temperature":12}'
Remove-Item Env:\ELECTRON_RUN_AS_NODE
```

`control.mjs help` 或 `control.cmd help` 查看参数。命令失败时返回非零退出码。`启动AI桥接.cmd` 是 MCP 客户端启动入口；双击后等待输入属于正常现象，它不是自然语言聊天窗口。

## 数据与权限

图像渲染、调色和导出在本机执行；模型理解请求和判断视觉结果由 Codex 完成。调用看图工具时，PNG 预览会交给 Codex；状态工具还会返回图层名称、文字内容和尺寸等信息。桌面程序本身没有模型 API 密钥，也不上传文件到独立的图像服务。

MCP 进程可以读取 `compositor_open_image` 指定的本地文件，并写入 `compositor_export` 指定的路径。导出会替换该路径的现有普通文件。桌面渲染页面不能直接任意读写路径；它通过受约束的 IPC 与原生对话框操作文件。

本机 HTTP 桥接使用随机端口和令牌，只接受无网页 Origin 的认证请求。发现文件位于 `%APPDATA%\Compositor Windows\automation.json`，桥接脚本自动读取，不要把它当成连接教程分享。普通退出会清理发现文件；进程被强制结束时可能残留，重新启动应用会更新它。

## 排查连接

| 现象 | 处理 |
| --- | --- |
| “尚未找到运行中的 Compositor Windows” | 先打开桌面应用，等画布出现；确认使用同一 Windows 用户 |
| “无法连接” | 原实例可能已退出，重新启动桌面应用；不要手工固定旧端口或令牌 |
| MCP 没有 5 个工具 | 核对脚本绝对路径，保留整套 `scripts`，重启 MCP 服务 |
| 编辑命令提示未知或参数错误 | 以 `compositor_edit` 的工具 schema 和描述为准；不支持执行任意 JavaScript |
| 图片超过 45 MiB | 用桌面“文件 → 打开”导入，再让 AI 操作当前文档 |
| 图片/输出路径不存在 | 使用真实绝对路径，先创建输出目录 |
| 30 秒超时 | 大图像或复杂滤镜可能阻塞界面；先检查桌面中的实际结果，避免立即重复写入 |
| 只修改了 `.comp` 外部文件而画布不更新 | 本版没有外部文件实时监听，请重新打开工程或通过 MCP 修改 |

开发测试可用 `COMPOSITOR_USER_DATA` 指定独立 profile，`COMPOSITOR_AUTOMATION_FILE` 指定发现文件，`COMPOSITOR_HEADLESS=1` 隐藏编辑器窗口。使用自定义发现文件时，桌面应用与 MCP 进程必须设置相同路径。
