import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const connections = createRequire(import.meta.url)('../electron/connections.cjs');
const profile = (context) => {
  const base = mkdtempSync(join(tmpdir(), 'cc-connections-'));
  context.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
};
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
// A connection that has signed in, as the main process saves it; `token` stands for the encrypted one.
function signedIn(base, url, values = {}, name = '') {
  const id = connections.create(base, { url, fingerprint: '', mode: 'remote' });
  connections.writeSettings(base, id, {
    login: { url, fingerprint: '', mode: 'remote', ...values },
    pending: undefined,
  });
  if (name) connections.rename(base, id, name);
  return id;
}

test('a connection is made for a service, and goes by its name or else its address, path and all', (context) => {
  const base = profile(context);
  assert.deepEqual(connections.list(base), []);
  const id = connections.create(base, { url: 'wss://Example.com:443/team-a/ws' });
  assert.match(id, /^[a-z0-9]{8}$/);
  assert.equal(connections.directory(base, id), join(base, 'connections', id));
  assert.deepEqual(connections.list(base), [{ id, name: '' }]);
  // Until it has signed in it is a try, which no list offers.
  assert.equal(connections.pending(base, id), true);
  assert.deepEqual(connections.accounts(base), []);
  connections.writeSettings(base, id, { pending: undefined });
  assert.equal(connections.labelOf(base, { id, name: '' }), 'Example.com:443/team-a/ws');
  connections.rename(base, id, '  公司   开发 ');
  assert.equal(connections.labelOf(base, connections.list(base)[0]), '公司 开发');
  assert.throws(() => connections.rename(base, id, 'x'.repeat(25)), /24/);
  assert.throws(() => connections.rename(base, 'missing0', '别的'), /不存在/);
  const other = signedIn(base, 'wss://example.com/team-b/ws');
  assert.throws(() => connections.rename(base, other, '公司 开发'), /同名/);
  // Without a name, any number go by their addresses.
  connections.rename(base, id, '');
  assert.deepEqual(connections.list(base), [
    { id, name: '' },
    { id: other, name: '' },
  ]);
  const key = connections.serviceKey;
  assert.equal(key(' wss://EXAMPLE.com:443/team-a/ws '), key('wss://example.com/team-a/ws'));
  assert.notEqual(key('wss://example.com/team-a/ws'), key('wss://example.com/team-b/ws'));
  assert.notEqual(key('wss://example.com/ws'), key('wss://example.com/ws/'));
  assert.equal(key('not an address'), 'not an address');
  assert.equal(connections.owner(base, 'wss://EXAMPLE.com/team-a/ws').id, id);
  assert.equal(connections.owner(base, 'wss://example.com/team-c/ws'), null);
});

test('the services signed in to, the latest first, and the one that signs in by itself', (context) => {
  const base = profile(context);
  const main = signedIn(base, 'wss://main/ws', { usedAt: 1 });
  const home = signedIn(
    base,
    'wss://home/ws',
    { usedAt: 2, token: 'secret', autoLogin: true },
    '家里',
  );
  assert.deepEqual(
    connections
      .accounts(base)
      .map(({ id, label, saved, autoLogin }) => ({ id, label, saved, autoLogin })),
    [
      // An earlier version's choice, kept with the sign-in, is taken over.
      { id: home, label: '家里', saved: true, autoLogin: true },
      { id: main, label: 'main/ws', saved: false, autoLogin: false },
    ],
  );
  // One without a remembered token cannot sign in by itself; choosing another takes the choice over.
  connections.setAutoLogin(base, main, true);
  assert.equal(connections.autoLogin(base), null);
  connections.writeSettings(base, main, { login: { url: 'wss://main/ws', usedAt: 1, token: 's' } });
  assert.equal(connections.autoLogin(base), main);
  connections.setAutoLogin(base, home, false);
  assert.equal(connections.autoLogin(base), main);
  connections.setAutoLogin(base, main, false);
  assert.equal(connections.autoLogin(base), null);
  // Turned off, the earlier version's choice is not taken over again.
  assert.deepEqual(connections.readShared(base, 'autoLogin'), { id: null });
});

test('a start names its connection, or is a sign-in window', (context) => {
  const base = profile(context);
  const role = (...argv) => connections.role(base, ['app', ...argv]);
  const id = signedIn(base, 'wss://work/ws');
  assert.deepEqual(role(`--connection=${id}`, '--sign-in'), { id, signIn: true });
  assert.deepEqual(role(`--connection=${id}`), { id, signIn: false });
  for (const argv of [
    [],
    ['--connection='],
    ['--connection=abcdefgh'],
    ['--connection=../../else'],
  ])
    assert.deepEqual(role(...argv), { id: null, signIn: false });
});

test('a connection is removed with its profile, unless its window is open', (context) => {
  const base = profile(context);
  const id = signedIn(base, 'wss://work/ws', { token: 'secret' }, '工作');
  writeFileSync(join(connections.directory(base, id), 'drafts.json'), '{}');
  connections.mark(base, id, true);
  assert.equal(connections.running(base, id), true);
  assert.throws(() => connections.remove(base, id), /还开着/);
  // What it has running is told to the other connections, not to itself.
  connections.mark(base, id, true, [{ id: 's1', folder: 'D:\\work' }, { folder: 1 }]);
  assert.deepEqual(connections.busy(base, 'other000'), [
    { name: '工作', runs: [{ id: 's1', folder: 'D:\\work' }] },
  ]);
  assert.deepEqual(connections.busy(base, id), []);
  connections.mark(base, id, false);
  assert.equal(connections.running(base, id), false);
  connections.setAutoLogin(base, id, true);
  connections.remove(base, id);
  assert.equal(existsSync(connections.directory(base, id)), false);
  assert.deepEqual(connections.list(base), []);
  assert.equal(connections.autoLogin(base), null);
  assert.throws(() => connections.remove(base, id), /不存在/);
});

test('what sign-in windows and unfinished connections leave goes, once their windows have', (context) => {
  const base = profile(context);
  const open = connections.launcherDirectory(base);
  const gone = join(base, 'launchers', 'gone0000');
  mkdirSync(gone, { recursive: true });
  writeFileSync(join(gone, 'instance.json'), JSON.stringify({ pid: 2 ** 30 }));
  const kept = signedIn(base, 'wss://kept/ws');
  const tried = connections.create(base, { url: 'wss://typo/ws' });
  const trying = connections.create(base, { url: 'wss://slow/ws' });
  const now = Date.now();
  connections.writeSettings(base, tried, { pending: now - 200_000 });
  connections.tidy(base, now);
  assert.ok(existsSync(open));
  assert.ok(!existsSync(gone));
  // One made a moment ago may not have started yet.
  assert.deepEqual(
    connections.list(base).map((entry) => entry.id),
    [kept, trying],
  );
  assert.ok(!existsSync(connections.directory(base, tried)));
});

test('an earlier version’s first connection moves to a directory of its own, with what is the computer’s left', (context) => {
  const base = profile(context);
  writeFileSync(
    join(base, 'settings.json'),
    JSON.stringify({
      deviceId: 'd',
      closeToTray: false,
      workspaceRoots: ['D:\\work'],
      login: { url: 'wss://main/ws', token: 'secret', autoLogin: true },
      window: { maximized: true },
    }),
  );
  for (const name of ['Local State', 'drafts.json', 'schedules.json'])
    writeFileSync(join(base, name), name);
  mkdirSync(join(base, 'Local Storage', 'leveldb'), { recursive: true });
  writeFileSync(join(base, 'Local Storage', 'leveldb', 'CURRENT'), 'x');
  mkdirSync(join(base, 'shared'));
  const other = '1234abcd';
  connections.writeShared(base, 'connections', [
    { id: '', name: '个人' },
    { id: other, name: '工作' },
  ]);
  connections.writeShared(base, 'autoLogin', { id: '' });
  // Not while its window is open.
  writeFileSync(join(base, 'instance.json'), JSON.stringify({ pid: process.pid }));
  assert.equal(connections.adopt(base), null);
  rmSync(join(base, 'instance.json'));
  const id = connections.adopt(base);
  const own = connections.directory(base, id);
  for (const name of ['Local State', 'drafts.json', 'schedules.json']) {
    assert.equal(readFileSync(join(own, name), 'utf8'), name);
    assert.ok(!existsSync(join(base, name)));
  }
  assert.ok(existsSync(join(own, 'Local Storage', 'leveldb', 'CURRENT')));
  assert.deepEqual(read(join(base, 'settings.json')), {
    deviceId: 'd',
    closeToTray: false,
    workspaceRoots: ['D:\\work'],
  });
  assert.deepEqual(read(join(own, 'settings.json')), {
    login: { url: 'wss://main/ws', token: 'secret', autoLogin: true },
    window: { maximized: true },
  });
  assert.deepEqual(connections.list(base), [
    { id, name: '个人' },
    { id: other, name: '工作' },
  ]);
  assert.equal(connections.autoLogin(base), id);
  assert.ok(!existsSync(join(base, 'shared', 'moving.json')));
  // Once moved, there is nothing more to move.
  assert.equal(connections.adopt(base), null);
});

test('a move interrupted goes on at the next start, and the old name is no name of the user’s', (context) => {
  const base = profile(context);
  writeFileSync(join(base, 'settings.json'), JSON.stringify({ deviceId: 'd' }));
  connections.writeShared(base, 'connections', [{ id: '', name: '主连接' }]);
  // Moved in part: the log went, the drafts did not.
  const id = 'abcd0000';
  connections.writeShared(base, 'moving', { id });
  mkdirSync(join(connections.directory(base, id), 'logs'), { recursive: true });
  writeFileSync(join(base, 'drafts.json'), '{}');
  assert.equal(connections.adopt(base), id);
  assert.ok(existsSync(join(connections.directory(base, id), 'drafts.json')));
  assert.deepEqual(connections.list(base), [{ id, name: '' }]);
  // It kept no address: it is listed, to be opened to sign in from its own window.
  assert.deepEqual(
    connections.accounts(base).map(({ id, url, label }) => ({ id, url, label })),
    [{ id, url: '', label: '' }],
  );
  // A program that was never used before has nothing to move.
  const fresh = profile(context);
  writeFileSync(join(fresh, 'settings.json'), JSON.stringify({ deviceId: 'd' }));
  assert.equal(connections.adopt(fresh), null);
  assert.deepEqual(connections.list(fresh), []);
});

test('a damaged list and a shared value that is not there are passed over', (context) => {
  const base = profile(context);
  assert.equal(connections.readShared(base, 'prefs'), undefined);
  connections.writeShared(base, 'prefs', { a: 1 });
  assert.deepEqual(connections.readShared(base, 'prefs'), { a: 1 });
  connections.writeShared(base, 'connections', [
    { id: '../up', name: '坏' },
    { id: 'abcd1234', name: '好' },
    { id: 'abcd1234', name: '重复' },
    null,
  ]);
  assert.deepEqual(connections.list(base), [{ id: 'abcd1234', name: '好' }]);
});
