# 验证记录

本版本在 Windows x64 环境构建并测试。检查结果针对所列测试场景，不表示与原版 Compositor 或 Photoshop 完全兼容。

## 实际执行的检查

- TypeScript 类型检查与 Vite 生产构建通过。
- Canvas 引擎：15 项真实浏览器像素检查，包含透明度、27 种混合模式、组、蒙版、剪贴、变换、调整、滤镜及选区。
- 文件读写：7 项真实浏览器往返检查，包含可编辑 CWDoc、PSD 层级与蒙版、原版 COMP、格式降级提示、缺失资源和路径校验。
- AI 自动化：15 组检查通过。隔离启动真实 Electron，通过本机认证 HTTP 执行编辑、PNG 像素检查、工程保存/回读、失败批处理回滚、锁定、蒙版与图层置入。
- 桌面界面：10 项检查通过。新建、鼠标绘制、原生撤销/重做快捷键、画笔、选区与蒙版、AI 命令面板、锁定、文本剪贴板、最小窗口布局。
- 文件操作与 MCP：18 项测试通过，包含路径穿越、Windows 目录链接、工程替换与故障回滚、认证、RPC、工具定义、错误返回、打开/置入与导出。
- Windows 便携包：从打包 EXE 启动并读取文档状态；用自带运行时完成 MCP 握手及工具列表，无需 Node.js。

界面已检查默认窗口和最小窗口；主画布、工具栏、图层及底部状态栏可用。属性、图层和历史面板可在面板内部滚动。

## 源码中的复现入口

```powershell
npm install
npm run build
npm test
node tests/run-engine.mjs
node tests/run-io.mjs
node tests/automation.integration.mjs --launch
node tests/ui-native.mjs
npm run package
node tests/run-packaged.mjs
```

浏览器像素测试需要本机 Edge 或 Playwright 浏览器。桌面集成测试使用独立用户数据目录，避免修改实际工程。测试生成的文件放在 `work/` 下。

## 尚未覆盖

未对大量第三方 PSD/COMP 文件、全部字体、不同数位板、低内存设备、极大画布、Windows ARM 设备及长期连续工作进行全面验收。高级功能和转换限制详见 `FEATURE_PARITY.md`。
