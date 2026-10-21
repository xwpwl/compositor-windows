"use strict";

const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  session,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const {
  allowedRendererURL,
  validatedDevURL,
  suggestedName,
  validateBytes,
  validateProjectFiles,
  readSelectedFile,
  readProjectFolder,
  atomicWriteFile,
  atomicWriteProject,
  existingStat,
  LIMITS,
} = require("./files.cjs");
const { createAutomationBridge } = require("./automation.cjs");

app.setName("Compositor Windows");
const userData = process.env.COMPOSITOR_USER_DATA
  ? path.resolve(process.env.COMPOSITOR_USER_DATA)
  : path.join(app.getPath("appData"), "Compositor Windows");
fs.mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
const indexPath = path.join(__dirname, "..", "dist", "index.html");
const devURL = validatedDevURL(process.env.COMPOSITOR_DEV_URL);
const headless = process.env.COMPOSITOR_HEADLESS === "1";
let mainWindow;
let dirty = false;
let closingApproved = false;
let closeDialogOpen = false;
let saveThenClose = false;
let cleanupStarted = false;
let cleanupFinished = false;

const automation = createAutomationBridge({ app, getWindow: () => mainWindow });
function trusted(event) {
  return (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    allowedRendererURL(event.senderFrame.url, { devURL, indexPath })
  );
}
function assertTrusted(event) {
  if (!trusted(event)) throw new Error("拒绝非编辑器页面的请求。");
}
function menuAction(action) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send("menu:action", action);
}

const menuItem = (label, action, accelerator) => ({
  label,
  accelerator,
  click: () => menuAction(action),
});
function installMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "文件",
        submenu: [
          menuItem("新建…", "new", "CmdOrCtrl+N"),
          menuItem("打开图像或工程…", "open", "CmdOrCtrl+O"),
          menuItem("打开 .comp 工程文件夹…", "open-comp"),
          { type: "separator" },
          menuItem("保存工程", "save", "CmdOrCtrl+S"),
          menuItem("工程另存为…", "save-as", "CmdOrCtrl+Shift+S"),
          {
            label: "导出",
            submenu: [
              menuItem("PNG 图像…", "export-png"),
              menuItem("JPEG 图像…", "export-jpeg"),
              menuItem("PSD 分层文件…", "export-psd"),
              menuItem(".comp 工程文件夹…", "export-comp"),
            ],
          },
          { type: "separator" },
          {
            label: "退出",
            accelerator: "Alt+F4",
            click: () => mainWindow?.close(),
          },
        ],
      },
      {
        label: "编辑",
        submenu: [
          menuItem("撤销", "undo", "CmdOrCtrl+Z"),
          menuItem("重做", "redo", "CmdOrCtrl+Shift+Z"),
          { type: "separator" },
          menuItem("剪切", "cut", "CmdOrCtrl+X"),
          menuItem("复制", "copy", "CmdOrCtrl+C"),
          menuItem("粘贴", "paste", "CmdOrCtrl+V"),
        ],
      },
      {
        label: "选择",
        submenu: [
          menuItem("全选", "select-all", "CmdOrCtrl+A"),
          menuItem("取消选择", "deselect", "CmdOrCtrl+D"),
          menuItem("反向选择", "invert-selection", "CmdOrCtrl+Shift+I"),
        ],
      },
      {
        label: "视图",
        submenu: [
          menuItem("放大", "zoom-in", "CmdOrCtrl+="),
          menuItem("缩小", "zoom-out", "CmdOrCtrl+-"),
          menuItem("适合窗口", "fit", "CmdOrCtrl+0"),
          menuItem("实际大小", "actual", "CmdOrCtrl+1"),
          { type: "separator" },
          menuItem("网格", "grid", "CmdOrCtrl+'"),
          menuItem("标尺", "rulers", "CmdOrCtrl+R"),
        ],
      },
      {
        label: "帮助",
        submenu: [
          {
            label: "关于 Compositor Windows",
            click: () =>
              dialog.showMessageBox(mainWindow, {
                type: "info",
                title: "Compositor Windows",
                message: "Compositor Windows 社区重写版",
                detail: `独立的 Windows 图像编辑器，支持本地 AI 自动化。\n版本 ${app.getVersion()}\n本地自动化发现文件：${automation.discoveryPath}`,
              }),
          },
        ],
      },
    ]),
  );
}

async function confirmDiscard() {
  if (!dirty) return true;
  const result = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "尚未保存",
    message: "当前工程有尚未保存的更改。",
    detail: "继续将放弃这些更改。",
    buttons: ["取消", "放弃更改并继续"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
}

function safeFilters(value) {
  if (value === undefined) return [{ name: "所有文件", extensions: ["*"] }];
  if (!Array.isArray(value) || value.length > 10)
    throw new Error("文件筛选条件无效。");
  return value.map((filter) => {
    if (
      !filter ||
      typeof filter.name !== "string" ||
      !Array.isArray(filter.extensions) ||
      !filter.extensions.length ||
      filter.extensions.length > 20 ||
      filter.extensions.some(
        (extension) =>
          typeof extension !== "string" ||
          !/^(?:[a-zA-Z0-9]{1,12}|\*)$/.test(extension),
      )
    )
      throw new Error("文件扩展名无效。");
    return { name: filter.name.slice(0, 80), extensions: filter.extensions };
  });
}

function registerIPC() {
  const handle = (channel, callback) =>
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrusted(event);
      try {
        return await callback(...args);
      } catch (error) {
        if (channel === "files:save" || channel === "project:save")
          saveThenClose = false;
        throw error;
      }
    });
  handle("files:open", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "打开图像或工程",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "图像与工程",
          extensions: [
            "png",
            "jpg",
            "jpeg",
            "webp",
            "gif",
            "bmp",
            "svg",
            "psd",
            "psb",
            "comp",
            "cwdoc",
            "zip",
            "json",
          ],
        },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (result.canceled) return null;
    if (result.filePaths.length > 64)
      throw new Error("一次最多打开 64 个文件。");
    const files = [];
    let total = 0;
    for (const filename of result.filePaths) {
      const file = await readSelectedFile(filename);
      total += file.bytes.byteLength;
      if (total > LIMITS.total)
        throw new Error("所选文件总大小不能超过 1 GB。");
      files.push(file);
    }
    return files;
  });
  handle("project:open", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 .comp 工程文件夹",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return readProjectFolder(result.filePaths[0]);
  });
  handle("files:save", async (args) => {
    if (!args || typeof args !== "object") throw new Error("保存参数无效。");
    validateBytes(args.bytes);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "保存文件",
      defaultPath: suggestedName(args.name),
      filters: safeFilters(args.filters),
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (result.canceled || !result.filePath) {
      saveThenClose = false;
      return null;
    }
    await atomicWriteFile(result.filePath, args.bytes);
    return result.filePath;
  });
  handle("project:save", async (args) => {
    if (!args || typeof args !== "object")
      throw new Error("工程保存参数无效。");
    validateProjectFiles(args.files);
    let name = suggestedName(args.name, "未命名.comp");
    if (!name.toLowerCase().endsWith(".comp")) name += ".comp";
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "保存 .comp 工程文件夹",
      defaultPath: name,
      filters: [{ name: "Compositor 工程文件夹", extensions: ["comp"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (result.canceled || !result.filePath) {
      saveThenClose = false;
      return null;
    }
    const target = result.filePath.toLowerCase().endsWith(".comp")
      ? result.filePath
      : `${result.filePath}.comp`;
    const stat = await existingStat(target);
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("目标已经存在，且不是普通工程文件夹。");
      const confirm = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "覆盖工程",
        message: "覆盖所选工程文件夹？",
        detail: target,
        buttons: ["取消", "覆盖"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirm.response !== 1) {
        saveThenClose = false;
        return null;
      }
    }
    await atomicWriteProject(target, args.files);
    return target;
  });
  handle("document:confirm-close", confirmDiscard);
  handle("automation:reply", (payload) => automation.reply(payload));
  ipcMain.on("automation:ready", (event) => {
    if (!trusted(event)) return;
    automation.start().catch((error) => {
      console.error("本地自动化服务启动失败：", error);
      if (!headless) dialog.showErrorBox("本地自动化不可用", error.message);
    });
  });
  ipcMain.on("document:dirty", (event, value) => {
    if (!trusted(event) || typeof value !== "boolean") return;
    dirty = value;
    mainWindow.setDocumentEdited(dirty);
    if (!dirty && saveThenClose) {
      saveThenClose = false;
      closingApproved = true;
      mainWindow.close();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1060,
    minHeight: 720,
    show: false,
    title: "Compositor Windows",
    backgroundColor: "#111217",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!allowedRendererURL(url, { devURL, indexPath })) event.preventDefault();
  });
  mainWindow.webContents.on("will-redirect", (event, url) => {
    if (!allowedRendererURL(url, { devURL, indexPath })) event.preventDefault();
  });
  mainWindow.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  mainWindow.once("ready-to-show", () => {
    if (!headless) mainWindow.show();
  });
  mainWindow.on("close", (event) => {
    if (!dirty || closingApproved) return;
    event.preventDefault();
    if (closeDialogOpen) return;
    closeDialogOpen = true;
    dialog
      .showMessageBox(mainWindow, {
        type: "warning",
        title: "保存更改",
        message: "关闭前保存工程更改？",
        detail: "尚未保存的更改将会丢失。",
        buttons: ["取消", "不保存并关闭", "保存"],
        defaultId: 2,
        cancelId: 0,
        noLink: true,
      })
      .then((result) => {
        if (result.response === 1) {
          closingApproved = true;
          mainWindow.close();
        }
        if (result.response === 2) {
          saveThenClose = true;
          menuAction("save");
        }
      })
      .finally(() => {
        closeDialogOpen = false;
      });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (devURL) mainWindow.loadURL(devURL);
  else mainWindow.loadFile(indexPath);
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on("will-download", (event) => event.preventDefault());
  registerIPC();
  installMenu();
  createWindow();
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (mainWindow && dirty && !closingApproved) {
    event.preventDefault();
    mainWindow.close();
    return;
  }
  if (!cleanupFinished) {
    event.preventDefault();
    if (!cleanupStarted) {
      cleanupStarted = true;
      automation.dispose().finally(() => {
        cleanupFinished = true;
        app.quit();
      });
    }
  }
});
