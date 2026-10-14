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
  previewFile: (path) => ipcRenderer.invoke('attachment:preview', path),
  readTextFile: (path) => ipcRenderer.invoke('file:read-text', path),
  searchFiles: (directory, query) => ipcRenderer.invoke('attachment:search', directory, query),
  pathForFile: (file) => webUtils.getPathForFile(file),
  saveFile: (name, text) => ipcRenderer.invoke('file:save', name, text),
  saveImage: (type, bytes) => ipcRenderer.invoke('image:save', type, bytes),
  openFolder: (directory) => ipcRenderer.invoke('folder:open', directory),
  openChangedFile: (path, reveal) => ipcRenderer.invoke('changed-file:open', path, reveal),
  openLogs: () => ipcRenderer.invoke('log:open'),
  openDevTools: () => ipcRenderer.invoke('devtools:open'),
  gitBranch: (directory) => ipcRenderer.invoke('git:branch', directory),
  // Snapshot the project before a turn, then read what changed on disk once its commands have finished.
  beginProjectDiff: (id, directory) => ipcRenderer.invoke('project-diff:begin', id, directory),
  finishProjectDiff: (id) => ipcRenderer.invoke('project-diff:finish', id),
  dropProjectDiff: (id) => ipcRenderer.invoke('project-diff:drop', id),
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
  loadAttachments: (messageId) => ipcRenderer.invoke('attachments:load', messageId),
  saveAttachments: (messageId, attachments, sessionId) =>
    ipcRenderer.invoke('attachments:save', messageId, attachments, sessionId),
  deleteAttachments: (messageId) => ipcRenderer.invoke('attachments:delete', messageId),
  deleteSessionAttachments: (sessionId) =>
    ipcRenderer.invoke('attachments:delete-session', sessionId),
  loadSchedules: (initial) => ipcRenderer.invoke('schedules:load', initial),
  saveSchedules: (text) => ipcRenderer.invoke('schedules:save', text),
  onSchedulesChanged: (callback) => {
    const listener = (_event, text) => callback(text);
    ipcRenderer.on('schedules:changed', listener);
    return () => ipcRenderer.removeListener('schedules:changed', listener);
  },
  windowSettings: () => ipcRenderer.invoke('window:settings'),
  setWindowSettings: (values) => ipcRenderer.invoke('window:settings:set', values),
  setTheme: (mode) => ipcRenderer.invoke('window:theme', mode),
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
  username: () => ipcRenderer.invoke('os:username'),
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
