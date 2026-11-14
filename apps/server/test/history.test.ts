import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/store.ts';
import type { EventPayload } from '@cc-desk-tunnel/protocol';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-history-'));
  const made = { store: new SessionStore(directory), directory };
  t.after(() => {
    made.store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const session = made.store.create(randomUUID(), '长会话', 'D:\\中文 项目', {
    id: randomUUID(),
    name: '台式机',
  });
  return { ...made, session, made };
}

// A library as versions before 0.2.12 left it: every piece of output a record of its own.
function reopenAsOld(made: { store: SessionStore; directory: string }) {
  made.store.database.exec("DELETE FROM migrations WHERE name = 'merged-fragments'");
  made.store.close();
  return (made.store = new SessionStore(made.directory));
}
const texts = (events: { payload: EventPayload }[]) =>
  events.map(({ payload }) => (payload.type === 'text.delta' ? payload.text : '')).join('');

test('history pages retain complete runs of a merged library without losing content or cursors', (t) => {
  const f = fixture(t);
  const { session } = f;
  const connectionId = randomUUID();
  for (let turn = 0; turn < 20; turn++) {
    const runId = randomUUID(),
      messageId = randomUUID();
    f.store.append(session.id, runId, {
      type: 'message.user',
      messageId: randomUUID(),
      text: `turn-${turn}`,
      scenario: 'chat',
    });
    f.store.append(session.id, runId, { type: 'run.status', status: 'running', connectionId });
    for (let index = 0; index < 100; index++)
      f.store.append(session.id, runId, {
        type: 'text.delta',
        messageId,
        text: `中文-${turn}-${index};`,
      });
    f.store.append(session.id, runId, { type: 'run.status', status: 'completed', connectionId });
  }
  const before = f.store.snapshot(session.id).events;
  const store = reopenAsOld(f.made);
  const all = store.snapshot(session.id).events;
  assert.equal(all.length, 20 * 4);
  assert.equal(all.at(-1)!.sequence, before.at(-1)!.sequence);
  assert.equal(texts(all), texts(before));
  let page = store.history(session.id, randomUUID());
  assert.equal(page.mode, 'replace');
  assert.equal(page.lastSequence, all.at(-1)!.sequence);
  // A cursor from before the merge still says where to go on from.
  const cursor = before.at(-3)!.sequence;
  assert.deepEqual(
    store.history(session.id, randomUUID(), cursor).events.map((event) => event.sequence),
    all.slice(-2).map((event) => event.sequence),
  );
  const seen = new Set<string>();
  let text = '';
  for (;;) {
    assert.equal(page.events[0].payload.type, 'message.user');
    assert.equal(page.events.at(-1)!.payload.type, 'run.status');
    for (const event of page.events) {
      if (event.payload.type === 'message.user') {
        assert.ok(!seen.has(event.runId), 'Run is split across pages');
        seen.add(event.runId);
      }
    }
    text = texts(page.events) + text;
    if (!page.hasEarlier) break;
    page = store.history(session.id, randomUUID(), 0, page.firstSequence);
    assert.equal(page.mode, 'prepend');
  }
  assert.equal(seen.size, 20);
  assert.equal(text, texts(before));
  assert.equal(store.history(session.id, randomUUID(), all.at(-1)!.sequence).events.length, 0);
  // New events go on from the last number.
  const next = store.append(session.id, randomUUID(), { type: 'native.notice', text: 'next' });
  assert.equal(next.sequence, before.at(-1)!.sequence + 1);
});

test('small reconnect gaps only return unseen events and invalid page cursors are rejected', (t) => {
  const { store, session } = fixture(t);
  const runId = randomUUID(),
    messageId = randomUUID();
  store.append(session.id, runId, {
    type: 'message.user',
    messageId: randomUUID(),
    text: 'start',
    scenario: 'chat',
  });
  for (const text of ['a', 'b', 'c'])
    store.append(session.id, runId, { type: 'text.delta', messageId, text });
  const page = store.history(session.id, randomUUID(), 2);
  assert.equal(page.mode, 'append');
  assert.equal(page.lastSequence, 4);
  assert.equal(texts(page.events), 'bc');
  assert.throws(() => store.history(session.id, randomUUID(), 5), /游标/);
  assert.throws(() => store.history(session.id, randomUUID(), 0, 6), /游标/);
});

test('merging an old library keeps tool identities, stream distinctions and message boundaries, and leaves a copy with a note', (t) => {
  const f = fixture(t);
  const { session } = f;
  const runId = randomUUID(),
    messageId = randomUUID();
  const payloads: EventPayload[] = [
    { type: 'text.delta', messageId, text: 'a' },
    { type: 'text.delta', messageId, text: 'b' },
    { type: 'text.delta', messageId: randomUUID(), text: 'other-message' },
    { type: 'thinking.delta', messageId, text: '思考' },
    { type: 'thinking.delta', messageId, text: '内容' },
    { type: 'tool.input.delta', toolId: 'one', text: '{' },
    { type: 'tool.input.delta', toolId: 'one', text: '}' },
    { type: 'tool.input.delta', toolId: 'two', text: '{}' },
    { type: 'tool.output', toolId: 'one', stream: 'stdout', text: 'out' },
    { type: 'tool.output', toolId: 'one', stream: 'stderr', text: 'err' },
  ];
  for (const payload of payloads) f.store.append(session.id, runId, payload);
  // A new library has nothing to merge and nothing to set aside.
  assert.deepEqual(readdirSync(f.directory).includes('backups'), false);
  const store = reopenAsOld(f.made);
  const events = store.snapshot(session.id).events;
  assert.deepEqual(
    events.map((event) => event.sequence),
    [2, 3, 5, 7, 8, 9, 10],
  );
  assert.equal(events[0].payload.type === 'text.delta' && events[0].payload.text, 'ab');
  assert.equal(events[2].payload.type === 'thinking.delta' && events[2].payload.text, '思考内容');
  assert.equal(events[3].payload.type === 'tool.input.delta' && events[3].payload.text, '{}');
  assert.equal(store.history(session.id, randomUUID()).hasEarlier, false);

  const [backup, ...others] = readdirSync(join(f.directory, 'backups'));
  assert.equal(others.length, 0);
  const files = readdirSync(join(f.directory, 'backups', backup));
  const copy = files.find((file) => file.endsWith('.sqlite'))!;
  assert.deepEqual(files.sort(), ['README.txt', copy].sort());
  assert.ok(
    readFileSync(join(f.directory, 'backups', backup, 'README.txt'), 'utf8').includes(copy),
  );
  const original = new DatabaseSync(join(f.directory, 'backups', backup, copy));
  assert.equal(original.prepare('SELECT COUNT(*) AS count FROM events').get()!.count, 10);
  original.close();

  // It is done once.
  store.close();
  const again = (f.made.store = new SessionStore(f.directory));
  assert.equal(readdirSync(join(f.directory, 'backups')).length, 1);
  assert.equal(again.snapshot(session.id).events.length, 7);
});

test('legacy UTF-8 JSON is imported exactly once, kept intact and not resurrected after deletion', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-import-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const id = randomUUID(),
    now = new Date().toISOString();
  const record = {
    session: {
      id,
      title: '旧记录',
      projectPath: 'D:\\中文',
      createdAt: now,
      updatedAt: now,
      activeRun: null,
    },
    events: [],
    createRequestId: randomUUID(),
  };
  const path = join(directory, `${id}.json`);
  const original = JSON.stringify(record);
  writeFileSync(path, original, 'utf8');
  const first = new SessionStore(directory);
  assert.equal(first.get(id).session.permissionMode, 'auto');
  first.delete(id);
  first.close();
  const second = new SessionStore(directory);
  assert.equal(second.list().length, 0);
  assert.equal(readFileSync(path, 'utf8'), original);
  second.close();
});

test('a confirmed runtime mode is persisted for reconnects and the next run without weakening configure', (t) => {
  const f = fixture(t);
  const id = f.session.id;
  const runId = randomUUID();
  f.store.configure(id, 'plan');
  f.store.append(id, runId, { type: 'run.status', status: 'running', connectionId: randomUUID() });
  assert.throws(() => f.store.configure(id, 'auto'), /请先结束当前运行/);
  f.store.append(id, runId, {
    type: 'native.session',
    nativeSessionId: id,
    model: 'test',
    version: '2.1.321',
    requestedPermissionMode: 'plan',
    permissionMode: 'default',
  });
  // Startup mismatch remains a report, not a change to the user's requested mode.
  assert.equal(f.store.get(id).session.permissionMode, 'plan');
  f.store.append(id, runId, { type: 'native.permission', permissionMode: 'acceptEdits' });
  assert.equal(f.store.snapshot(id).session.permissionMode, 'acceptEdits');
  f.store.close();
  f.made.store = new SessionStore(f.directory);
  assert.equal(f.made.store.get(id).session.permissionMode, 'acceptEdits');
  assert.equal(f.made.store.get(id).session.activeRun, null);
});

test('reading the native state of a session leaves its time of last use alone', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-08T12:00:00Z') });
  const { store, directory, session } = fixture(t);
  const runId = randomUUID();
  store.append(session.id, runId, {
    type: 'message.user',
    messageId: randomUUID(),
    text: 'hello',
    scenario: 'chat',
  });
  const used = store.get(session.id).session.updatedAt;
  t.mock.timers.tick(1000);
  const reading: EventPayload = {
    type: 'native.metrics',
    context: null,
    usage: null,
    rateLimits: null,
  };
  store.append(session.id, randomUUID(), reading);
  assert.equal(store.get(session.id).session.updatedAt, used);

  // A store written before: the look had been taken for use, and is put back once.
  store.append(session.id, randomUUID(), reading);
  const moved = { ...store.get(session.id).session, updatedAt: '2030-01-01T00:00:00.000Z' };
  store.database
    .prepare('UPDATE events SET data = json_set(data, ?, ?) WHERE session_id = ? AND sequence = 3')
    .run('$.createdAt', moved.updatedAt, session.id);
  store.database
    .prepare('UPDATE sessions SET metadata = ? WHERE id = ?')
    .run(JSON.stringify(moved), session.id);
  store.database.exec("DELETE FROM migrations WHERE name = 'updated-at-activity'");
  const events = store.database.prepare('SELECT data FROM events ORDER BY sequence').all();
  const reopened = new SessionStore(directory);
  const restored = reopened.get(session.id).session.updatedAt;
  assert.deepEqual(
    reopened.database.prepare('SELECT data FROM events ORDER BY sequence').all(),
    events,
  );
  reopened.append(session.id, randomUUID(), {
    type: 'native.capabilities',
    models: [],
    commands: [],
    account: {},
  });
  assert.equal(reopened.get(session.id).session.updatedAt, used);
  reopened.append(session.id, randomUUID(), {
    type: 'message.user',
    messageId: randomUUID(),
    text: 'new activity',
    scenario: 'chat',
  });
  assert.notEqual(reopened.get(session.id).session.updatedAt, used);
  reopened.close();
  assert.equal(restored, used);
});
