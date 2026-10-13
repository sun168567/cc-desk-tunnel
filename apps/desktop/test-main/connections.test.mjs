import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const connections = createRequire(import.meta.url)('../electron/connections.cjs');
const profile = (context) => {
  const base = mkdtempSync(join(tmpdir(), 'cc-connections-'));
  context.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
};

test('the first connection leads the list and keeps the program profile', (context) => {
  const base = profile(context);
  assert.deepEqual(connections.list(base), [{ id: '', name: '主连接' }]);
  assert.equal(connections.directory(base, ''), base);
  const work = connections.create(base, '  工作   账号 ');
  assert.equal(work.name, '工作 账号');
  assert.match(work.id, /^[a-z0-9]{8}$/);
  assert.equal(connections.directory(base, work.id), join(base, 'connections', work.id));
  assert.ok(existsSync(connections.directory(base, work.id)));
  connections.rename(base, '', '个人');
  assert.deepEqual(connections.list(base), [{ id: '', name: '个人' }, work]);
  assert.throws(() => connections.create(base, '个人'), /同名/);
  assert.throws(() => connections.rename(base, work.id, ''), /名称/);
  assert.throws(() => connections.rename(base, 'missing0', '别的'), /不存在/);
});

test('a command line names only a connection that is in the list', (context) => {
  const base = profile(context);
  const { id } = connections.create(base, '工作');
  assert.equal(connections.requested(['app', `--connection=${id}`], base), id);
  assert.equal(connections.requested(['app', '--connection=../../else'], base), '');
  assert.equal(connections.requested(['app', '--connection=abcdefgh'], base), '');
  assert.equal(connections.requested(['app'], base), '');
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
  assert.throws(() => connections.remove(base, ''), /不存在/);
  connections.remove(base, id);
  assert.equal(existsSync(connections.directory(base, id)), false);
  assert.deepEqual(connections.list(base), [{ id: '', name: '主连接' }]);
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
    { id: '', name: '主连接' },
    { id: 'abcd1234', name: '好' },
  ]);
});
