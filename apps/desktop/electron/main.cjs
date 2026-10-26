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
  nativeTheme,
  protocol,
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
const { copyFile, mkdtemp, readFile, stat, writeFile } = require('node:fs/promises');
const { gitBranch } = require('./git-branch.cjs');
const fileLinks = require('./file-links.cjs');
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
// See file-links.cjs: the address that pictures on this computer reach the page by.
protocol.registerSchemesAsPrivileged([
  { scheme: 'local-image', privileges: { standard: true, secure: true } },
]);
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
// Links in replies, which the user clicked. A web address goes to the browser. A file is opened, shown in its
// folder or given to a code editor at its line, as file-links.cjs allows; what is said back is for the user.
handle('link:open', async (_event, target) => {
  const url = new URL(String(target));
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) throw new Error('Unexpected link');
  await shell.openExternal(url.href);
});
// The installed editors, the one chosen last from a link's menu first. Asking the system blocks (on Linux it runs
// xdg-mime for each), so the answer is kept a minute.
let installedEditors = { at: 0, editors: [] };
function linkEditors() {
  if (Date.now() - installedEditors.at > 60_000)
    installedEditors = {
      at: Date.now(),
      editors: fileLinks.editors.filter(({ scheme }) =>
        app.getApplicationNameForProtocol(`${scheme}://`),
      ),
    };
  const installed = installedEditors.editors;
  const chosen = installed.find(({ scheme }) => scheme === readComputer().editor);
  return chosen ? [chosen, ...installed.filter((editor) => editor !== chosen)] : installed;
}
async function linkedPath(target) {
  const file = fileLinks.localPath(target, path.isAbsolute);
  if (!file) throw new Error('Unexpected path');
  const found = await stat(file).catch(() => null);
  if (!found) return { file, kind: 'missing', runs: false, size: 0 };
  const directory = found.isDirectory();
  const runs = fileLinks.runs(file, {
    platform: process.platform,
    directory,
    mode: found.mode,
    pathext: process.env.PATHEXT,
  });
  return { file, kind: directory ? 'directory' : 'file', runs, size: found.size };
}
handle('path:inspect', async (_event, target) => {
  const { kind, runs } = await linkedPath(target);
  return { kind, runs, editors: linkEditors(), openWith: process.platform === 'win32' };
});
handle('path:act', async (event, action, target, options) => {
  const { file, kind, runs, size } = await linkedPath(target);
  const { line, column, editor } = options ?? {};
  const position = [line, column].map((value) =>
    Number.isInteger(value) && value > 0 ? value : undefined,
  );
  if (kind === 'missing') return '本机找不到这个路径，它可能在服务端或另一台电脑上。';
  const open = async () => {
    const failure = await shell.openPath(file);
    return failure ? `没能打开：${failure}` : '';
  };
  const edit = async (chosen) => {
    await shell.openExternal(fileLinks.editorUrl(chosen.scheme, file, ...position));
    return '';
  };
  if (action === 'open') {
    const [first] = linkEditors();
    if (kind === 'file' && position[0] && first) return edit(first);
    if (!runs) return open();
    shell.showItemInFolder(file);
    return '它会运行程序，没有直接打开，已在文件夹中显示。';
  }
  if (action === 'reveal') {
    shell.showItemInFolder(file);
    return '';
  }
  if (kind !== 'file') throw new Error('Not a file');
  if (action === 'editor') {
    const chosen = linkEditors().find(({ scheme }) => scheme === editor);
    if (!chosen) throw new Error('Unknown editor');
    writeComputer({ editor: chosen.scheme });
    return edit(chosen);
  }
  if (action === 'content') {
    if (size > 1024 * 1024) return '文件超过 1 MB，没有复制。';
    const bytes = await readFile(file);
    if (bytes.includes(0)) return '这不是文本文件，没有复制。';
    clipboard.writeText(bytes.toString('utf8'));
    return '已复制文件内容';
  }
  if (action === 'save') {
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '另存为',
      defaultPath: path.join(app.getPath('downloads'), path.basename(file)),
    });
    if (result.canceled || !result.filePath) return '';
    await copyFile(file, result.filePath);
    return '已另存';
  }
  if (runs) throw new Error('Refused to run');
  if (action === 'default') return open();
  if (action === 'with' && process.platform === 'win32') {
    const chooser = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenWith.exe');
    spawn(chooser, [file], { detached: true, stdio: 'ignore' })
      .on('error', () => {})
      .unref();
    return '';
  }
  throw new Error('Unexpected action');
});
// Only an address announced by the currently authenticated service may leave the application here.
handle('web:open', async (_event, target) => {
  const url = new URL(String(target));
  if (url.hash && url.hash !== '#passkeys') throw new Error('Unexpected Web address');
  const address = new URL(url);
  address.hash = '';
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    bridge?.webUrl() !== address.href
  )
    throw new Error('Unexpected Web address');
  await shell.openExternal(url.href);
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
// A service older than this client refuses it at sign-in; it is asked to upgrade over a connection of its own.
handle('service:upgrade', async (event, config) => {
  const { upgradeService } = await import(
    pathToFileURL(path.join(__dirname, 'proxy-bridge.mjs')).href
  );
  return upgradeService(config, {
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    onUpdate: (update) => {
      if (!event.sender.isDestroyed()) event.sender.send('service:upgrade-progress', update);
    },
  }).then(
    (version) => ({ version }),
    (error) => ({ error: error.message }),
  );
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
    if (key === 'prefs') followTheme(value);
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
  if (key === 'prefs') followTheme(value);
});
// The window's own parts, its ground before the page draws and the system's buttons over the title bar, take
// the colours the page chose (`theme` in prefs.ts); the system's menus and dialogs follow the same choice.
// The colours are the title bar's in style.css: `--chrome` and `--text`.
const windowColours = () =>
  nativeTheme.shouldUseDarkColors
    ? { color: '#141518', symbolColor: '#e4e6ea' }
    : { color: '#edf0f6', symbolColor: '#22262e' };
function followTheme(prefs) {
  const theme = prefs?.theme;
  nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
}
followTheme(seen.prefs && JSON.parse(seen.prefs));
nativeTheme.on('updated', () => {
  const colours = windowColours();
  for (const window of BrowserWindow.getAllWindows()) {
    window.setBackgroundColor(colours.color);
    if (process.platform !== 'darwin') window.setTitleBarOverlay({ ...colours, height: 40 });
  }
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
    backgroundColor: windowColours().color,
    title: titled(),
    // The page draws the title bar; the system adds only its window buttons: over the bar's right end on
    // Windows, at its left end on macOS, where the page leaves them room (see `.titlebar` in style.css).
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...windowColours(), height: 40 },
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
  // See file-links.cjs. Nothing but a picture of the right size is served, and nothing is kept.
  protocol.handle('local-image', async (request) => {
    const picture = fileLinks.pictureOf(request.url);
    const file = picture && fileLinks.localPath(picture.file, path.isAbsolute);
    const found = file && (await stat(file).catch(() => null));
    if (!found?.isFile() || found.size > fileLinks.pictureLimit)
      return new Response(null, { status: 404 });
    return new Response(await readFile(file), {
      headers: { 'Content-Type': picture.type, 'Cache-Control': 'no-store' },
    });
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
