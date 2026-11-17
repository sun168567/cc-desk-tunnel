const path = require('node:path');
const {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const net = require('node:net');
const { tmpdir } = require('node:os');

// The program's directory (`base`) and what is in it:
//   settings.json      this computer's settings, which are no connection's (see `computer` below)
//   shared/            what all windows share, one file a value, so that a window replaces a value whole and
//                      never part of another window's: the connections' names, the one that signs in by itself,
//                      the page's preferences
//   connections/<id>/  a connection, signed in to one service: its process's profile, with the sign-in, drafts,
//                      scheduled tasks, pasted pictures and log
//   launchers/<id>/    the profile of a sign-in window while it is open (see `role`), removed after it
// A connection is told by the address of its service, path and all, as one host may route several services by
// path. The user may give it a name of their own; without one it goes by the address. Versions before 0.3.16
// kept the first connection in the program's directory itself; `adopt` moves it to a directory of its own.
const idPattern = /^[a-z0-9]{8}$/;
const limit = 24;
const directory = (base, id) => path.join(base, 'connections', id);
const sharedFile = (base, key) => path.join(base, 'shared', `${key}.json`);
const settingsFile = (base, id) => path.join(directory(base, id), 'settings.json');

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}
const readShared = (base, key) => readJson(sharedFile(base, key));
// Writes a file whole: another window may be reading it at this moment, which Windows answers by refusing the
// rename.
function replace(target, value) {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  for (let attempt = 0; ; attempt++) {
    try {
      return renameSync(temporary, target);
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
}
const writeShared = (base, key, value) => replace(sharedFile(base, key), value);

const named = (name) => {
  const text = String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > 24) throw new Error('名称最多 24 个字。');
  return text;
};
function list(base) {
  const saved = readShared(base, 'connections');
  const entries = (Array.isArray(saved) ? saved : []).filter(
    (entry) => entry && typeof entry.name === 'string' && idPattern.test(entry.id),
  );
  return entries
    .filter((entry, index) => entries.findIndex((item) => item.id === entry.id) === index)
    .map(({ id, name }) => ({ id, name }));
}
function taken(entries, name, except) {
  if (name && entries.some((entry) => entry.id !== except && entry.name === name))
    throw new Error('已有同名的连接。');
}
function rename(base, id, name) {
  const entries = list(base);
  const entry = entries.find((item) => item.id === id);
  if (!entry) throw new Error('这个连接已不存在。');
  entry.name = named(name);
  taken(entries, entry.name, id);
  writeShared(base, 'connections', entries);
}

const readSettings = (base, id) => readJson(settingsFile(base, id)) ?? {};
const writeSettings = (base, id, values) =>
  replace(settingsFile(base, id), { ...readSettings(base, id), ...values });
// The sign-in a connection keeps: its service's address once it has signed in there, the token (encrypted by the
// process of that connection, which alone can read it) only when the user asked for it to be remembered.
function loginOf(base, id) {
  const login = readSettings(base, id).login;
  return login && typeof login.url === 'string' && login.url ? login : null;
}
// Two addresses are one service when they name the same place: scheme and host in any case, the default port
// written or not. The path and query count as they are.
function serviceKey(url) {
  const text = String(url ?? '').trim();
  try {
    return new URL(text).href;
  } catch {
    return text;
  }
}
const shown = (url) => String(url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
// What a connection is called in its window, its tray icon and the other windows.
function labelOf(base, entry) {
  const login = entry.name ? null : loginOf(base, entry.id);
  return entry.name || (login ? shown(login.url) : '');
}

// Each process writes its ID into its profile while it runs. An ID the system gave to another program since
// only makes a connection look open, which costs the user a second try.
const instanceFile = (folder) => path.join(folder, 'instance.json');
function alive(folder) {
  try {
    process.kill(JSON.parse(readFileSync(instanceFile(folder), 'utf8')).pid, 0);
    return true;
  } catch {
    return false;
  }
}
const running = (base, id) => alive(directory(base, id));
// With it go the sessions the connection has running and the folders they work in.
function mark(base, id, on, runs = []) {
  if (on)
    writeFileSync(instanceFile(directory(base, id)), JSON.stringify({ pid: process.pid, runs }));
  else rmSync(instanceFile(directory(base, id)), { force: true });
}

// A running connection's window listens here for the program's other processes: to be shown, or to quit. Starting
// a process on its profile instead would have a second process write the profile's encryption key, which the
// system keeps only some seconds after a start: a token remembered in that time could not be read again.
function controlPath(base, id) {
  const hash = createHash('sha256').update(directory(base, id)).digest('hex').slice(0, 16);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\cc-desk-tunnel-${hash}`
    : path.join(tmpdir(), `cc-desk-tunnel-${hash}.sock`);
}
function listen(base, id, commands) {
  const where = controlPath(base, id);
  if (process.platform !== 'win32') rmSync(where, { force: true });
  const server = net.createServer((socket) => {
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      text += chunk;
      if (text.length > 16) socket.destroy();
    });
    socket.on('end', () => {
      socket.end();
      if (Object.hasOwn(commands, text)) commands[text]();
    });
    socket.on('error', () => {});
  });
  server.on('error', () => {});
  server.listen(where);
  return server;
}
// Whether the window took the command.
function tell(base, id, command) {
  return new Promise((done) => {
    const socket = net.connect(controlPath(base, id));
    const timer = setTimeout(() => socket.destroy(), 3000);
    socket.on('connect', () => socket.end(command));
    socket.on('error', () => {});
    socket.on('close', (failed) => {
      clearTimeout(timer);
      done(!failed);
    });
  });
}

// A connection is made when a sign-in window starts it for a service new to this computer. Until it has signed
// in it is `pending`: a mistyped address leaves no record, and its directory goes once its window has.
function create(base, login) {
  const entries = list(base);
  if (entries.length >= limit) throw new Error(`最多保存 ${limit} 个连接。`);
  const id = randomBytes(4).toString('hex');
  mkdirSync(directory(base, id), { recursive: true });
  writeSettings(base, id, { login, pending: Date.now() });
  writeShared(base, 'connections', [...entries, { id, name: '' }]);
  return id;
}
// Whether the connection has not signed in yet; see `create`.
const pending = (base, id) => !!readSettings(base, id).pending;

// The one connection that signs in by itself when the program is started with no window open. Earlier versions
// kept the choice with each connection's sign-in; the first such one is taken over.
function autoLogin(base) {
  const saved = readShared(base, 'autoLogin');
  const entries = list(base);
  const id =
    saved === undefined
      ? entries.find((entry) => loginOf(base, entry.id)?.autoLogin === true)?.id
      : saved?.id;
  return typeof id === 'string' &&
    entries.some((entry) => entry.id === id) &&
    loginOf(base, id)?.token
    ? id
    : null;
}
function setAutoLogin(base, id, on) {
  const current = autoLogin(base);
  const next = on ? id : current === id ? null : current;
  if (next !== current || readShared(base, 'autoLogin') === undefined)
    writeShared(base, 'autoLogin', { id: next });
}
// The connections, the latest signed in first. `url` is empty for one an earlier version made that has not kept
// its address, as those versions kept it only with a remembered token.
function accounts(base) {
  const auto = autoLogin(base);
  return list(base)
    .filter((entry) => !pending(base, entry.id))
    .map((entry) => {
      const login = loginOf(base, entry.id);
      return {
        ...entry,
        label: labelOf(base, entry),
        url: login?.url ?? '',
        fingerprint: String(login?.fingerprint ?? ''),
        mode: login?.mode === 'local' ? 'local' : 'remote',
        saved: !!login?.token,
        autoLogin: entry.id === auto,
        usedAt: Number(login?.usedAt) || 0,
      };
    })
    .sort((a, b) => b.usedAt - a.usedAt);
}
// The connection that has signed in to the service, if one has.
function owner(base, url) {
  const key = serviceKey(url);
  return accounts(base).find((entry) => entry.url && serviceKey(entry.url) === key) ?? null;
}

// What the other connections have running now, for a window to warn of two sessions in one folder.
function busy(base, except) {
  return list(base)
    .filter((entry) => entry.id !== except && running(base, entry.id))
    .map((entry) => {
      const runs = readJson(instanceFile(directory(base, entry.id)))?.runs;
      return {
        name: labelOf(base, entry),
        runs: (Array.isArray(runs) ? runs : []).filter(
          (run) => typeof run?.id === 'string' && typeof run?.folder === 'string',
        ),
      };
    })
    .filter((entry) => entry.runs.length);
}
// Removing a connection removes what it kept on this computer: its sign-in, drafts, scheduled tasks and log.
// Sessions are the service's and stay there.
function remove(base, id) {
  const entries = list(base);
  if (!entries.some((entry) => entry.id === id)) throw new Error('这个连接已不存在。');
  if (running(base, id)) throw new Error('这个连接的窗口还开着，请先退出它。');
  if (autoLogin(base) === id) setAutoLogin(base, id, false);
  writeShared(
    base,
    'connections',
    entries.filter((entry) => entry.id !== id),
  );
  rmSync(directory(base, id), { recursive: true, force: true });
}

// What a start of the program is. One that names a connection is that connection's window, as the program starts
// them; `--sign-in` has it sign in at once. Any other start, the user's own, is a sign-in window.
function role(base, argv) {
  const asked = argv.find((item) => item.startsWith('--connection='))?.slice(13);
  return asked && list(base).some((entry) => entry.id === asked)
    ? { id: asked, signIn: argv.includes('--sign-in') }
    : { id: null, signIn: false };
}
// A sign-in window's profile, made for it and removed after it: nothing of it is kept.
function launcherDirectory(base) {
  const folder = path.join(base, 'launchers', randomBytes(4).toString('hex'));
  mkdirSync(folder, { recursive: true });
  writeFileSync(instanceFile(folder), JSON.stringify({ pid: process.pid }));
  return folder;
}
// What is left of sign-in windows gone, and of connections that never signed in and whose window has gone too.
// A connection made a moment ago may not have started yet.
function tidy(base, now = Date.now()) {
  const launchers = path.join(base, 'launchers');
  for (const name of existsSync(launchers) ? readdirSync(launchers) : []) {
    const folder = path.join(launchers, name);
    if (!alive(folder)) rmSync(folder, { recursive: true, force: true });
  }
  for (const entry of list(base)) {
    const since = Number(readSettings(base, entry.id).pending);
    if (since && now - since > 120_000 && !running(base, entry.id)) remove(base, entry.id);
  }
}

// What in the program's directory is this computer's; everything else there was the first connection's.
const computer = ['settings.json', 'shared', 'connections', 'launchers'];
const computerSettings = ['deviceId', 'closeToTray', 'trayHintShown', 'editor', 'workspaceRoots'];
// What an earlier version's first connection leaves in the program's directory, once it has been used.
const traces = ['Local Storage', 'logs', 'drafts.json', 'schedules.json'];
// Moves the first connection of an earlier version out of the program's directory into one of its own, with its
// profile as the system left it: its encryption key goes along, so its remembered token still reads. Only while
// its window is closed. Each step can be taken again: an interrupted move goes on at the next start.
function adopt(base) {
  const moving = path.join(base, 'shared', 'moving.json');
  const started = readJson(moving)?.id;
  const settings = readJson(path.join(base, 'settings.json')) ?? {};
  const saved = readShared(base, 'connections');
  const first = Array.isArray(saved) ? saved.find((entry) => entry?.id === '') : undefined;
  const used = traces.some((name) => existsSync(path.join(base, name)));
  if (!idPattern.test(started) && !used && !settings.login && !first) return null;
  if (alive(base)) return null;
  const id = idPattern.test(started) ? started : randomBytes(4).toString('hex');
  if (id !== started) writeShared(base, 'moving', { id });
  const target = directory(base, id);
  mkdirSync(target, { recursive: true });
  rmSync(instanceFile(base), { force: true });
  // What is there already was moved before; what an earlier version made again since stays where it is.
  for (const name of readdirSync(base).filter((item) => !computer.includes(item)))
    if (!existsSync(path.join(target, name)))
      renameSync(path.join(base, name), path.join(target, name));
  // Its sign-in goes with it; what is the computer's stays.
  const own = Object.entries(settings).filter(([key]) => !computerSettings.includes(key));
  if (own.length) {
    writeSettings(base, id, Object.fromEntries(own));
    replace(
      path.join(base, 'settings.json'),
      Object.fromEntries(
        Object.entries(settings).filter(([key]) => computerSettings.includes(key)),
      ),
    );
  }
  if (!list(base).some((entry) => entry.id === id)) {
    const others = Array.isArray(saved) ? saved.filter((entry) => entry?.id !== '') : [];
    const name =
      first && typeof first.name === 'string' && first.name !== '主连接' ? first.name : '';
    writeShared(base, 'connections', [{ id, name: named(name) }, ...others]);
  }
  if (readShared(base, 'autoLogin')?.id === '') writeShared(base, 'autoLogin', { id });
  rmSync(moving, { force: true });
  return id;
}

module.exports = {
  accounts,
  adopt,
  autoLogin,
  busy,
  create,
  directory,
  labelOf,
  launcherDirectory,
  list,
  listen,
  loginOf,
  mark,
  owner,
  pending,
  readShared,
  remove,
  rename,
  role,
  running,
  serviceKey,
  setAutoLogin,
  tell,
  tidy,
  writeSettings,
  writeShared,
};
