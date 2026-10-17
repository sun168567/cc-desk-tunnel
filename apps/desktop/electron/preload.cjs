const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  dev: process.argv.includes('--cc-desk-tunnel-dev'),
  remoteStatus: () => ipcRenderer.invoke('remote:status'),
  openRemote: () => ipcRenderer.invoke('remote:open'),
  configureRemote: (values) => ipcRenderer.invoke('remote:configure', values),
  resetRemotePairing: () => ipcRenderer.invoke('remote:reset-pairing'),
  revokeRemoteSession: (id) => ipcRenderer.invoke('remote:revoke-session', id),
  onRemoteSessionsChanged: (callback) => {
    const listener = (_event, sessions) => callback(sessions);
    ipcRenderer.on('remote:sessions-changed', listener);
    return () => ipcRenderer.removeListener('remote:sessions-changed', listener);
  },
  onRemoteEnabledChanged: (callback) => {
    const listener = (_event, enabled) => callback(enabled);
    ipcRenderer.on('remote:enabled-changed', listener);
    callback(ipcRenderer.sendSync('remote:enabled'));
    return () => ipcRenderer.removeListener('remote:enabled-changed', listener);
  },
  onRemoteRequest: (methods, callback) => {
    const listener = (_event, request) => {
      if (!methods.includes(request.method)) return;
      void Promise.resolve()
        .then(() => callback(request))
        .then(
          (result) => ipcRenderer.send('remote:response', { id: request.id, ok: true, result }),
          (error) =>
            ipcRenderer.send('remote:response', {
              id: request.id,
              ok: false,
              error: error instanceof Error ? error.message : '桌面操作失败。',
            }),
        );
    };
    ipcRenderer.on('remote:request', listener);
    return () => ipcRenderer.removeListener('remote:request', listener);
  },
  publishRemoteEvent: (event) => ipcRenderer.send('remote:event', event),
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
  readRemoteSchedules: () => ipcRenderer.invoke('remote:schedules:read'),
  saveRemoteSchedules: (text, revision) =>
    ipcRenderer.invoke('remote:schedules:save', text, revision),
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
