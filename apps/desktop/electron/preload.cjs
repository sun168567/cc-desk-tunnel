const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');
// A request to the main process. Electron puts "Error invoking remote method '…': Error: " before what a
// failure says; the page gets the words alone.
const invoke = (...args) =>
  ipcRenderer.invoke(...args).catch((error) => {
    throw new Error(
      String(error?.message ?? error).replace(
        /^Error invoking remote method '[^']+': (?:\w*Error: )?/,
        '',
      ),
    );
  });
contextBridge.exposeInMainWorld('desktop', {
  dev: process.argv.includes('--cc-desk-tunnel-dev'),
  platform: process.platform,
  // Read once, before the page draws: see `boot` in main.cjs.
  boot: ipcRenderer.sendSync('boot'),
  saveShared: (key, value) => invoke('shared:save', key, value),
  legacyProjects: () => invoke('projects:legacy'),
  legacyProjectsMoved: () => invoke('projects:moved'),
  onSharedChanged: (callback) => {
    const listener = (_event, key, value) => callback(key, value);
    ipcRenderer.on('shared:changed', listener);
    return () => ipcRenderer.removeListener('shared:changed', listener);
  },
  setBusy: (runs) => invoke('busy:set', runs),
  accounts: () => invoke('accounts:list'),
  openAccount: (id) => invoke('accounts:open', id),
  renameAccount: (id, name) => invoke('accounts:rename', id, name),
  forgetAccount: (id) => invoke('accounts:forget', id),
  newLoginWindow: () => invoke('login:window'),
  chooseProject: () => invoke('project:choose'),
  asOnDisk: (path) => invoke('project:spelling', path),
  foldersExist: (folders) => invoke('folders:exist', folders),
  chooseFiles: () => invoke('files:choose'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  saveFile: (name, text) => invoke('file:save', name, text),
  saveImage: (type, bytes) => invoke('image:save', type, bytes),
  openFolder: (directory) => invoke('folder:open', directory),
  openLogs: () => invoke('log:open'),
  openDevTools: () => invoke('devtools:open'),
  gitBranch: (directory) => invoke('git:branch', directory),
  files: {
    list: (target, directory) => invoke('panel:list', target, directory),
    home: (target) => invoke('panel:home', target),
    chooseFolder: () => invoke('panel:choose-folder'),
    stat: (target, file) => invoke('panel:stat', target, file),
    read: (target, file, limit) => invoke('panel:read', target, file, limit),
    mkdir: (target, directory) => invoke('panel:mkdir', target, directory),
    rename: (target, from, to) => invoke('panel:rename', target, from, to),
    remove: (target, files) => invoke('panel:remove', target, files),
    exists: (target, directory, names) => invoke('panel:exists', target, directory, names),
    transfer: (id, request) => invoke('panel:transfer', id, request),
    cancel: (id) => invoke('panel:cancel', id),
    changes: (directory) => invoke('panel:changes', directory),
    drag: (file) => ipcRenderer.send('panel:drag', file),
    onProgress: (callback) => {
      const listener = (_event, id, report) => callback(id, report);
      ipcRenderer.on('panel:progress', listener);
      return () => ipcRenderer.removeListener('panel:progress', listener);
    },
  },
  copyText: (text) => invoke('clipboard:write', text),
  openExternal: (url) => invoke('external:open', url),
  openWeb: (url) => invoke('web:open', url),
  openLink: (url) => invoke('link:open', url),
  inspectPath: (path) => invoke('path:inspect', path),
  actOnPath: (action, path, options) => invoke('path:act', action, path, options),
  workspaceRoots: () => invoke('workspace:roots'),
  chooseWorkspace: (reset) => invoke('workspace:choose', reset),
  createWorkspace: () => invoke('workspace:create'),
  removeWorkspace: (directory) => invoke('workspace:remove', directory),
  loadLogin: () => invoke('login:load'),
  loadLauncher: () => invoke('launcher:load'),
  saveLogin: (login) => invoke('login:save', login),
  signOut: (error) => invoke('login:leave', error),
  startSignIn: (login) => invoke('launcher:start', login),
  cancelSignIn: () => invoke('launcher:cancel'),
  widenLauncher: (wide) => invoke('launcher:wide', wide),
  reportSignIn: (report) => invoke('signin:report', report),
  onSignIn: (callback) => {
    const listener = (_event, report) => callback(report);
    ipcRenderer.on('signin:report', listener);
    return () => ipcRenderer.removeListener('signin:report', listener);
  },
  loadDrafts: () => invoke('drafts:load'),
  saveDrafts: (drafts) => invoke('drafts:save', drafts),
  loadSchedules: (initial) => invoke('schedules:load', initial),
  saveSchedules: (text) => invoke('schedules:save', text),
  onSchedulesChanged: (callback) => {
    const listener = (_event, text) => callback(text);
    ipcRenderer.on('schedules:changed', listener);
    return () => ipcRenderer.removeListener('schedules:changed', listener);
  },
  windowSettings: () => invoke('window:settings'),
  setWindowSettings: (values) => invoke('window:settings:set', values),
  notify: (notice) => invoke('notify:show', notice),
  onNotifyClicked: (callback) => {
    const listener = (_event, sessionId) => callback(sessionId);
    ipcRenderer.on('notify:clicked', listener);
    return () => ipcRenderer.removeListener('notify:clicked', listener);
  },
  zoom: (direction) =>
    webFrame.setZoomLevel(direction ? webFrame.getZoomLevel() + Math.sign(direction) * 0.5 : 0),
  quit: () => invoke('app:quit'),
  version: () => invoke('app:version'),
  releaseNotes: (version) => invoke('release:notes', version),
  device: () => invoke('device:get'),
  installUpdate: (version) => invoke('update:install', version),
  cancelUpdate: () => invoke('update:cancel'),
  probeService: (config) => invoke('service:probe', config),
  onUpdateProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
  upgradeService: (config) => invoke('service:upgrade', config),
  openInCcdt: (request) => invoke('ccdt:open', request),
  onServiceUpgrade: (callback) => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('service:upgrade-progress', listener);
    return () => ipcRenderer.removeListener('service:upgrade-progress', listener);
  },
  connectProxy: (config) => invoke('proxy:connect', config),
  disconnectProxy: () => invoke('proxy:disconnect'),
  onProxyClosed: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('proxy:closed', listener);
    return () => ipcRenderer.removeListener('proxy:closed', listener);
  },
});

// The update helper receives a receipt only after React has rendered the first application screen.
window.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('root');
  if (!root) return;
  const announce = () => {
    if (!root.firstElementChild) return;
    observer.disconnect();
    ipcRenderer.send('update:ready');
  };
  const observer = new MutationObserver(announce);
  observer.observe(root, { childList: true });
  announce();
});
