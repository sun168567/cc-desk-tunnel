import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/store.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-move-'));
  const store = new SessionStore(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, session: store.create(randomUUID(), '会话', 'D:\\项目 甲') };
}
// What a first native run leaves behind: the prompt it was given and a native session to resume.
function ran(store: SessionStore, sessionId: string, connectionId: string) {
  const path = store.promptPath(sessionId, connectionId);
  store.append(sessionId, randomUUID(), {
    type: 'native.session',
    nativeSessionId: sessionId,
    model: 'test',
    version: 'test',
  });
  return path;
}

test('a session that never ran simply changes its project', (t) => {
  const { store, session } = fixture(t);
  assert.equal(store.move(session.id, 'D:\\项目 乙').projectPath, 'D:\\项目 乙');
  assert.equal(store.moveNotice(session.id), '');
  assert.equal(store.promptPath(session.id, randomUUID()), 'D:\\项目 乙');
});

test('a move is told once with the next message, and the system prompt keeps its path while the cache holds', (t) => {
  const { store, session } = fixture(t);
  const connection = randomUUID();
  assert.equal(ran(store, session.id, connection), 'D:\\项目 甲');
  store.move(session.id, 'D:\\项目 乙');
  store.move(session.id, 'D:\\项目 丙');
  // Same connection, nothing compacted: the prompt is byte for byte what it was.
  assert.equal(store.promptPath(session.id, connection), 'D:\\项目 甲');
  const notice = store.moveNotice(session.id);
  // The notice names where the session is now and the path Claude knew, not the stops in between.
  assert.match(notice, /is now "D:\\\\项目 丙" \(it was "D:\\\\项目 甲"\)/);
  assert.doesNotMatch(notice, /乙/);
  assert.equal(store.moveNotice(session.id), '');
  assert.equal(store.promptPath(session.id, connection), 'D:\\项目 甲');

  // A compaction rewrites what follows the prompt; from the next run the prompt says the current path.
  store.compacted(session.id);
  assert.equal(store.promptPath(session.id, connection), 'D:\\项目 丙');
  assert.equal(store.get(session.id).session.prompt?.compacted, undefined);
});

test('another connection changes the system prompt anyway, so the path follows at once', (t) => {
  const { store, session } = fixture(t);
  ran(store, session.id, randomUUID());
  store.move(session.id, 'D:\\项目 乙');
  assert.equal(store.promptPath(session.id, randomUUID()), 'D:\\项目 乙');
  // Claude still hears of the move: its earlier turns speak of the old path.
  assert.match(store.moveNotice(session.id), /项目 乙/);
});

test('moving back before anything was said leaves nothing to tell, and a running session cannot move', (t) => {
  const { store, session } = fixture(t);
  const connection = randomUUID();
  ran(store, session.id, connection);
  store.move(session.id, 'D:\\项目 乙');
  store.move(session.id, 'D:\\项目 甲');
  assert.equal(store.moveNotice(session.id), '');
  store.append(session.id, randomUUID(), {
    type: 'run.status',
    status: 'awaiting_approval',
    connectionId: connection,
    waiting: 'question',
  });
  assert.equal(store.get(session.id).session.activeRun?.waiting, 'question');
  assert.throws(() => store.move(session.id, 'D:\\项目 乙'), /结束当前运行/);
});
