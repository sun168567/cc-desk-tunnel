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
function ran(store: SessionStore, sessionId: string, powershellPath = 'C:\\pwsh.exe') {
  const said = store.promptValues(sessionId, powershellPath);
  store.append(sessionId, randomUUID(), {
    type: 'native.session',
    nativeSessionId: sessionId,
    model: 'test',
    version: 'test',
  });
  return said.projectPath;
}

test('a session that never ran simply changes its project', (t) => {
  const { store, session } = fixture(t);
  assert.equal(store.move(session.id, 'D:\\项目 乙').projectPath, 'D:\\项目 乙');
  assert.equal(store.notice(session.id, 'C:\\pwsh.exe'), '');
  assert.equal(store.promptValues(session.id, 'C:\\pwsh.exe').projectPath, 'D:\\项目 乙');
});

test('a move is told once with the next message, and the system prompt keeps its path until a compaction', (t) => {
  const { store, session } = fixture(t);
  assert.equal(ran(store, session.id), 'D:\\项目 甲');
  store.move(session.id, 'D:\\项目 乙');
  store.move(session.id, 'D:\\项目 丙');
  // Nothing compacted: the prompt is byte for byte what it was, whichever connection the run is on.
  assert.equal(ran(store, session.id), 'D:\\项目 甲');
  const notice = store.notice(session.id);
  // The notice names where the session is now and the path Claude knew, not the stops in between.
  assert.match(notice, /is now "D:\\\\项目 丙" \(it was "D:\\\\项目 甲"\)/);
  assert.doesNotMatch(notice, /乙/);
  assert.equal(store.notice(session.id), '');
  assert.equal(ran(store, session.id), 'D:\\项目 甲');

  // A compaction rewrites what follows the prompt; from the next run the prompt says the current path.
  store.compacted(session.id);
  assert.equal(ran(store, session.id), 'D:\\项目 丙');
  assert.equal(store.get(session.id).session.prompt?.compacted, undefined);
});

test('a PowerShell path that differs on reconnect is told with the next message, not put in the prompt', (t) => {
  const { store, session } = fixture(t);
  ran(store, session.id, 'C:\\old\\pwsh.exe');
  assert.equal(store.notice(session.id, 'C:\\old\\pwsh.exe'), '');
  const notice = store.notice(session.id, 'D:\\new\\pwsh.exe');
  assert.match(notice, /is now "D:\\\\new\\\\pwsh.exe" \(it was "C:\\\\old\\\\pwsh.exe"\)/);
  assert.equal(
    store.promptValues(session.id, 'D:\\new\\pwsh.exe').powershellPath,
    'C:\\old\\pwsh.exe',
  );
  assert.equal(store.notice(session.id, 'D:\\new\\pwsh.exe'), '');
  // Back on the first computer: Claude was last told the other path.
  assert.match(store.notice(session.id, 'C:\\old\\pwsh.exe'), /is now "C:\\\\old/);

  // After a compaction the prompt itself is current, and there is nothing left to tell.
  store.compacted(session.id);
  assert.equal(store.notice(session.id, 'D:\\new\\pwsh.exe'), '');
  assert.equal(
    store.promptValues(session.id, 'D:\\new\\pwsh.exe').powershellPath,
    'D:\\new\\pwsh.exe',
  );
  assert.equal(store.notice(session.id, 'D:\\new\\pwsh.exe'), '');
});

test('moving back before anything was said leaves nothing to tell, and a running session cannot move', (t) => {
  const { store, session } = fixture(t);
  ran(store, session.id);
  store.move(session.id, 'D:\\项目 乙');
  store.move(session.id, 'D:\\项目 甲');
  assert.equal(store.notice(session.id), '');
  store.append(session.id, randomUUID(), {
    type: 'run.status',
    status: 'awaiting_approval',
    connectionId: randomUUID(),
    waiting: 'question',
  });
  assert.equal(store.get(session.id).session.activeRun?.waiting, 'question');
  assert.throws(() => store.move(session.id, 'D:\\项目 乙'), /结束当前运行/);
});
