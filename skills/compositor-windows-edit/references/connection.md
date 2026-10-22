# 连接、脚本与大文件

## 一键连接：推荐安装方式

先运行 GitHub Releases 中的 Windows 安装程序，或按仓库说明从源码构建应用。每用户安装的默认应用目录为 `%LOCALAPPDATA%\Programs\Compositor Windows`；若安装时选择了其他位置，以实际位置为准。应用目录中应有 `Compositor Windows.exe` 和 `scripts/mcp-server.mjs`，不要只复制 EXE。

安装并登录 Codex 后，在 Compositor Windows 顶栏点击 **连接 Codex**，进入 **Codex** 面板，点击 **一键连接 Codex**。程序会定位已安装的 Codex CLI，将完整 Skill 安装到用户技能目录，生成填写实际应用路径的 `local-config.json`，并注册 `compositor_windows` MCP。找不到 CLI 时点击 **选择 Codex 程序**，选择已有的 `codex.exe`；不会自动下载或登录 Codex。

新用户默认安装到 `%USERPROFILE%\.agents\skills\compositor-windows-edit`。程序也检查当前 Codex profile 的 `skills` 目录和旧 `%USERPROFILE%\.codex\skills`，已有唯一一份本 Skill 时在原位置更新；profile 目录由 `CODEX_HOME` 决定，未设置时为 `%USERPROFILE%\.codex`。不要在多个目录同时安装同名 Skill。连接界面显示实际目标位置，更新前备份原 Skill 和配置；同名副本冲突时先处理界面指出的位置。

点击 **测试本机连接** 确认桥接能读取正在运行的编辑器，然后重启 Codex 并开启新聊天，让它加载 Skill 和 MCP。测试本机连接不代表旧聊天已刷新。首次工具调用时按 Codex 提示授权；配置过程不会更改审批或沙箱设置。更新或移动应用后，可用 **更新 / 修复配置** 更新连接路径。

若 MCP 已被禁用或限制工具，一键连接会保留限制并提示在 Codex 中处理，不会自行启用。同名 HTTP 服务不会被替换。备份位于当前 Codex profile 的 `compositor-backups` 目录，包含原文件和 `restore-info.json`；界面显示具体位置。

当前位置与配置规则参考 [OpenAI 官方 Skill 文档](https://learn.chatgpt.com/docs/build-skills)、[MCP 文档](https://learn.chatgpt.com/docs/extend/mcp) 和 [CODEX_HOME 说明](https://learn.chatgpt.com/docs/config-file/environment-variables)。一键连接面向本机 Windows Codex，不会让网页聊天自动访问电脑。

## 手动安装 Skill 与配置应用目录

配套 Skill 位于应用安装目录的 `skills/compositor-windows-edit`，也可从同一 Release 下载独立 Skill ZIP 并解压；源码仓库中也有同一文件夹。新装时把 `compositor-windows-edit` 整个文件夹复制到 `%USERPROFILE%\.agents\skills`。如果当前 profile 的 `%CODEX_HOME%\skills`（默认 `%USERPROFILE%\.codex\skills`）已经有本 Skill，则备份后更新该位置，不另装一份。确认最终路径是 `…\skills\compositor-windows-edit\SKILL.md`，并保留 `scripts`、`references` 和 `agents` 子目录；不要只复制 `SKILL.md` 或多套一层文件夹。重新加载 skills 或开启新聊天后，可用 `$compositor-windows-edit` 调用。

在安装后的 skill 根目录，把 [local-config.example.json](../local-config.example.json) 复制为 `local-config.json`，将 `appDirectory` 改成实际应用目录的完整路径。这里不会展开 `%LOCALAPPDATA%` 等环境变量；JSON 中使用正斜杠或双反斜杠。示例中的 `C:/Apps/Compositor-Windows` 只是自选安装位置示例，不代表程序已安装：

```json
{"appDirectory":"C:/Apps/Compositor-Windows"}
```

也可不创建配置文件，在每次运行时传 `-AppDir`，或仅为当前进程设置 `COMPOSITOR_APP_DIR`。优先级为 `-AppDir` > `COMPOSITOR_APP_DIR` > `local-config.json`；建议使用绝对路径。配置文件中的相对路径以 skill 根目录为基准，命令参数和环境变量中的相对路径以当前工作目录为基准。以下命令在 skill 目录运行：

```powershell
$compositorAppDir = Join-Path $env:LOCALAPPDATA 'Programs\Compositor Windows'
# 若安装时选择了其他目录，将上面的值改为实际绝对路径。
.\scripts\Invoke-Compositor.ps1 -ListTools -AppDir $compositorAppDir
# 或为当前 PowerShell 会话指定目录：
$env:COMPOSITOR_APP_DIR = $compositorAppDir
.\scripts\Invoke-Compositor.ps1 -ListTools
```

移动应用后更新上述路径；移动 skill 后，确认配置文件仍在新的 skill 根目录。`local-config.json` 是个人本机配置，不提交到仓库。不要通过整盘搜索或读取其他账号配置来猜测路径。

安装程序附带 Skill；应用中的一键连接负责安装 Skill 并配置 MCP。仅手动复制 Skill 不会注册 MCP 服务。若要手动注册，按应用目录中的 `AI_WORKFLOW.md` 配置 `compositor_windows`，并将启动命令指向实际应用目录。重新加载 MCP 或重启 Codex、开启新聊天后检查工具是否可用。未注册服务或当前聊天未加载工具时，可直接使用下面的 fallback 脚本；它不要求修改 Codex 全局配置。

## 启动与连接

先调用 `compositor_get_state`。软件未运行时启动已配置应用目录下的 `Compositor Windows.exe`，这是用户要查看和操作的编辑器，使用可见窗口。确保启动编辑器的进程没有 `ELECTRON_RUN_AS_NODE=1`，不要继承测试专用 `COMPOSITOR_HEADLESS`、`COMPOSITOR_DEV_URL` 或独立 profile 变量；也不要更改系统环境。连接脚本会用同一 EXE 以 Node 模式启动短期桥接进程，不打开第二个编辑器窗口。`-ListTools` 只验证桥接工具可列出；还需成功读取状态和画布，才能确认连接到运行中的编辑器。

桥接默认读取当前 Windows 用户的 `%APPDATA%\Compositor Windows\automation.json`。它包含认证令牌，不要输出、分享或放进交付包。独立测试 profile 可显式设置 `COMPOSITOR_AUTOMATION_FILE`；正常操作不用设置它。

## 随附 fallback 脚本

优先用已加载的 MCP 工具。需要脚本时，在 skill 目录运行以下 PowerShell 命令（或使用脚本的绝对路径）：

```powershell
.\scripts\Invoke-Compositor.ps1 -ListTools
.\scripts\Invoke-Compositor.ps1 -Tool compositor_get_state
.\scripts\Invoke-Compositor.ps1 -Tool compositor_get_canvas -ImagePath 'C:\任务目录\work\preview-01.png'
```

脚本使用软件自带运行时，无需另装 Node.js，不会启动 GUI、不重试编辑、不修改 Codex 配置。路径含中文或空格时使用独立参数。`-ImagePath` 和可选 `-ResultPath` 不能覆盖已有文件；为每轮预览/状态选择新路径。预览文件保存后用可用看图工具检查，不把 base64 打印到聊天里。

带参数的工具先写一个 UTF-8 JSON 文件，然后传 `-ArgsFile`，避免 PowerShell 多层 JSON 引号问题。例如将下面内容写入当前任务 `work/open-image.json`：

```json
{"path":"C:/图片目录/照片.jpg"}
```

```powershell
.\scripts\Invoke-Compositor.ps1 -Tool compositor_open_image -ArgsFile 'C:\任务目录\work\open-image.json'
.\scripts\Invoke-Compositor.ps1 -Tool compositor_get_state -ResultPath 'C:\任务目录\work\state-01.json'
```

`compositor_edit` 的参数文件包含整个 `{"action":"...","args":{...}}`；`compositor_export` 包含 `path` 和 `format`。这里的文件路径是示例，执行时使用本次任务实际路径。工具层导出会替换同名普通文件，调用前按用户要求选好输出路径；脚本的 `-ImagePath/-ResultPath` 防覆盖不改变软件的导出行为。

如果直接用 Node.js，可运行 `node scripts/mcp-client.mjs --help` 查看等价参数。运行脚本遇到执行权限或本机网络权限限制时，按当前环境的正常授权机制处理；不要关闭安全设置或更改全局执行策略。

## 超过 45 MiB 的输入/工程

MCP 打开文件当前上限是 `45 × 1024 × 1024` 字节；不是图片像素数。工程保留全尺寸原像素，即使导出的 JPG 很小、画布已裁剪，`.cwdoc` 仍可能超过上限。不要为绕过传输限制，擅自降分辨率、拼接 base64 或修改程序限制。

有可用的 Windows Computer Use 能力时，先读取该能力的 skill，再定位 **Compositor Windows** 的实际窗口，通过 `Ctrl+O` 或“文件 → 打开”选择绝对文件路径。这属于本地打开文件，不是上传或终端命令。没有可用原生控制能力时，让用户在软件内打开该文件；收到打开状态后继续用 MCP。

原生打开通常增加一个文档。读取新状态，确认新文档 ID、尺寸、图层、参数和预览；不要仅看窗口标题。文件对话框的元素索引可能随状态变化，操作后刷新。若可访问性焦点与画面不一致，按 Computer Use 指引重新观察并使用当前截图定位，确认文件名字段显示目标路径再打开；不要把同一场景中的索引记为固定值。

## 请求失败

- 本机网络请求在受限沙箱内失败、但应用仍运行：这不证明程序已退出。检查已知实例，用环境支持的授权机制执行同一只读状态检查。
- 文件超过上限：走原生打开；仍可正常通过 MCP 读画布、调色和导出。
- 输出父目录不存在：创建用户指定/任务工作区内的目录，再导出。
- 超时：先读状态和画布。操作可能已执行，自动重试会重复修改。若状态也无法读取，观察桌面是否在计算或等待对话框，再向用户说明当前状态。
- 脚本报告错误或终止：不等于桌面操作回滚。它只结束自己启动的桥接进程，不关闭用户编辑器。
