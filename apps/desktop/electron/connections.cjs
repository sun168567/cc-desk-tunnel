const path = require('node:path');
const { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { randomBytes } = require('node:crypto');

// One computer can keep several connections, each signed in to a service of its own, the way a chat program keeps
// one window an account. A connection is a process with its own profile directory: the first one's is the
// program's profile (`base`), the others live under it. What they have in common is under `shared` there, one
// file a value, so that a window replaces a value whole and never part of another window's.
// A connection is told by the address of its service, path and all, as one host may route several services by
// path. The user may give it a name of their own; without one it goes by the address.
const main = { id: '', name: '' };
const idPattern = /^[a-z0-9]{8}$/;
const limit = 24;
const directory = (base, id) => (id ? path.join(base, 'connections', id) : base);
const sharedFile = (base, key) => path.join(base, 'shared', `${key}.json`);
const settingsFile = (base, id) => path.join(directory(base, id), 'settings.json');

function readShared(base, key) {
  try {
    return JSON.parse(readFileSync(sharedFile(base, key), 'utf8'));
  } catch {
    return undefined;
  }
}
// Another window may be reading the file at this moment, which Windows answers by refusing the rename.
function writeShared(base, key, value) {
  const target = sharedFile(base, key);
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  for (let attempt = 0; ; attempt++) {
    try {
      return renameSync(temporary, target);
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
}

const named = (name) => {
  const text = String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > 24) throw new Error('名称最多 24 个字。');
  return text;
};
// The first connection always leads the list. Earlier versions called it "主连接" until the user named it.
function list(base) {
  const saved = readShared(base, 'connections');
  const entries = (Array.isArray(saved) ? saved : []).filter(
    (entry) =>
      entry && typeof entry.name === 'string' && (entry.id === '' || idPattern.test(entry.id)),
  );
  const unique = entries.filter(
    (entry, index) => entries.findIndex((item) => item.id === entry.id) === index,
  );
  const first = { ...main, ...unique.find((entry) => !entry.id) };
  if (first.name === '主连接') first.name = '';
  return [first, ...unique.filter((entry) => entry.id)].map(({ id, name }) => ({ id, name }));
}
function taken(entries, name, except) {
  if (name && entries.some((entry) => entry.id !== except && entry.name === name))
    throw new Error('已有同名的连接。');
}
function create(base, name = '') {
  const entries = list(base);
  if (entries.length >= limit) throw new Error(`最多保存 ${limit} 个连接。`);
  const entry = { id: randomBytes(4).toString('hex'), name: named(name) };
  taken(entries, entry.name);
  mkdirSync(directory(base, entry.id), { recursive: true });
  writeShared(base, 'connections', [...entries, entry]);
  return entry;
}
function rename(base, id, name) {
  const entries = list(base);
  const entry = entries.find((item) => item.id === id);
  if (!entry) throw new Error('这个连接已不存在。');
  entry.name = named(name);
  taken(entries, entry.name, id);
  writeShared(base, 'connections', entries);
}

function readSettings(base, id) {
  try {
    return JSON.parse(readFileSync(settingsFile(base, id), 'utf8'));
  } catch {
    return {};
  }
}
// The sign-in a connection keeps: its service's address once it has signed in there, the token (encrypted by the
// main process) only when the user asked for it to be remembered.
function loginOf(base, id) {
  const login = readSettings(base, id).login;
  return login && typeof login.url === 'string' && login.url ? login : null;
}
function clearLogin(base, id) {
  const settings = readSettings(base, id);
  if (!settings.login) return;
  delete settings.login;
  writeFileSync(settingsFile(base, id), JSON.stringify(settings, null, 2));
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
// The connections that have signed in somewhere, the latest first.
function accounts(base) {
  const auto = autoLogin(base);
  return list(base)
    .flatMap((entry) => {
      const login = loginOf(base, entry.id);
      return login
        ? [
            {
              ...entry,
              label: labelOf(base, entry),
              url: login.url,
              saved: !!login.token,
              autoLogin: entry.id === auto,
              usedAt: Number(login.usedAt) || 0,
            },
          ]
        : [];
    })
    .sort((a, b) => b.usedAt - a.usedAt);
}

// Each process writes its ID into its profile while it runs. An ID the system gave to another program since
// only makes a connection look open, which costs the user a second try.
const instanceFile = (base, id) => path.join(directory(base, id), 'instance.json');
function running(base, id) {
  try {
    process.kill(JSON.parse(readFileSync(instanceFile(base, id), 'utf8')).pid, 0);
    return true;
  } catch {
    return false;
  }
}
// With it go the sessions the connection has running and the folders they work in.
function mark(base, id, on, runs = []) {
  if (on) writeFileSync(instanceFile(base, id), JSON.stringify({ pid: process.pid, runs }));
  else rmSync(instanceFile(base, id), { force: true });
}
// What the other connections have running now, for a window to warn of two sessions in one folder.
function busy(base, except) {
  return list(base)
    .filter((entry) => entry.id !== except && running(base, entry.id))
    .map((entry) => {
      let runs = [];
      try {
        runs = JSON.parse(readFileSync(instanceFile(base, entry.id), 'utf8')).runs;
      } catch {}
      return {
        name: labelOf(base, entry),
        runs: (Array.isArray(runs) ? runs : []).filter(
          (run) => typeof run?.id === 'string' && typeof run?.folder === 'string',
        ),
      };
    })
    .filter((entry) => entry.runs.length);
}
// Removing a connection removes what it kept on this computer: its saved sign-in, drafts, scheduled tasks and
// log. Sessions are the service's and stay there. The first connection's profile is the program's own: only its
// sign-in and name go.
function remove(base, id) {
  const entries = list(base);
  if (!entries.some((entry) => entry.id === id)) throw new Error('这个连接已不存在。');
  if (running(base, id)) throw new Error('这个连接的窗口还开着，请先退出它。');
  if (autoLogin(base) === id) setAutoLogin(base, id, false);
  if (!id) {
    clearLogin(base, id);
    if (entries[0].name) rename(base, id, '');
    return;
  }
  writeShared(
    base,
    'connections',
    entries.filter((entry) => entry.id !== id),
  );
  rmSync(directory(base, id), { recursive: true, force: true });
}
// Which connection a start of the program is. A command line that names one is that one, as the program starts
// its other windows; `--sign-in` has it sign in at once. A start by the user's hand is a sign-in page of its own:
// with no window open, the connection chosen to sign in by itself does; otherwise it is the latest connection
// that is not open, or one that has not signed in anywhere yet, made when there is none.
function choose(base, argv) {
  const entries = list(base);
  const asked = argv.find((item) => item.startsWith('--connection='))?.slice(13);
  if (asked !== undefined) {
    const known = entries.some((entry) => entry.id === asked);
    return { id: known ? asked : '', signIn: known && argv.includes('--sign-in') };
  }
  if (!entries.some((entry) => running(base, entry.id))) {
    const auto = autoLogin(base);
    if (auto !== null) return { id: auto, signIn: true };
  }
  const idle = accounts(base).find((entry) => !running(base, entry.id));
  if (idle) return { id: idle.id, signIn: false };
  const blank = entries.find((entry) => !loginOf(base, entry.id) && !running(base, entry.id));
  if (blank) return { id: blank.id, signIn: false };
  return { id: entries.length < limit ? create(base).id : '', signIn: false };
}

module.exports = {
  accounts,
  autoLogin,
  busy,
  choose,
  clearLogin,
  create,
  directory,
  labelOf,
  list,
  loginOf,
  mark,
  readShared,
  remove,
  rename,
  running,
  serviceKey,
  setAutoLogin,
  writeShared,
};
