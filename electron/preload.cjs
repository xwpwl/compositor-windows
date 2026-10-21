"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  openFiles: () => ipcRenderer.invoke("files:open"),
  openProjectFolder: () => ipcRenderer.invoke("project:open"),
  saveFile: (args) => ipcRenderer.invoke("files:save", args),
  saveProjectFolder: (args) => ipcRenderer.invoke("project:save", args),
  setDirty: (dirty) => ipcRenderer.send("document:dirty", dirty),
  confirmClose: () => ipcRenderer.invoke("document:confirm-close"),
  onMenu: (callback) => {
    if (typeof callback !== "function")
      throw new TypeError("菜单回调必须是函数。");
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("menu:action", listener);
    return () => ipcRenderer.removeListener("menu:action", listener);
  },
  onAutomation: (callback) => {
    if (typeof callback !== "function")
      throw new TypeError("自动化回调必须是函数。");
    const listener = async (_event, request) => {
      let result;
      let error;
      try {
        result = await callback({ action: request.action, args: request.args });
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      }
      ipcRenderer
        .invoke("automation:reply", { id: request.id, result, error })
        .catch(() => {});
    };
    ipcRenderer.on("automation:request", listener);
    ipcRenderer.send("automation:ready");
    return () => ipcRenderer.removeListener("automation:request", listener);
  },
});
