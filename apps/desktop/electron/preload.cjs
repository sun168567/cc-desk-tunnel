const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  dev: process.argv.includes('--cc-desk-tunnel-dev'),
  platform: process.platform,
  // Read once, before the page draws: see `boot` in main.cjs.
  boot: ipcRenderer.sendSync('boot'),
  saveShared: (key, value) => ipcRenderer.invoke('shared:save', key, value),
  onSharedChanged: (callback) => {
    const listener = (_event, key, value) => callback(key, value);
    ipcRenderer.on('shared:changed', listener);
    return () => ipcRenderer.removeListener('shared:changed', listener);
  },
  setBusy: (runs) => ipcRenderer.invoke('busy:set', runs),
  connections: () => ipcRenderer.invoke('connections:list'),
  createConnection: (name) => ipcRenderer.invoke('connections:create', name),
  openConnection: (id) => ipcRenderer.invoke('connections:open', id),
  renameConnection: (id, name) => ipcRenderer.invoke('connections:rename', id, name),
  removeConnection: (id) => ipcRenderer.invoke('connections:remove', id),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  asOnDisk: (path) => ipcRenderer.invoke('project:spelling', path),
  foldersExist: (folders) => ipcRenderer.invoke('folders:exist', folders),
  chooseFiles: () => ipcRenderer.invoke('files:choose'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  saveFile: (name, text) => ipcRenderer.invoke('file:save', name, text),
  saveImage: (type, bytes) => ipcRenderer.invoke('image:save', type, bytes),
  openFolder: (directory) => ipcRenderer.invoke('folder:open', directory),
  openLogs: () => ipcRenderer.invoke('log:open'),
  openDevTools: () => ipcRenderer.invoke('devtools:open'),
  gitBranch: (directory) => ipcRenderer.invoke('git:branch', directory),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  openWeb: (url) => ipcRenderer.invoke('web:open', url),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  inspectPath: (path) => ipcRenderer.invoke('path:inspect', path),
  actOnPath: (action, path, options) => ipcRenderer.invoke('path:act', action, path, options),
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
  quit: (all) => ipcRenderer.invoke('app:quit', all),
  version: () => ipcRenderer.invoke('app:version'),
  releaseNotes: (version) => ipcRenderer.invoke('release:notes', version),
  device: () => ipcRenderer.invoke('device:get'),
  installUpdate: (version) => ipcRenderer.invoke('update:install', version),
  onUpdateProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
  upgradeService: (config) => ipcRenderer.invoke('service:upgrade', config),
  openInCcdt: (request) => ipcRenderer.invoke('ccdt:open', request),
  onServiceUpgrade: (callback) => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('service:upgrade-progress', listener);
    return () => ipcRenderer.removeListener('service:upgrade-progress', listener);
  },
  connectProxy: (config) => ipcRenderer.invoke('proxy:connect', config),
  disconnectProxy: () => ipcRenderer.invoke('proxy:disconnect'),
  onProxyClosed: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('proxy:closed', listener);
    return () => ipcRenderer.removeListener('proxy:closed', listener);
  },
});
