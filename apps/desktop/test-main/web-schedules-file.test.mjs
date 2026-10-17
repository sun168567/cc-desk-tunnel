import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const filename = fileURLToPath(new URL('../electron/main.cjs', import.meta.url));
const require = createRequire(filename);
const source = readFileSync(filename, 'utf8');
const hash = (text) => createHash('sha256').update(text).digest('hex');

// Run the real synchronous IPC handlers against an isolated file, without Electron or a listener.
function fixture(t) {
  const temporaryRoot = realpathSync(tmpdir());
  const profile = mkdtempSync(join(temporaryRoot, 'cc-web-schedule-file-'));
  t.after(() => {
    const resolved = realpathSync(profile);
    assert.equal(dirname(resolved), temporaryRoot);
    assert.equal(basename(resolved), basename(profile));
    rmSync(resolved, { recursive: true, force: true });
  });
  const handlers = new Map();
  const messages = [];
  const intervals = [];
  const sender = { send: (...args) => messages.push(args) };
  const electron = {
    app: {
      getPath: () => profile,
      requestSingleInstanceLock: () => true,
      isPackaged: false,
      whenReady: () => new Promise(() => {}),
      setAppUserModelId() {},
      on() {},
    },
    ipcMain: { handle: (name, listener) => handlers.set(name, listener), on() {} },
    BrowserWindow: { getAllWindows: () => [{ webContents: sender }] },
  };
  const mockRequire = (name) => {
    if (name === 'electron') return electron;
    if (name === './connections.cjs')
      return {
        requested: () => '',
        list: () => [{ id: '', name: '主连接' }],
        busy: () => [],
        readShared: () => undefined,
      };
    if (name === './client-log.cjs') return { openLog: () => ({ write() {} }) };
    return require(name);
  };
  const execute = new Script(
    `(function(require, __dirname, process, setInterval) {\n${source}\nreturn { enable: value => { webServer = value; }, cache: () => schedules };\n})`,
    { filename },
  ).runInThisContext();
  const control = execute(mockRequire, dirname(filename), { ...process, argv: [] }, (callback) => {
    intervals.push(callback);
    return 0;
  });
  const file = join(profile, 'schedules.json');
  const call = (method, ...args) =>
    handlers.get(method)({ senderFrame: { url: 'file:///desktop/index.html' }, sender }, ...args);
  call('schedules:load', '{"tasks":[]}');
  return {
    call,
    untrusted: (method) =>
      handlers.get(method)({ senderFrame: { url: 'http://example.invalid' }, sender }),
    enable: () => control.enable({}),
    cache: control.cache,
    read: () => readFileSync(file, 'utf8'),
    external: (text) => writeFileSync(file, text),
    watch: () => intervals[0](),
    messages,
  };
}

test('schedule file access is desktop-only and available only while Web is enabled', (t) => {
  const host = fixture(t);
  assert.throws(() => host.call('remote:schedules:read'), /已关闭/);
  assert.throws(
    () => host.call('remote:schedules:save', '{"tasks":[]}', hash(host.read())),
    /已关闭/,
  );
  host.enable();
  assert.throws(() => host.untrusted('remote:schedules:read'), /Untrusted/);
  const snapshot = host.call('remote:schedules:read');
  assert.equal(snapshot.text, host.read());
  assert.equal(snapshot.revision, hash(snapshot.text));
});

test('two saves of the same revision accept only one and publish the committed file once', async (t) => {
  const host = fixture(t);
  host.enable();
  host.call('schedules:save', '{"tasks":[{"id":"old"}]}');
  const snapshot = host.call('remote:schedules:read');
  const deleted = '{"tasks":[]}';
  const results = await Promise.allSettled([
    Promise.resolve().then(() => host.call('remote:schedules:save', deleted, snapshot.revision)),
    Promise.resolve().then(() =>
      host.call('remote:schedules:save', snapshot.text, snapshot.revision),
    ),
  ]);
  assert.deepEqual(
    results.map(({ status }) => status),
    ['fulfilled', 'rejected'],
  );
  assert.match(results[1].reason.message, /更改/);
  assert.equal(host.read(), deleted);
  assert.equal(host.cache(), deleted);
  assert.deepEqual(host.messages, [['schedules:changed', deleted]]);
});

test('a desktop or external save between snapshot and Web save wins without corrupting the watcher cache', (t) => {
  const host = fixture(t);
  host.enable();
  const snapshot = host.call('remote:schedules:read');
  const desktop = '{"tasks":[{"id":"desktop"}]}';
  host.call('schedules:save', desktop);
  assert.throws(() => host.call('remote:schedules:save', snapshot.text, snapshot.revision), /更改/);
  assert.equal(host.read(), desktop);
  assert.equal(host.cache(), desktop);
  assert.deepEqual(host.messages, []);
  const external = '{"tasks":[{"id":"external"}]}';
  host.external(external);
  const latest = host.call('remote:schedules:read');
  assert.equal(latest.text, external);
  assert.equal(latest.revision, hash(external));
  assert.equal(host.cache(), desktop, 'a Web read does not consume a pending file-watch change');
  host.watch();
  assert.equal(host.cache(), external);
  assert.deepEqual(host.messages, [['schedules:changed', external]]);
});

test('malformed files and malformed replacements preserve both the source and the watcher cache', (t) => {
  const host = fixture(t);
  host.enable();
  const cache = host.cache();
  for (const broken of ['{', '{"tasks":null}', 'null']) {
    host.external(broken);
    const snapshot = host.call('remote:schedules:read');
    assert.throws(() => host.call('remote:schedules:save', '{"tasks":[]}', snapshot.revision));
    assert.equal(host.read(), broken);
    assert.equal(host.cache(), cache);
  }
  host.external(cache);
  assert.throws(() => host.call('remote:schedules:save', '{', hash(cache)));
  assert.equal(host.read(), cache);
  assert.deepEqual(host.messages, []);
});
