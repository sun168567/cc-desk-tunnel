import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const connections = createRequire(import.meta.url)('../electron/connections.cjs');
const profile = (context) => {
  const base = mkdtempSync(join(tmpdir(), 'cc-connections-'));
  context.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
};
// A sign-in as the main process saves it; `token` stands for the encrypted one.
const signIn = (base, id, url, values = {}) =>
  writeFileSync(
    join(connections.directory(base, id), 'settings.json'),
    JSON.stringify({ login: { url, fingerprint: '', mode: 'remote', ...values } }),
  );

test('the first connection leads the list and keeps the program profile', (context) => {
  const base = profile(context);
  assert.deepEqual(connections.list(base), [{ id: '', name: '' }]);
  assert.equal(connections.directory(base, ''), base);
  const work = connections.create(base, '  工作   账号 ');
  assert.equal(work.name, '工作 账号');
  assert.match(work.id, /^[a-z0-9]{8}$/);
  assert.equal(connections.directory(base, work.id), join(base, 'connections', work.id));
  assert.ok(existsSync(connections.directory(base, work.id)));
  connections.rename(base, '', '个人');
  assert.deepEqual(connections.list(base), [{ id: '', name: '个人' }, work]);
  assert.throws(() => connections.create(base, '个人'), /同名/);
  assert.throws(() => connections.rename(base, work.id, 'x'.repeat(25)), /24/);
  assert.throws(() => connections.rename(base, 'missing0', '别的'), /不存在/);
  // Without a name a connection goes by its service, and any number may be without one.
  connections.rename(base, work.id, '');
  const blank = connections.create(base);
  assert.deepEqual(connections.list(base), [
    { id: '', name: '个人' },
    { ...work, name: '' },
    blank,
  ]);
  // The name earlier versions gave the first connection is no name of the user's.
  connections.writeShared(base, 'connections', [{ id: '', name: '主连接' }]);
  assert.deepEqual(connections.list(base), [{ id: '', name: '' }]);
});

test('a connection goes by its name, or else by its service, path and all', (context) => {
  const base = profile(context);
  const { id } = connections.create(base);
  assert.equal(connections.labelOf(base, { id, name: '' }), '');
  signIn(base, id, 'wss://Example.com:443/team-a/ws');
  assert.equal(connections.labelOf(base, { id, name: '' }), 'Example.com:443/team-a/ws');
  assert.equal(connections.labelOf(base, { id, name: '公司' }), '公司');
  const key = connections.serviceKey;
  assert.equal(key(' wss://EXAMPLE.com:443/team-a/ws '), key('wss://example.com/team-a/ws'));
  assert.notEqual(key('wss://example.com/team-a/ws'), key('wss://example.com/team-b/ws'));
  assert.notEqual(key('wss://example.com/ws'), key('wss://example.com/ws/'));
  assert.equal(key('not an address'), 'not an address');
});

test('the services signed in to, the latest first, and the one that signs in by itself', (context) => {
  const base = profile(context);
  const home = connections.create(base, '家里');
  const blank = connections.create(base);
  signIn(base, '', 'wss://main/ws', { usedAt: 1 });
  signIn(base, home.id, 'wss://home/ws', { usedAt: 2, token: 'secret', autoLogin: true });
  assert.deepEqual(
    connections
      .accounts(base)
      .map(({ id, label, saved, autoLogin }) => ({ id, label, saved, autoLogin })),
    [
      // An earlier version's choice, kept with the sign-in, is taken over.
      { id: home.id, label: '家里', saved: true, autoLogin: true },
      { id: '', label: 'main/ws', saved: false, autoLogin: false },
    ],
  );
  assert.ok(!connections.accounts(base).some((entry) => entry.id === blank.id));
  // One without a remembered token cannot sign in by itself; choosing another takes the choice over.
  connections.setAutoLogin(base, '', true);
  assert.equal(connections.autoLogin(base), null);
  signIn(base, '', 'wss://main/ws', { usedAt: 1, token: 'secret' });
  assert.equal(connections.autoLogin(base), '');
  connections.setAutoLogin(base, home.id, false);
  assert.equal(connections.autoLogin(base), '');
  connections.setAutoLogin(base, '', false);
  assert.equal(connections.autoLogin(base), null);
  // Turned off, the earlier version's choice is not taken over again.
  assert.deepEqual(connections.readShared(base, 'autoLogin'), { id: null });
});

test('a start names its connection, or is a sign-in page of its own', (context) => {
  const base = profile(context);
  const pick = (...argv) => connections.choose(base, ['app', ...argv]);
  // The program's own windows name theirs; a name not in the list is the first connection's.
  const work = connections.create(base, '工作');
  assert.deepEqual(pick(`--connection=${work.id}`, '--sign-in'), { id: work.id, signIn: true });
  assert.deepEqual(pick(`--connection=${work.id}`), { id: work.id, signIn: false });
  assert.deepEqual(pick('--connection='), { id: '', signIn: false });
  assert.deepEqual(pick('--connection=../../else', '--sign-in'), { id: '', signIn: false });
  // A first start: no service yet, the first connection.
  assert.deepEqual(pick(), { id: '', signIn: false });
  // The latest service that is not open.
  signIn(base, '', 'wss://main/ws', { usedAt: 1 });
  signIn(base, work.id, 'wss://work/ws', { usedAt: 2, token: 'secret' });
  assert.deepEqual(pick(), { id: work.id, signIn: false });
  // With no window open, the one chosen to sign in by itself does.
  connections.setAutoLogin(base, work.id, false);
  connections.setAutoLogin(base, '', false);
  signIn(base, '', 'wss://main/ws', { usedAt: 1, token: 'secret' });
  connections.setAutoLogin(base, '', true);
  assert.deepEqual(pick(), { id: '', signIn: true });
  // A window open: another sign-in page, of the latest service not open.
  connections.mark(base, '', true);
  assert.deepEqual(pick(), { id: work.id, signIn: false });
  // All open: a connection that has signed in nowhere, made when there is none, then taken again.
  connections.mark(base, work.id, true);
  const made = pick();
  assert.equal(made.signIn, false);
  assert.ok(![work.id, ''].includes(made.id));
  assert.deepEqual(pick(), made);
  assert.equal(connections.list(base).length, 3);
  connections.mark(base, '', false);
  connections.mark(base, work.id, false);
});

test('a connection is removed with its profile, unless its window is open', (context) => {
  const base = profile(context);
  const { id } = connections.create(base, '工作');
  writeFileSync(join(connections.directory(base, id), 'drafts.json'), '{}');
  connections.mark(base, id, true);
  assert.equal(connections.running(base, id), true);
  assert.throws(() => connections.remove(base, id), /还开着/);
  // What it has running is told to the other connections, not to itself.
  connections.mark(base, id, true, [{ id: 's1', folder: 'D:\\work' }, { folder: 1 }]);
  assert.deepEqual(connections.busy(base, ''), [
    { name: '工作', runs: [{ id: 's1', folder: 'D:\\work' }] },
  ]);
  assert.deepEqual(connections.busy(base, id), []);
  connections.mark(base, id, false);
  assert.equal(connections.running(base, id), false);
  assert.deepEqual(connections.busy(base, ''), []);
  signIn(base, id, 'wss://work/ws', { token: 'secret' });
  connections.setAutoLogin(base, id, true);
  connections.remove(base, id);
  assert.equal(existsSync(connections.directory(base, id)), false);
  assert.deepEqual(connections.list(base), [{ id: '', name: '' }]);
  assert.equal(connections.autoLogin(base), null);
  assert.throws(() => connections.remove(base, 'abcd1234'), /不存在/);
  // The first connection's profile is the program's: its sign-in and name go, what is the computer's stays.
  writeFileSync(
    join(base, 'settings.json'),
    JSON.stringify({ deviceId: 'd', login: { url: 'wss://main/ws' } }),
  );
  connections.rename(base, '', '个人');
  connections.remove(base, '');
  assert.deepEqual(JSON.parse(readFileSync(join(base, 'settings.json'), 'utf8')), {
    deviceId: 'd',
  });
  assert.deepEqual(connections.list(base), [{ id: '', name: '' }]);
  assert.ok(existsSync(base));
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
  assert.deepEqual(connections.list(base), [
    { id: '', name: '' },
    { id: 'abcd1234', name: '好' },
  ]);
});
