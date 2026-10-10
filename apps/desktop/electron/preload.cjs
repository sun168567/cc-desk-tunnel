const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  dev: process.argv.includes('--cc-desk-tunnel-dev'),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  chooseFiles: () => ipcRenderer.invoke('files:choose'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  saveFile: (name, text) => ipcRenderer.invoke('file:save', name, text),
  openFolder: (directory) => ipcRenderer.invoke('folder:open', directory),
  gitBranch: (directory) => ipcRenderer.invoke('git:branch', directory),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  workspaceRoots: () => ipcRenderer.invoke('workspace:roots'),
  chooseWorkspace: (reset) => ipcRenderer.invoke('workspace:choose', reset),
  createWorkspace: () => ipcRenderer.invoke('workspace:create'),
  removeWorkspace: (directory) => ipcRenderer.invoke('workspace:remove', directory),
  loadLogin: () => ipcRenderer.invoke('login:load'),
  saveLogin: (login) => ipcRenderer.invoke('login:save', login),
  loadDrafts: () => ipcRenderer.invoke('drafts:load'),
  saveDrafts: (drafts) => ipcRenderer.invoke('drafts:save', drafts),
  loadSchedules: (initial) => ipcRenderer.invoke('schedules:load', initial),
  saveSchedules: (text) => ipcRenderer.invoke('schedules:save', text),
  onSchedulesChanged: (callback) => {
    const listener = (_event, text) => callback(text);
    ipcRenderer.on('schedules:changed', listener);
    return () => ipcRenderer.removeListener('schedules:changed', listener);
  },
  windowSettings: () => ipcRenderer.invoke('window:settings'),
  setWindowSettings: (values) => ipcRenderer.invoke('window:settings:set', values),
  notify: (notice) => ipcRenderer.invoke('notify:show', notice),
  onNotifyClicked: (callback) => {
    const listener = (_event, sessionId) => callback(sessionId);
    ipcRenderer.on('notify:clicked', listener);
    return () => ipcRenderer.removeListener('notify:clicked', listener);
  },
  zoom: (direction) =>
    webFrame.setZoomLevel(direction ? webFrame.getZoomLevel() + Math.sign(direction) * 0.5 : 0),
  quit: () => ipcRenderer.invoke('app:quit'),
  version: () => ipcRenderer.invoke('app:version'),
  installUpdate: (version) => ipcRenderer.invoke('update:install', version),
  onUpdateProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
  connectProxy: (config) => ipcRenderer.invoke('proxy:connect', config),
  disconnectProxy: () => ipcRenderer.invoke('proxy:disconnect'),
  onProxyClosed: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('proxy:closed', listener);
    return () => ipcRenderer.removeListener('proxy:closed', listener);
  },
});
