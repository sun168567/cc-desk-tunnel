import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/store.ts';

const desktop = { id: randomUUID(), name: '台式机' };
const laptop = { id: randomUUID(), name: '笔记本' };
const server = { id: randomUUID(), name: '服务端', platform: 'linux' as const };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-projects-'));
  let store = new SessionStore(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    reopen() {
      store.close();
      return (store = new SessionStore(directory));
    },
  };
}
const create = (store: SessionStore, path: string, device = desktop, plain = false) =>
  store.create(randomUUID(), '会话', path, device, plain);
const listed = (store: SessionStore) =>
  store.projects().map(({ device, path, name }) => [device.name, path, name ?? null]);

test('a folder a session is made in becomes a project, but for a plain session', (t) => {
  const { store } = fixture(t);
  const first = create(store, 'D:\\项目\\甲');
  create(store, 'd:/项目/甲/');
  create(store, 'D:\\Documents\\CC Desk Tunnel\\2026-11-23\\101500', desktop, true);
  store.createOnServer(randomUUID(), '服务端会话', server);
  assert.deepEqual(listed(store), [['台式机', 'D:\\项目\\甲', null]]);
  // The project names the directory its sessions work in on the service.
  assert.equal(store.projects()[0].root, first.nativeRoot);
  assert.ok(store.isProject(desktop.id, 'd:\\项目\\甲'));
  assert.ok(!store.isProject(laptop.id, 'D:\\项目\\甲'));
});

test('moving a session or forking it into a folder makes the folder a project; a fork beside its source does not', (t) => {
  const { store } = fixture(t);
  const plain = create(store, 'D:\\Documents\\CC Desk Tunnel\\2026-11-23\\101500', desktop, true);
  store.fork(randomUUID(), plain.id, randomUUID(), '分叉', false, { device: desktop });
  assert.deepEqual(listed(store), []);
  store.move(plain.id, 'D:\\项目\\乙', desktop);
  store.fork(randomUUID(), plain.id, randomUUID(), '分叉', false, {
    device: laptop,
    projectPath: 'E:\\笔记本',
  });
  assert.deepEqual(listed(store), [
    ['台式机', 'D:\\项目\\乙', null],
    ['笔记本', 'E:\\笔记本', null],
  ]);
});

test('a project is named and removed; removed, its sessions stay and its directory waits for it', (t) => {
  const { store } = fixture(t);
  const session = create(store, 'D:\\项目\\甲');
  store.renameProject(desktop.id, 'd:\\项目\\甲', '甲方');
  assert.deepEqual(listed(store), [['台式机', 'D:\\项目\\甲', '甲方']]);
  store.renameProject(desktop.id, 'D:\\项目\\甲', '');
  assert.deepEqual(listed(store), [['台式机', 'D:\\项目\\甲', null]]);
  store.unregister(desktop.id, 'D:\\项目\\甲');
  assert.deepEqual(listed(store), []);
  assert.equal(store.get(session.id).session.projectPath, 'D:\\项目\\甲');
  assert.throws(() => store.unregister(desktop.id, 'D:\\项目\\甲'), /项目不存在/);
  assert.throws(() => store.renameProject(desktop.id, 'D:\\项目\\甲', '甲'), /项目不存在/);
  // Added again, with a name, it has the directory of before; adding it once more keeps the name.
  store.register(desktop, 'D:\\项目\\甲', '回来了');
  store.register(desktop, 'D:\\项目\\甲');
  assert.deepEqual(listed(store), [['台式机', 'D:\\项目\\甲', '回来了']]);
  assert.equal(store.projects()[0].root, session.nativeRoot);
});

test('a project moved to another folder keeps its place and name, or joins the project already there', (t) => {
  const { store } = fixture(t);
  create(store, 'D:\\项目\\甲');
  create(store, 'D:\\项目\\乙');
  store.renameProject(desktop.id, 'D:\\项目\\甲', '甲方');
  store.moveProject('D:\\项目\\甲', 'E:\\新家\\甲', desktop);
  assert.deepEqual(listed(store), [
    ['台式机', 'E:\\新家\\甲', '甲方'],
    ['台式机', 'D:\\项目\\乙', null],
  ]);
  store.renameProject(desktop.id, 'D:\\项目\\乙', '乙方');
  store.moveProject('E:\\新家\\甲', 'D:\\项目\\乙', desktop);
  assert.deepEqual(listed(store), [['台式机', 'D:\\项目\\乙', '乙方']]);
});

test('a computer signing in under a new name renames it in its projects', (t) => {
  const { store } = fixture(t);
  create(store, 'D:\\项目\\甲');
  create(store, 'E:\\笔记本', laptop);
  store.named({ ...desktop, name: '新台式机' });
  assert.deepEqual(listed(store), [
    ['新台式机', 'D:\\项目\\甲', null],
    ['笔记本', 'E:\\笔记本', null],
  ]);
});

test('the projects start as the folders of the sessions there were, but for those of plain sessions', (t) => {
  const made = fixture(t);
  const store = made.store;
  const later = create(store, 'D:\\项目\\乙');
  const earlier = create(store, 'D:\\项目\\甲');
  create(store, 'D:\\项目\\甲');
  create(store, 'D:\\Documents\\CC Desk Tunnel\\2026-11-23\\101500', desktop, true);
  create(store, 'D:\\别处\\2026-11-23\\101502-1', laptop, true);
  store.createOnServer(randomUUID(), '服务端会话', server);
  const legacy = create(store, 'D:\\更早的项目');
  // As a library from before the service kept them: no projects, sessions made in another order, one of them
  // from before computers were told apart.
  const at = (id: string, time: string) =>
    store.database
      .prepare("UPDATE sessions SET metadata = json_set(metadata, '$.createdAt', ?) WHERE id = ?")
      .run(time, id);
  at(earlier.id, '2026-01-01T00:00:00.000Z');
  at(later.id, '2026-02-01T00:00:00.000Z');
  store.database
    .prepare("UPDATE sessions SET metadata = json_remove(metadata, '$.device') WHERE id = ?")
    .run(legacy.id);
  store.database.exec("DELETE FROM projects; DELETE FROM migrations WHERE name = 'projects'");
  const reopened = made.reopen();
  assert.deepEqual(listed(reopened), [
    ['台式机', 'D:\\项目\\甲', null],
    ['台式机', 'D:\\项目\\乙', null],
  ]);
  // The one from before computers were told apart becomes a project once a computer takes it.
  reopened.claim(legacy.id, laptop);
  assert.deepEqual(listed(reopened).at(-1), ['笔记本', 'D:\\更早的项目', null]);
  // Done once: a project removed after does not come back.
  reopened.unregister(desktop.id, 'D:\\项目\\乙');
  assert.deepEqual(listed(made.reopen()).length, 2);
});
