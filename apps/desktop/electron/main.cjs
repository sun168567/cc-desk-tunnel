const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  nativeImage,
  powerSaveBlocker,
  safeStorage,
  session,
  ipcMain,
  dialog,
  shell,
  clipboard,
  net,
} = require('electron');
const path = require('node:path');
const {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} = require('node:fs');
const { mkdtemp, stat, writeFile } = require('node:fs/promises');
const { gitBranch } = require('./git-branch.cjs');
const { previewFile, searchFiles, readTextFile } = require('./local-files.cjs');
const { asOnDisk } = require('./disk-path.cjs');
const { openLog } = require('./client-log.cjs');
const { hostname, tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { mkdir, readdir, rmdir, unlink } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
let bridge;
// The last connection, kept for its installer download after a service refused this client's version.
let lastBridge;
let connectionGeneration = 0;
const connections = require('./connections.cjs');
// See connections.cjs. The profile is chosen before anything is read from it, the instance lock included:
// each connection is then a single instance of its own.
const base = app.getPath('userData');
const connectionId = connections.requested(process.argv, base);
if (connectionId) {
  app.setPath('userData', connections.directory(base, connectionId));
  app.setPath('sessionData', connections.directory(base, connectionId));
}
// `--quit-connection` asks a connection's window to go the way the user's own "退出" does. Where that
// connection has no window, there is nothing to do.
const leaving = process.argv.includes('--quit-connection');
const ownsInstance = app.requestSingleInstanceLock({ leaving }) && !leaving;
if (!ownsInstance) app.quit();
function showWindow() {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
app.on('second-instance', (_event, _argv, _directory, asked) =>
  asked?.leaving ? app.quit() : showWindow(),
);
// macOS: a click on the Dock icon while the window is hidden.
app.on('activate', showWindow);

// Window preferences and the optional saved sign-in live in the user's profile, outside the install directory.
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings(file = settingsPath()) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
function writeSettings(values, file = settingsPath()) {
  const settings = { ...readSettings(file), ...values };
  writeFileSync(file, JSON.stringify(settings, null, 2));
  return settings;
}
// What is the computer's and not a connection's stays with the first connection's settings, where it was
// before there were several: which computer this is, the folders of plain sessions, how the window closes.
const computerPath = path.join(base, 'settings.json');
const readComputer = () => readSettings(computerPath);
const writeComputer = (values) => writeSettings(values, computerPath);

// See client-log.cjs. Opened on first use, once the profile directory is known.
let record;
function log(text) {
  record ??= openLog(path.join(app.getPath('userData'), 'logs'));
  record.write(text);
  return record.directory;
}

// A remote connection carries long unattended runs; the computer must not go to sleep underneath it.
// The display may still turn off.
let awake;
function keepAwake(on) {
  if (on && awake === undefined) awake = powerSaveBlocker.start('prevent-app-suspension');
  if (!on && awake !== undefined) {
    powerSaveBlocker.stop(awake);
    awake = undefined;
  }
}

// These channels answer only the application's own page.
function handle(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!event.senderFrame.url.startsWith('file://')) throw new Error('Untrusted renderer');
    return listener(event, ...args);
  });
}

handle('project:choose', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(window, {
    title: '添加项目',
    properties: ['openDirectory'],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
handle('project:spelling', (_event, written) => asOnDisk(String(written)));
handle('attachment:preview', (_event, file) => previewFile(file));
handle('file:read-text', (_event, file) => readTextFile(file));
handle('attachment:search', (_event, directory, query) => searchFiles(directory, query));
// Which of these folders are on this computer: a session that names no computer is here when its folder is.
handle('folders:exist', (_event, folders) =>
  Promise.all(
    (Array.isArray(folders) ? folders : []).slice(0, 500).map((folder) =>
      stat(String(folder)).then(
        (found) => found.isDirectory(),
        () => false,
      ),
    ),
  ),
);
// Files the user wants to mention in a message: only their paths go to the page.
handle('files:choose', async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: '添加文件',
    properties: ['openFile', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
});
// A picture that is only on the clipboard has no file Claude could be pointed at. It is written into the
// profile, from where Claude reads it like any other attached file; a week later it is removed at start.
const pastedDirectory = () => path.join(app.getPath('userData'), 'pasted');
const pictureTypes = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};
handle('image:save', async (_event, type, bytes) => {
  const extension = pictureTypes[String(type)];
  if (!extension || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 20 << 20)
    throw new Error('只能粘贴不超过 20 MB 的图片。');
  await mkdir(pastedDirectory(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const target = path.join(pastedDirectory(), `${stamp}-${randomUUID().slice(0, 6)}.${extension}`);
  await writeFile(target, bytes);
  return target;
});
async function clearPastedPictures() {
  for (const name of await readdir(pastedDirectory()).catch(() => [])) {
    const file = path.join(pastedDirectory(), name);
    const age = Date.now() - (await stat(file).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
    if (age > 7 * 24 * 3600 * 1000) await unlink(file).catch(() => {});
  }
}
// Writes text the page produced (an exported session) where the user chooses.
handle('file:save', async (event, name, text) => {
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    title: '导出',
    defaultPath: path.join(app.getPath('downloads'), path.basename(String(name))),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return false;
  await writeFile(result.filePath, String(text), 'utf8');
  return true;
});
handle('folder:open', async (_event, directory) => {
  const target = path.resolve(String(directory));
  if (!(await stat(target)).isDirectory()) throw new Error('不是文件夹。');
  const failure = await shell.openPath(target);
  if (failure) throw new Error(failure);
});
handle('changed-file:open', async (_event, file, reveal) => {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0'))
    throw new Error('文件路径无效。');
  const target = path.resolve(file);
  if (!(await stat(target)).isFile()) throw new Error('不是文件。');
  if (reveal === true) shell.showItemInFolder(target);
  else {
    const failure = await shell.openPath(target);
    if (failure) throw new Error(failure);
  }
});
handle('log:open', async () => {
  const failure = await shell.openPath(log('The log folder was opened.'));
  if (failure) throw new Error(failure);
});
// The installed program has no menu that opens the developer tools, and none of the page's shortcuts does:
// they open from the settings page, in a window of their own, for looking into a problem of the interface.
handle('devtools:open', (event) => {
  log('The developer tools were opened.');
  event.sender.openDevTools({ mode: 'detach' });
});
handle('git:branch', (_event, directory) => gitBranch(directory));
handle('clipboard:write', (_event, text) => {
  if (typeof text !== 'string') throw new Error('Expected clipboard text');
  clipboard.writeText(text);
});
// The official sign-in page and this project's own page open in the user's browser; nothing else is handed to the
// system.
handle('external:open', async (event, target) => {
  const url = new URL(String(target));
  if (
    url.protocol !== 'https:' ||
    !/(^|\.)(claude\.com|claude\.ai|anthropic\.com)$|^github\.com$/.test(url.hostname)
  )
    throw new Error('Unexpected link');
  await shell.openExternal(url.toString());
});
// Sessions without a project still need a working directory on this computer; they get one under Documents, grouped by
// day, unless the user chose another folder. Folders used before are remembered: their sessions are still
// sessions without a project.
const defaultRoot = () => path.join(app.getPath('documents'), 'CC Desk Tunnel');
function workspaceRoots() {
  const saved = readComputer().workspaceRoots;
  const roots = [...(Array.isArray(saved) ? saved : []), defaultRoot()].filter(
    (root) => typeof root === 'string' && root,
  );
  // Windows and macOS take a path in any case; Linux tells the cases apart.
  const key = (root) => (process.platform === 'linux' ? root : root.toLowerCase());
  return roots.filter(
    (root, index) => roots.findIndex((item) => key(item) === key(root)) === index,
  );
}
handle('workspace:roots', () => workspaceRoots());
handle('workspace:choose', async (event, reset) => {
  let chosen = defaultRoot();
  if (reset !== true) {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '普通会话的文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return workspaceRoots();
    chosen = result.filePaths[0];
  }
  writeComputer({ workspaceRoots: [chosen, ...workspaceRoots()] });
  return workspaceRoots();
});
handle('workspace:create', async (event) => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const day = path.join(
    workspaceRoots()[0],
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  );
  await mkdir(day, { recursive: true });
  const name = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  for (let attempt = 0; ; attempt++) {
    const directory = path.join(day, attempt ? `${name}-${attempt}` : name);
    try {
      await mkdir(directory);
      return directory;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
});
handle('workspace:remove', async (event, directory) => {
  const target = path.resolve(String(directory));
  if (
    !workspaceRoots().some((root) =>
      /^\d{4}-\d{2}-\d{2}[\\/][^\\/]+$/.test(path.relative(root, target)),
    )
  )
    return;
  // rmdir only removes empty directories, so anything the session produced stays.
  try {
    await rmdir(target);
    await rmdir(path.dirname(target));
  } catch {}
});
handle('proxy:connect', async (event, config) => {
  if (!config || typeof config.url !== 'string' || typeof config.fingerprint !== 'string')
    throw new Error('Invalid proxy configuration');
  const generation = ++connectionGeneration;
  const previous = bridge;
  bridge = null;
  await previous?.close();
  if (generation !== connectionGeneration) throw new Error('Connection cancelled');
  const { openProxyBridge } = await import(
    pathToFileURL(path.join(__dirname, 'proxy-bridge.mjs')).href
  );
  const vendor =
    process.env.PROXY_VENDOR_DIR ??
    (app.isPackaged
      ? path.join(process.resourcesPath, 'vendor')
      : path.join(__dirname, '../vendor'));
  const openssh = process.env.PROXY_OPENSSH_DIR ?? path.join(vendor, 'openssh');
  const powershell = app.isPackaged ? path.join(vendor, 'pwsh/pwsh.exe') : 'pwsh.exe';
  const connection = await openProxyBridge(
    config,
    {
      openssh,
      powershell,
      scriptDirectory: app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked/electron')
        : undefined,
      // Where Claude finds the scheduled tasks to edit; the service names the variable, not the path.
      environment: { CC_DESK_TUNNEL_SCHEDULES: schedulesPath() },
      log,
      // The system's proxy settings (manual, script or automatic detection) as Chromium reads them.
      resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    },
    () => {
      if (bridge !== connection) return;
      bridge = null;
      keepAwake(false);
      if (!event.sender.isDestroyed()) event.sender.send('proxy:closed');
    },
  );
  if (generation !== connectionGeneration) {
    await connection.close();
    throw new Error('Connection cancelled');
  }
  bridge = lastBridge = connection;
  keepAwake(true);
  return { url: bridge.url };
});
// The service token is kept only when the user asks, encrypted for the current account of the system (DPAPI on
// Windows, the login keychain on macOS).
handle('login:load', () => {
  const { login } = readSettings();
  if (!login) return null;
  let token = '';
  try {
    if (login.token && safeStorage.isEncryptionAvailable())
      token = safeStorage.decryptString(Buffer.from(login.token, 'base64'));
  } catch {}
  return {
    url: String(login.url ?? ''),
    fingerprint: String(login.fingerprint ?? ''),
    mode: login.mode === 'local' ? 'local' : 'remote',
    token,
    remember: !!token,
    autoLogin: !!token && login.autoLogin === true,
  };
});
handle('login:save', (_event, login) => {
  const remember = login?.remember === true && safeStorage.isEncryptionAvailable();
  writeSettings({
    login: remember
      ? {
          url: String(login.url),
          fingerprint: String(login.fingerprint),
          mode: login.mode === 'local' ? 'local' : 'remote',
          token: safeStorage.encryptString(String(login.token)).toString('base64'),
          autoLogin: login.autoLogin === true,
        }
      : undefined,
  });
});
// Replaces a file whole through a flushed temporary file, so a crash or power loss in the middle of a write
// leaves the previous content in place.
function replaceFile(target, text) {
  const temporary = `${target}.tmp`;
  const file = openSync(temporary, 'w');
  try {
    writeSync(file, text);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, target);
}
// Unsent message text, per session.
const draftsPath = () => path.join(app.getPath('userData'), 'drafts.json');
handle('drafts:load', () => {
  try {
    return JSON.parse(readFileSync(draftsPath(), 'utf8'));
  } catch {
    return {};
  }
});
handle('drafts:save', (_event, drafts) => replaceFile(draftsPath(), JSON.stringify(drafts)));
const recordId = /^[a-zA-Z0-9-]{1,100}$/;
const imageData = /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i;
function requireRecordId(value, label) {
  if (typeof value !== 'string' || !recordId.test(value)) throw new Error(`${label}无效。`);
  return value;
}
function attachmentsDir() {
  return path.join(app.getPath('userData'), 'attachments');
}
function attachmentPath(messageId) {
  return path.join(attachmentsDir(), `${requireRecordId(messageId, '消息编号')}.json`);
}
function attachmentIndexPath() {
  return path.join(attachmentsDir(), 'sessions.json');
}
function readAttachmentIndex() {
  try {
    const value = JSON.parse(readFileSync(attachmentIndexPath(), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function writeAttachmentIndex(index) {
  replaceFile(attachmentIndexPath(), JSON.stringify(index));
}
function rememberAttachment(sessionId, messageId) {
  const index = readAttachmentIndex();
  const list = Array.isArray(index[sessionId])
    ? index[sessionId].filter((id) => recordId.test(id))
    : [];
  if (!list.includes(messageId)) list.push(messageId);
  index[sessionId] = list;
  writeAttachmentIndex(index);
}
function forgetAttachment(messageId) {
  const index = readAttachmentIndex();
  let changed = false;
  for (const [sessionId, list] of Object.entries(index)) {
    if (!Array.isArray(list) || !list.includes(messageId)) continue;
    changed = true;
    const next = list.filter((id) => id !== messageId);
    if (next.length) index[sessionId] = next;
    else delete index[sessionId];
  }
  if (changed) writeAttachmentIndex(index);
}
function previewOf(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (value.kind === 'text' && typeof value.text === 'string')
    return { kind: 'text', text: value.text, truncated: value.truncated === true };
  if (value.kind === 'image' && typeof value.data === 'string' && imageData.test(value.data))
    return { kind: 'image', data: value.data };
  if (value.kind === 'unavailable' && typeof value.reason === 'string')
    return { kind: 'unavailable', reason: value.reason.slice(0, 80) };
  return undefined;
}
function attachmentsOf(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item) =>
        item && typeof item.path === 'string' && item.path.length > 0 && item.path.length < 4000,
    )
    .slice(0, 40)
    .map((item) => {
      const preview = previewOf(item.preview);
      return preview ? { path: item.path, preview } : { path: item.path };
    });
}
handle('attachments:load', (_event, messageId) => {
  try {
    return attachmentsOf(JSON.parse(readFileSync(attachmentPath(messageId), 'utf8')));
  } catch {
    return [];
  }
});
handle('attachments:save', async (_event, messageId, attachments, sessionId) => {
  const id = requireRecordId(messageId, '消息编号');
  if (!Array.isArray(attachments) || attachments.length > 40) throw new Error('附件过多。');
  const content = JSON.stringify(attachmentsOf(attachments));
  if (Buffer.byteLength(content) > 48 * 1024 * 1024) throw new Error('附件预览总量超过 48 MB。');
  await mkdir(attachmentsDir(), { recursive: true });
  replaceFile(attachmentPath(id), content);
  if (typeof sessionId === 'string' && recordId.test(sessionId)) rememberAttachment(sessionId, id);
});
handle('attachments:delete', async (_event, messageId) => {
  await unlink(attachmentPath(messageId)).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  forgetAttachment(messageId);
});
handle('attachments:delete-session', async (_event, sessionId) => {
  const id = requireRecordId(sessionId, '会话编号');
  const dir = attachmentsDir();
  if (!existsSync(dir)) return;
  const index = readAttachmentIndex();
  const list = Array.isArray(index[id]) ? index[id].filter((item) => recordId.test(item)) : [];
  await Promise.all(
    list.map((messageId) => unlink(path.join(dir, `${messageId}.json`)).catch(() => {})),
  );
  delete index[id];
  writeAttachmentIndex(index);
});
// Scheduled tasks are one JSON file that the window, the user and Claude over SSH may all edit. The window
// decides what the text means; here it is only read, written and watched. An editor's byte-order mark is
// dropped.
const schedulesPath = () => path.join(app.getPath('userData'), 'schedules.json');
const readSchedules = () => readFileSync(schedulesPath(), 'utf8').replace(/^\uFEFF/, '');
let schedules;
handle('schedules:load', (_event, initial) => {
  if (!existsSync(schedulesPath())) replaceFile(schedulesPath(), String(initial));
  // An edit made outside the window is noticed by looking at the file every two seconds.
  if (schedules === undefined) {
    let stamp = 0;
    setInterval(() => {
      let text;
      try {
        const modified = statSync(schedulesPath()).mtimeMs;
        if (modified === stamp) return;
        stamp = modified;
        text = readSchedules();
      } catch {
        return;
      }
      if (text === schedules) return;
      schedules = text;
      BrowserWindow.getAllWindows()[0]?.webContents.send('schedules:changed', text);
    }, 2000);
  }
  schedules = readSchedules();
  return { path: schedulesPath(), text: schedules };
});
handle('schedules:save', (_event, text) => {
  schedules = String(text);
  replaceFile(schedulesPath(), schedules);
});
handle('app:version', () => app.getVersion());
// The notes of a release as its page on GitHub has them, for a version newer than this program, whose notes
// it cannot carry itself.
handle('release:notes', async (_event, version) => {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error('Unexpected version');
  const response = await net.fetch(
    `https://api.github.com/repos/sun168567/cc-desk-tunnel/releases/tags/v${version}`,
    { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) },
  );
  if (!response.ok) throw new Error(`GitHub ${response.status}`);
  return String((await response.json()).body ?? '').slice(0, 100_000);
});
// Which of the user's computers this is to the service: an ID made once and kept, under the computer's name.
handle('device:get', () => ({
  id: readComputer().deviceId ?? writeComputer({ deviceId: randomUUID() }).deviceId,
  name: hostname(),
}));
// A connection is named in its window, on its tray icon and in its notifications once there are several.
function label() {
  const entries = connections.list(base);
  return entries.length > 1 ? (entries.find((entry) => entry.id === connectionId)?.name ?? '') : '';
}
const titled = () => (label() ? `CC Desk Tunnel · ${label()}` : 'CC Desk Tunnel');
const others = () => connections.list(base).filter((entry) => entry.id !== connectionId);
const listed = () =>
  connections.list(base).map((entry) => ({
    ...entry,
    current: entry.id === connectionId,
    open: entry.id === connectionId || connections.running(base, entry.id),
  }));
// Starts a connection's process. One that is open already shows its window instead: see `second-instance`.
function launch(id, ...flags) {
  spawn(
    process.execPath,
    [
      ...(app.isPackaged ? [] : [app.getAppPath()]),
      ...process.argv.filter(
        (item) =>
          item.startsWith('--user-data-dir=') || item === '--smoke-test' || item === '--no-sandbox',
      ),
      ...(id ? [`--connection=${id}`] : []),
      ...flags,
    ],
    { detached: true, stdio: 'ignore' },
  ).unref();
}
function dismissOthers() {
  for (const entry of others())
    if (connections.running(base, entry.id)) launch(entry.id, '--quit-connection');
}
// The page's choices that are the computer's (see prefs.ts) and the list of connections, as last read. Every
// connection's window looks at the files every two seconds and takes what another one wrote.
const sharedKeys = ['prefs', 'projects'];
const snapshot = (key) =>
  key === 'connections'
    ? connections.list(base)
    : key === 'busy'
      ? connections.busy(base, connectionId)
      : connections.readShared(base, key);
const seen = Object.fromEntries(
  [...sharedKeys, 'connections', 'busy'].map((key) => [key, JSON.stringify(snapshot(key))]),
);
let renamed = () => {};
function takeShared() {
  for (const key of Object.keys(seen)) {
    const value = snapshot(key);
    const text = JSON.stringify(value);
    if (text === seen[key]) continue;
    seen[key] = text;
    if (key === 'connections') renamed();
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send('shared:changed', key, value);
  }
}
// What the page needs before it draws anything.
ipcMain.on('boot', (event) => {
  event.returnValue = event.senderFrame.url.startsWith('file://')
    ? {
        connection: connectionId,
        shared: Object.fromEntries(Object.keys(seen).map((key) => [key, snapshot(key)])),
      }
    : null;
});
handle('shared:save', (_event, key, value) => {
  if (!sharedKeys.includes(key)) throw new Error('Unexpected shared value');
  const text = JSON.stringify(value);
  if (text === seen[key]) return;
  if (text.length > 1 << 20) throw new Error('Shared value too large');
  connections.writeShared(base, key, value);
  seen[key] = text;
});
// The sessions this connection has running, with their folders: see `busy` in connections.cjs.
handle('busy:set', (_event, runs) => {
  connections.mark(
    base,
    connectionId,
    true,
    (Array.isArray(runs) ? runs : [])
      .slice(0, 200)
      .map((run) => ({ id: String(run?.id), folder: String(run?.folder) })),
  );
});
handle('connections:list', listed);
handle('connections:create', (_event, name) => {
  launch(connections.create(base, name).id);
  takeShared();
  return listed();
});
handle('connections:open', (_event, id) => {
  if (!connections.list(base).some((entry) => entry.id === id))
    throw new Error('这个连接已不存在。');
  launch(id);
});
handle('connections:rename', (_event, id, name) => {
  connections.rename(base, String(id), name);
  takeShared();
  return listed();
});
handle('connections:remove', (_event, id) => {
  if (id === connectionId) throw new Error('不能删除正在使用的连接。');
  connections.remove(base, String(id));
  takeShared();
  return listed();
});
handle('app:quit', (_event, all) => {
  if (all === true) dismissOthers();
  app.quit();
});
let refreshTray = () => {};
handle('window:settings', () => ({ closeToTray: readComputer().closeToTray !== false }));
handle('window:settings:set', (_event, values) => {
  writeComputer({ closeToTray: values?.closeToTray !== false });
  refreshTray();
});
handle('window:theme', (event, mode) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const dark = mode === 'dark';
  const color = dark ? '#121211' : '#f6f5f2';
  const symbolColor = dark ? '#f0eee6' : '#141413';
  win.setBackgroundColor(color);
  if (typeof win.setTitleBarOverlay === 'function') {
    win.setTitleBarOverlay({ color, symbolColor, height: 40 });
  }
});
// What the user should know while the window is not in front goes through the system's own notifications.
// A notification is kept until it closes, or it could be collected before it is clicked.
const toasts = new Set();
handle('notify:show', (event, notice) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !Notification.isSupported()) return;
  const inFront = window.isVisible() && window.isFocused() && !window.isMinimized();
  if (inFront && notice?.always !== true) return;
  const toast = new Notification({
    title: `${label() ? `${label()} · ` : ''}${String(notice?.title ?? '')}`.slice(0, 80),
    body: String(notice?.body ?? '').slice(0, 300),
    silent: notice?.silent === true,
    icon: path.join(__dirname, 'icon.png'),
  });
  toasts.add(toast);
  toast.on('close', () => toasts.delete(toast));
  toast.on('click', () => {
    toasts.delete(toast);
    showWindow();
    if (!event.sender.isDestroyed())
      event.sender.send('notify:clicked', notice?.sessionId ? String(notice.sessionId) : null);
  });
  toast.show();
  // What waits for the user also asks for attention in the taskbar or the Dock, from a window left open
  // behind others. The rest is said by the notification alone: an icon that flashes long after the
  // notification went away, or where the system shows none, points at nothing.
  if (notice?.attention === true && window.isVisible() && !inFront) {
    window.flashFrame(true);
    window.once('focus', () => window.flashFrame(false));
  }
});
// Upgrades in place: the installer runs silently over the current install and starts the new version. It
// comes from the connected service, or, when the user chooses so, straight from the release page: `version`
// is then the one to fetch, which the service's refusal of this client named.
handle('update:install', async (event, version) => {
  if (!app.isPackaged) throw new Error('源码运行不支持自升级；请重新打包安装。');
  // Only the Windows installer can be run over an installation. Elsewhere the user installs a new package.
  if (process.platform !== 'win32')
    throw new Error('这个系统上的客户端不能在应用内升级，请到发布页下载新版本。');
  const directory = await mkdtemp(path.join(tmpdir(), 'cc-desk-tunnel-update-'));
  let installer;
  if (version === undefined) {
    if (!lastBridge) throw new Error('请先连接服务。');
    installer = await lastBridge.downloadInstaller(directory);
  } else {
    const { downloadRelease } = await import(
      pathToFileURL(path.join(__dirname, 'release-download.mjs')).href
    );
    let told = 0;
    // Chromium's network stack: the Windows proxy settings apply, as they do to the connection itself.
    installer = await downloadRelease((url, init) => net.fetch(url, init), version, directory, {
      announced: lastBridge?.release(),
      progress(received, size) {
        if (Date.now() - told < 500 && received < size) return;
        told = Date.now();
        if (!event.sender.isDestroyed()) event.sender.send('update:progress', { received, size });
      },
    });
  }
  // The installer replaces the program under every connection's window, so the others go first.
  dismissOthers();
  for (
    let waited = 0;
    others().some((entry) => connections.running(base, entry.id));
    waited += 250
  ) {
    if (waited >= 15000) throw new Error('其他连接的窗口没有退出，请先退出它们再升级。');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  spawn(installer, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
});
ipcMain.handle('proxy:disconnect', async () => {
  keepAwake(false);
  connectionGeneration++;
  const previous = bridge;
  bridge = null;
  await previous?.close();
});

// Windows files notifications under this identity; the installer gives the shortcut the same one.
if (process.platform === 'win32')
  app.setAppUserModelId(app.isPackaged ? 'io.github.ccdesktunnel.desktop' : process.execPath);
app.whenReady().then(() => {
  if (!ownsInstance) return;
  log(`Client ${app.getVersion()} started${connectionId ? ` as connection ${connectionId}` : ''}.`);
  void clearPastedPictures();
  connections.mark(base, connectionId, true);
  setInterval(takeShared, 2000);
  // Shortcuts are the page's, where the user can change them or turn them off; Electron's default menu would
  // add its own on top (zoom, reload, close). A run from source keeps reload and the developer tools.
  // macOS has one menu bar for every program and takes the keys of copying, pasting, hiding and quitting from
  // what is in it: without these entries they do nothing. The page's own menus stay in its title bar.
  const development = app.isPackaged
    ? []
    : [{ label: '开发', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] }];
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([
          {
            label: app.name,
            submenu: [
              { role: 'about', label: '关于 CC Desk Tunnel' },
              { type: 'separator' },
              { role: 'hide', label: '隐藏 CC Desk Tunnel' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              { role: 'quit', label: '退出 CC Desk Tunnel' },
            ],
          },
          {
            label: '编辑',
            submenu: [
              { role: 'undo', label: '撤销' },
              { role: 'redo', label: '重做' },
              { type: 'separator' },
              { role: 'cut', label: '剪切' },
              { role: 'copy', label: '复制' },
              { role: 'paste', label: '粘贴' },
              { role: 'selectAll', label: '全选' },
            ],
          },
          { role: 'windowMenu', label: '窗口' },
          ...development,
        ])
      : development.length
        ? Menu.buildFromTemplate(development)
        : null,
  );
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  const window = new BrowserWindow({
    width: 1240,
    height: 850,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#f6f5f2',
    title: titled(),
    // The page draws the title bar; the system adds only its window buttons: over the bar's right end on
    // Windows, at its left end on macOS, where the page leaves them room (see `.titlebar` in style.css).
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f6f5f2', symbolColor: '#141413', height: 40 },
    trafficLightPosition: { x: 14, y: 13 },
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    show: !process.argv.includes('--smoke-test'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // A hidden window keeps its connection timers at full rate.
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'),
      // Only a build run from the source tree offers the login page's simulation mode.
      additionalArguments: app.isPackaged ? [] : ['--cc-desk-tunnel-dev'],
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Electron does not provide an editing menu by default. Native roles keep text selection, undo and paste
  // in the focused input, without exposing clipboard reads to the renderer.
  window.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;
    Menu.buildFromTemplate([
      { role: 'undo', label: '撤销', enabled: params.editFlags.canUndo },
      { role: 'redo', label: '重做', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: '剪切', enabled: params.editFlags.canCut },
      { role: 'copy', label: '复制', enabled: params.editFlags.canCopy },
      { role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste },
      { role: 'selectAll', label: '全选' },
    ]).popup({ window });
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.loadFile(path.join(__dirname, '../dist/index.html'));

  // Long tasks keep running with the window closed: closing hides it, and the tray icon brings it back or quits.
  const closeToTray = () => readComputer().closeToTray !== false;
  // The macOS menu bar takes a small shape in one colour, which it tints itself for light and dark.
  const tray = new Tray(
    process.platform === 'darwin'
      ? require('./tray-icon.cjs').terminalTemplate(nativeImage)
      : nativeImage
          .createFromPath(path.join(__dirname, 'icon.png'))
          .resize({ width: 32, height: 32 }),
  );
  const buildMenu = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示窗口', click: showWindow },
        ...others().map((entry) => ({
          label: `打开“${entry.name}”`,
          click: () => launch(entry.id),
        })),
        {
          label: '关闭窗口时留在后台',
          type: 'checkbox',
          checked: closeToTray(),
          click: (item) => {
            writeComputer({ closeToTray: item.checked });
            buildMenu();
          },
        },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
        ...(others().length
          ? [
              {
                label: '退出全部连接',
                click: () => {
                  dismissOthers();
                  app.quit();
                },
              },
            ]
          : []),
      ]),
    );
  tray.on('click', showWindow);
  // The page has a title of its own, which would replace the connection's name.
  window.on('page-title-updated', (event) => event.preventDefault());
  renamed = () => {
    window.setTitle(titled());
    tray.setToolTip(titled());
    buildMenu();
  };
  renamed();
  refreshTray = buildMenu;
  window.on('close', (event) => {
    if (quitting || !closeToTray()) return;
    event.preventDefault();
    window.hide();
    if (!readComputer().trayHintShown) {
      writeComputer({ trayHintShown: true });
      // Balloons are a thing of the Windows tray.
      if (process.platform === 'win32')
        tray.displayBalloon({
          title: 'CC Desk Tunnel 仍在后台运行',
          content: '点击托盘图标恢复窗口；右键图标选择“退出”才会结束连接。',
        });
    }
  });
});
let quitting = false;
let exiting = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (exiting || !bridge) return;
  event.preventDefault();
  exiting = true;
  bridge.close().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
app.on('quit', () => {
  if (ownsInstance) connections.mark(base, connectionId, false);
});
