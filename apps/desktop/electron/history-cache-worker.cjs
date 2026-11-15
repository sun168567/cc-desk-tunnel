const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { mkdirSync, statSync, existsSync, chmodSync } = require('node:fs');
const { join } = require('node:path');
const { readHistory } = require(workerData.historyModule);
let database, file;

function open(url) {
  const address = new URL(url);
  if (
    !['ws:', 'wss:'].includes(address.protocol) ||
    address.username ||
    address.password ||
    address.search ||
    address.hash
  )
    throw new Error('缓存需要有效的服务地址。');
  const target = join(
    workerData.directory,
    createHash('sha256').update(address.href).digest('hex') + '.sqlite',
  );
  if (file === target) return;
  database?.close();
  database = undefined;
  file = undefined;
  mkdirSync(workerData.directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(target);
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('此缓存由较新客户端创建，请升级客户端后读取。');
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, metadata TEXT NOT NULL, ranges TEXT NOT NULL, cursor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,sequence));
      CREATE INDEX IF NOT EXISTS events_run ON events(session_id,run_id,sequence);
      PRAGMA user_version=1;`);
    if (process.platform !== 'win32') chmodSync(target, 0o600);
    database = db;
    file = target;
  } catch (error) {
    db.close();
    throw error;
  }
}
function transaction(run) {
  database.exec('BEGIN');
  try {
    const result = run();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
function rangesTogether(ranges) {
  const combined = [];
  for (const range of ranges.sort((a, b) => a[0] - b[0])) {
    const last = combined.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else combined.push([...range]);
  }
  return combined;
}
function run(message) {
  if (message.type === 'close') {
    database?.close();
    database = undefined;
    file = undefined;
    return;
  }
  open(message.url);
  switch (message.type) {
    case 'list':
      return database
        .prepare("SELECT metadata FROM sessions ORDER BY json_extract(metadata,'$.updatedAt') DESC")
        .all()
        .map((row) => JSON.parse(row.metadata));
    case 'read': {
      const row = database.prepare('SELECT * FROM sessions WHERE id=?').get(message.sessionId);
      if (!row) return null;
      const ranges = JSON.parse(row.ranges),
        before = message.beforeSequence;
      let range =
        before === undefined
          ? ranges.at(-1)
          : ranges.find((part) => part[0] < before - 1 && part[1] >= before - 1);
      const gap = before !== undefined && !range;
      const previous = ranges.findLast((part) => part[1] < before - 1);
      if (gap && !message.offline) return { missingAfter: previous?.[1] ?? 0 };
      range ??= previous;
      if (!range) return null;
      const end = before === undefined || gap ? range[1] + 1 : before;
      const page = readHistory(database, message.sessionId, 0, end, range[0]);
      return {
        session: JSON.parse(row.metadata),
        ...page,
        mode: before === undefined ? 'replace' : 'prepend',
        hasEarlier: page.hasEarlier || range[0] > 0,
        cursor: JSON.parse(row.cursor),
        gap,
      };
    }
    case 'save':
      return transaction(() => {
        const { session, events, cursor, range, reset } = message;
        if (reset) database.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
        const previous = database
          .prepare('SELECT ranges,cursor FROM sessions WHERE id=?')
          .get(session.id);
        const known = previous ? JSON.parse(previous.cursor) : null;
        if (known && known.epoch !== cursor.epoch) return;
        const ranges = rangesTogether([...(previous ? JSON.parse(previous.ranges) : []), range]);
        database
          .prepare(
            'INSERT INTO sessions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,ranges=excluded.ranges,cursor=excluded.cursor',
          )
          .run(
            session.id,
            JSON.stringify({ ...session, activeRun: null }),
            JSON.stringify(ranges),
            JSON.stringify(known && known.sequence > cursor.sequence ? known : cursor),
          );
        const put = database.prepare('INSERT OR REPLACE INTO events VALUES(?,?,?,?)');
        for (const event of events)
          put.run(session.id, event.sequence, event.runId, JSON.stringify(event));
      });
    case 'metadata':
      database
        .prepare('UPDATE sessions SET metadata=? WHERE id=?')
        .run(JSON.stringify({ ...message.session, activeRun: null }), message.session.id);
      return;
    case 'catalog':
      return transaction(() => {
        const sessions = new Map(message.sessions.map((session) => [session.id, session]));
        for (const { id } of database.prepare('SELECT id FROM sessions').all()) {
          const session = sessions.get(id);
          if (session)
            database
              .prepare('UPDATE sessions SET metadata=? WHERE id=?')
              .run(JSON.stringify({ ...session, activeRun: null }), id);
          else database.prepare('DELETE FROM sessions WHERE id=?').run(id);
        }
      });
    case 'remove':
      database.prepare('DELETE FROM sessions WHERE id=?').run(message.sessionId);
      return;
    case 'clear':
      database.exec(
        'DELETE FROM sessions; PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);',
      );
      return;
    case 'stats':
      return {
        bytes: ['', '-wal', '-shm'].reduce(
          (sum, suffix) => sum + (existsSync(file + suffix) ? statSync(file + suffix).size : 0),
          0,
        ),
        sessions: Number(database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n),
        events: Number(database.prepare('SELECT COUNT(*) AS n FROM events').get().n),
      };
    default:
      throw new Error('未知缓存操作。');
  }
}
parentPort.on('message', ({ id, message }) => {
  try {
    parentPort.postMessage({ id, result: run(message) });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
