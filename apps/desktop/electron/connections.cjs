const path = require('node:path');
const { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { randomBytes } = require('node:crypto');

// One computer can keep several connections, each to a service of its own. A connection is a process with
// its own profile directory: the first one's is the program's profile (`base`), the others live under it.
// What they have in common is under `shared` there, one file a value, so that a window replaces a value whole
// and never part of another window's.
const main = { id: '', name: '主连接' };
const idPattern = /^[a-z0-9]{8}$/;
const directory = (base, id) => (id ? path.join(base, 'connections', id) : base);
const sharedFile = (base, key) => path.join(base, 'shared', `${key}.json`);

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
  if (!text || text.length > 24) throw new Error('连接的名称为 1 到 24 个字。');
  return text;
};
// The first connection always leads the list, under its own name unless the user gave it another.
function list(base) {
  const saved = readShared(base, 'connections');
  const entries = (Array.isArray(saved) ? saved : []).filter(
    (entry) =>
      entry &&
      typeof entry.name === 'string' &&
      entry.name &&
      (entry.id === '' || idPattern.test(entry.id)),
  );
  const unique = entries.filter(
    (entry, index) => entries.findIndex((item) => item.id === entry.id) === index,
  );
  return [
    { ...main, ...unique.find((entry) => !entry.id) },
    ...unique.filter((entry) => entry.id),
  ].map(({ id, name }) => ({ id, name }));
}
function taken(entries, name, except) {
  if (entries.some((entry) => entry.id !== except && entry.name === name))
    throw new Error('已有同名的连接。');
}
function create(base, name) {
  const entries = list(base);
  if (entries.length >= 12) throw new Error('最多保存 12 个连接。');
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
        name: entry.name,
        runs: (Array.isArray(runs) ? runs : []).filter(
          (run) => typeof run?.id === 'string' && typeof run?.folder === 'string',
        ),
      };
    })
    .filter((entry) => entry.runs.length);
}
// Removing a connection removes what it kept on this computer: its saved sign-in, drafts, scheduled tasks and
// log. Sessions are the service's and stay there.
function remove(base, id) {
  const entries = list(base);
  if (!id || !entries.some((entry) => entry.id === id)) throw new Error('这个连接已不存在。');
  if (running(base, id)) throw new Error('这个连接的窗口还开着，请先退出它。');
  writeShared(
    base,
    'connections',
    entries.filter((entry) => entry.id !== id),
  );
  rmSync(directory(base, id), { recursive: true, force: true });
}
// The connection a command line asks for; one that is not in the list is the first connection.
function requested(argv, base) {
  const id = argv.find((item) => item.startsWith('--connection='))?.slice(13);
  return id && list(base).some((entry) => entry.id === id) ? id : '';
}

module.exports = {
  busy,
  create,
  directory,
  list,
  mark,
  readShared,
  remove,
  rename,
  requested,
  running,
  writeShared,
};
