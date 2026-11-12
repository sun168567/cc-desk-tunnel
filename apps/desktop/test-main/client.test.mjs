import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { ProxyClient, RequestInterruptedError } from '../src/client.ts';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { conversation, transcript } from '../src/transcript.ts';
import { describe, duration, summarize } from '../src/activity.ts';
import {
  describeSchedule,
  formatTasks,
  nextRun,
  parseTasks,
  taskMessage,
} from '../src/schedules.ts';

function fixture(t) {
  const Original = globalThis.WebSocket;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() {
      Socket.current = this;
    }
    send(raw) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.onclose?.();
    }
    message(message) {
      this.onmessage({ data: JSON.stringify(message) });
    }
  }
  globalThis.WebSocket = Socket;
  const client = new ProxyClient();
  client.connect('ws://127.0.0.1:1/ws', 'test-token-with-enough-characters');
  const socket = Socket.current;
  const now = new Date().toISOString();
  const sessions = Array.from({ length: 6 }, (_, index) => ({
    id: randomUUID(),
    title: `session-${index}`,
    projectPath: 'D:\\project',
    permissionMode: 'auto',
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  }));
  socket.message({
    type: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    version: '0.0.1',
    connectionId: randomUUID(),
    adapter: 'simulation',
    sessions,
  });
  t.after(() => {
    client.disconnect();
    globalThis.WebSocket = Original;
  });
  function snapshot(session, events, extra = {}) {
    const request = socket.sent.at(-1);
    socket.message({
      type: 'session.snapshot',
      requestId: request.requestId,
      session,
      events,
      mode: 'replace',
      firstSequence: events[0]?.sequence ?? 0,
      lastSequence: events.at(-1)?.sequence ?? 0,
      hasEarlier: false,
      ...extra,
    });
    socket.message({
      type: 'response',
      requestId: request.requestId,
      ok: true,
      sessionId: session.id,
    });
  }
  return { client, socket, sessions, snapshot };
}
function event(sessionId, sequence, text = 'text') {
  return {
    sessionId,
    sequence,
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    payload: { type: 'text.delta', messageId: randomUUID(), text },
  };
}

test('local history progress follows the pending page, resets for an earlier page and ignores stale notices', async (t) => {
  const { client, socket, sessions, snapshot } = fixture(t);
  // This fake socket stands in for the authenticated loopback bridge, whose byte notices are client-only.
  client.credentials.bridge = async () => 'ws://127.0.0.1:1/ws';
  const session = sessions[0];
  client.select(session.id);
  const first = socket.sent.at(-1);
  const progress = (received, extra = {}) =>
    socket.message({
      type: 'client.history.progress',
      sessionId: session.id,
      requestId: socket.sent.at(-1).requestId,
      received,
      processing: false,
      ...extra,
    });
  assert.equal(client.state.history[session.id].read.received, 0);
  progress(65536, { sessionId: sessions[1].id });
  assert.equal(client.state.history[session.id].read.received, 0);
  progress(65536);
  assert.equal(client.state.history[session.id].read.received, 65536);
  assert.equal(client.state.history[session.id].read.phase, 'waiting');
  assert.equal(client.state.events[session.id], undefined);
  progress(65536, { processing: true });
  assert.equal(client.state.history[session.id].read.phase, 'processing');
  snapshot(session, [event(session.id, 100)], { hasEarlier: true });
  assert.equal(client.state.history[session.id].read.phase, 'complete');
  assert.equal(client.state.history[session.id].read.content, true);

  const loading = client.loadEarlier(session.id);
  assert.equal(client.state.history[session.id].read.received, 0);
  progress(999999, { requestId: first.requestId });
  assert.equal(client.state.history[session.id].read.received, 0);
  progress(1024 * 1024);
  progress(8); // An older notice cannot make a counter go backwards.
  assert.equal(client.state.history[session.id].read.received, 1024 * 1024);
  snapshot(session, [event(session.id, 50)], { mode: 'prepend' });
  await loading;
  assert.equal(client.state.history[session.id].read.content, true);
  assert.equal(client.state.events[session.id].length, 2);
  progress(9999999);
  assert.equal(client.state.history[session.id].read.received, 1024 * 1024);
  assert.deepEqual(
    socket.sent.map((item) => item.type),
    ['session.subscribe', 'session.history'],
  );
});

test('a superseded read cannot finish or fail the progress of a newer read of the same session', async (t) => {
  const { client, socket, sessions, snapshot } = fixture(t);
  client.credentials.bridge = async () => 'ws://127.0.0.1:1/ws';
  const session = sessions[0];
  client.select(session.id);
  const old = socket.sent.at(-1);
  client.select(session.id);
  const current = socket.sent.at(-1);
  socket.message({
    type: 'session.snapshot',
    requestId: old.requestId,
    session,
    events: [event(session.id, 1)],
    mode: 'replace',
    firstSequence: 1,
    lastSequence: 1,
    hasEarlier: false,
  });
  assert.equal(client.state.events[session.id], undefined);
  assert.equal(client.state.history[session.id].loading, true);
  socket.message({
    type: 'response',
    requestId: old.requestId,
    ok: false,
    message: 'old read failed',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.state.history[session.id].loading, true);
  assert.equal(client.state.error, null);
  socket.message({
    type: 'client.history.progress',
    requestId: current.requestId,
    sessionId: session.id,
    received: 4096,
  });
  assert.equal(client.state.history[session.id].read.received, 4096);
  snapshot(session, [event(session.id, 100)]);
  assert.equal(client.state.history[session.id].read.phase, 'complete');
  assert.equal(client.state.events[session.id][0].sequence, 100);
});

for (const end of ['timeout', 'disconnect', 'rejection']) {
  test(`history progress keeps the last byte count after ${end}, without claiming completion`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client, socket, sessions } = fixture(t);
    client.credentials.bridge = async () => 'ws://127.0.0.1:1/ws';
    const session = sessions[0];
    client.select(session.id);
    const request = socket.sent.at(-1);
    const notice = {
      type: 'client.history.progress',
      sessionId: session.id,
      requestId: request.requestId,
      received: 16384,
    };
    socket.message(notice);
    if (end === 'timeout') t.mock.timers.tick(60_000);
    else if (end === 'disconnect') socket.close();
    else
      socket.message({
        type: 'response',
        requestId: request.requestId,
        ok: false,
        message: 'test read rejected',
      });
    await new Promise((resolve) => setImmediate(resolve));
    const read = client.state.history[session.id].read;
    assert.equal(read.phase, 'failed');
    assert.equal(read.received, 16384);
    assert.ok(read.finishedAt >= read.startedAt);
    assert.equal(client.state.history[session.id].loading, false);
    assert.equal(client.state.events[session.id], undefined);
    assert.equal(socket.sent.length, 1);
    if (end !== 'disconnect') {
      client.select(session.id);
      socket.message({ ...notice, received: 99999 });
      assert.equal(client.state.history[session.id].read.received, 0);
      assert.equal(client.state.history[session.id].read.phase, 'waiting');
    }
  });
}

test('a server connection cannot supply desktop-only history progress notices', (t) => {
  const { client, socket, sessions } = fixture(t);
  client.select(sessions[0].id);
  socket.message({
    type: 'client.history.progress',
    requestId: socket.sent.at(-1).requestId,
    sessionId: sessions[0].id,
    received: 4096,
  });
  assert.equal(client.state.status, 'disconnected');
  assert.match(client.state.error, /服务消息格式不兼容/);
});

for (const type of [
  'session.status',
  'session.history',
  'account.status',
  'usage.query',
  'session.stats',
  'settings.get',
  'message.send',
  'settings.update',
]) {
  test(`an interrupted ${type} reply keeps its operation kind and is never replayed`, async (t) => {
    const { client, socket, sessions } = fixture(t);
    const result = client.request({ type, sessionId: sessions[0].id }).catch((error) => error);
    socket.close();
    const error = await result;
    assert.ok(error instanceof RequestInterruptedError);
    const readOnly = !['message.send', 'settings.update'].includes(type);
    assert.equal(error.readOnly, readOnly);
    assert.match(error.describe(false), /连接中断/);
    assert.match(error.describe(true), /连接已恢复/);
    if (readOnly) {
      assert.match(error.describe(true), /读取未完成/);
      assert.doesNotMatch(error.describe(true), /提交|任务可能/);
    } else {
      assert.match(error.describe(true), /上次请求.*确认.*未收到/);
      assert.match(error.describe(true), /不会自动重发/);
    }
    assert.equal(client.pending.size, 0);
    assert.equal(socket.sent.filter((command) => command.type === type).length, 1);
  });
}

test('the connected computers are what the service last said, and unknown while the connection is down', (t) => {
  const { client, socket } = fixture(t);
  const desk = { id: randomUUID(), name: '台式机', ready: true };
  const laptop = { id: randomUUID(), name: '笔记本', platform: 'darwin', ready: false };
  socket.message({ type: 'devices', devices: [desk, laptop] });
  assert.deepEqual(client.state.devices, [desk, laptop]);
  socket.message({ type: 'devices', devices: [desk] });
  assert.deepEqual(client.state.devices, [desk]);
  socket.close();
  assert.equal(client.state.status, 'reconnecting');
  assert.deepEqual(client.state.devices, []);
});

test('login only receives the session directory; content is loaded when selected and cache is bounded', (t) => {
  const { client, socket, sessions, snapshot } = fixture(t);
  assert.equal(client.state.selectedId, null);
  assert.deepEqual(client.state.events, {});
  assert.equal(socket.sent.length, 0);
  for (const session of sessions) {
    client.select(session.id);
    assert.equal(socket.sent.at(-1).type, 'session.subscribe');
    assert.equal(client.state.history[session.id].loading, true);
    snapshot(session, [event(session.id, 1)]);
  }
  assert.equal(Object.keys(client.state.events).length, 4);
  assert.equal(client.state.events[sessions[0].id], undefined);
  client.select(sessions[5].id);
  assert.equal(socket.sent.at(-1).afterSequence, 1);
  snapshot(sessions[5], [], { mode: 'append', lastSequence: 1 });
  assert.equal(client.state.events[sessions[5].id].length, 1);
});

test('stream notifications are batched and pending events cannot cross a disconnect or deletion', async (t) => {
  const { client, socket, sessions, snapshot } = fixture(t);
  const session = sessions[0];
  client.select(session.id);
  snapshot(session, []);
  let notifications = 0;
  client.subscribe(() => notifications++);
  for (let sequence = 1; sequence <= 200; sequence++)
    socket.message({ type: 'session.event', event: event(session.id, sequence) });
  assert.equal(notifications, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(notifications, 1);
  assert.equal(client.state.events[session.id].length, 200);
  socket.message({ type: 'session.event', event: event(session.id, 201) });
  socket.message({ type: 'session.deleted', sessionId: session.id });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.state.events[session.id], undefined);
});

test('output still arriving is kept apart from the history until the event that records it', async (t) => {
  const { client, socket, sessions, snapshot } = fixture(t);
  const session = sessions[0];
  client.select(session.id);
  snapshot(session, [event(session.id, 1)]);
  const runId = randomUUID(),
    messageId = randomUUID();
  const piece = (text, id = messageId) =>
    socket.message({
      type: 'session.fragment',
      sessionId: session.id,
      runId,
      payload: { type: 'text.delta', messageId: id, text },
    });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  piece('你');
  piece('好');
  await settle();
  assert.equal(client.state.live[session.id].payload.text, '你好');
  assert.equal(client.state.events[session.id].length, 1);
  assert.equal(client.state.history[session.id].lastSequence, 1);

  // The recorded event takes its place; what comes after it starts anew.
  const recorded = { ...event(session.id, 2, '你好'), runId };
  socket.message({ type: 'session.event', event: recorded });
  piece('下一段', randomUUID());
  await settle();
  assert.equal(client.state.events[session.id].length, 2);
  assert.equal(client.state.live[session.id].payload.text, '下一段');

  // After a reconnect the history says where it ends and the service sends the rest again, whole.
  client.select(session.id);
  snapshot(session, [], { mode: 'append', lastSequence: 2 });
  assert.equal(client.state.live[session.id], undefined);
  piece('下一段，接着', randomUUID());
  await settle();
  assert.equal(client.state.live[session.id].payload.text, '下一段，接着');
  socket.message({ type: 'session.deleted', sessionId: session.id });
  assert.equal(client.state.live[session.id], undefined);
});

test('earlier pages prepend in one batch while preserving the newest reconnect cursor', async (t) => {
  const { client, socket, sessions, snapshot } = fixture(t);
  const session = sessions[0];
  client.select(session.id);
  snapshot(session, [event(session.id, 100)], {
    firstSequence: 51,
    lastSequence: 100,
    hasEarlier: true,
  });
  const loading = client.loadEarlier(session.id);
  assert.equal(socket.sent.at(-1).type, 'session.history');
  assert.equal(socket.sent.at(-1).beforeSequence, 51);
  snapshot(session, [event(session.id, 50)], {
    mode: 'prepend',
    firstSequence: 1,
    lastSequence: 50,
    hasEarlier: false,
  });
  await loading;
  assert.equal(client.state.history[session.id].firstSequence, 1);
  assert.equal(client.state.history[session.id].lastSequence, 100);
  assert.equal(client.state.history[session.id].hasEarlier, false);
  assert.deepEqual(
    client.state.events[session.id].map((event) => event.sequence),
    [50, 100],
  );
});

test('one upward read continues through status-only pages until a visible transcript arrives', async (t) => {
  const { client, socket, sessions, snapshot } = fixture(t);
  const session = sessions[0];
  client.select(session.id);
  snapshot(session, [event(session.id, 100)], { hasEarlier: true });
  const loading = client.loadEarlier(session.id);
  for (const sequence of [80, 60]) {
    snapshot(session, statusEvents(session.id, sequence), { mode: 'prepend', hasEarlier: true });
    assert.equal(client.state.history[session.id].loadingEarlier, true);
    assert.equal(client.state.history[session.id].read.phase, 'waiting');
    await client.loadEarlier(session.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.sent.at(-1).beforeSequence, sequence);
  }
  snapshot(session, [event(session.id, 40, 'earlier answer')], {
    mode: 'prepend',
    hasEarlier: true,
  });
  await loading;
  assert.equal(client.state.history[session.id].loadingEarlier, false);
  assert.equal(client.state.history[session.id].read.content, true);
  assert.equal(client.state.history[session.id].read.phase, 'complete');
  assert.equal(client.state.history[session.id].lastSequence, 100);
  assert.deepEqual(
    socket.sent
      .filter((command) => command.type === 'session.history')
      .map((command) => command.beforeSequence),
    [100, 80, 60],
  );
  assert.deepEqual(
    transcript(client.state.events[session.id]).map((item) => item.text),
    ['earlier answer', 'text'],
  );
});

test('a failed read after a status-only page keeps its cursor and allows manual retry', async (t) => {
  const { client, socket, sessions, snapshot } = fixture(t);
  const session = sessions[0];
  client.select(session.id);
  snapshot(session, [event(session.id, 100)], { hasEarlier: true });
  const loading = client.loadEarlier(session.id);
  const rejected = assert.rejects(loading, /读取失败/);
  snapshot(session, statusEvents(session.id, 80), { mode: 'prepend', hasEarlier: true });
  await new Promise((resolve) => setImmediate(resolve));
  socket.message({
    type: 'response',
    requestId: socket.sent.at(-1).requestId,
    ok: false,
    code: 'internal_error',
    message: '读取失败',
  });
  await rejected;
  assert.equal(client.state.history[session.id].loadingEarlier, false);
  assert.equal(client.state.history[session.id].read.phase, 'failed');
  assert.equal(client.state.history[session.id].firstSequence, 80);
  const retry = client.loadEarlier(session.id);
  assert.equal(socket.sent.at(-1).beforeSequence, 80);
  snapshot(session, [event(session.id, 40)], { mode: 'prepend' });
  await retry;
  assert.equal(client.state.history[session.id].read.phase, 'complete');
});

for (const end of ['beginning', 'unchanged cursor', 'another selected session']) {
  test(`status-only history stops at ${end}`, async (t) => {
    const { client, socket, sessions, snapshot } = fixture(t);
    const session = sessions[0];
    client.select(session.id);
    snapshot(session, [event(session.id, 100)], { hasEarlier: true });
    const loading = client.loadEarlier(session.id);
    snapshot(session, statusEvents(session.id, end === 'unchanged cursor' ? 100 : 80), {
      mode: 'prepend',
      hasEarlier: end !== 'beginning',
    });
    if (end === 'another selected session') client.select(sessions[1].id);
    await loading;
    assert.equal(client.state.history[session.id].loadingEarlier, false);
    assert.equal(client.state.history[session.id].read.content, false);
    assert.equal(socket.sent.filter((command) => command.type === 'session.history').length, 1);
  });
}

function statusEvents(sessionId, sequence) {
  const runId = randomUUID();
  return [
    { type: 'native.capabilities', models: [], account: {}, commands: [] },
    { type: 'native.metrics', context: null, usage: null, rateLimits: null },
  ].map((payload, index) => ({ ...event(sessionId, sequence + index), runId, payload }));
}

for (const ok of [true, false]) {
  test(`earlier history waits for the same session's status read to ${ok ? 'finish' : 'fail'}, then sends once`, async (t) => {
    const { client, socket, sessions, snapshot } = fixture(t);
    const session = sessions[0];
    client.select(session.id);
    snapshot(session, [event(session.id, 100)], { hasEarlier: true });
    const status = client
      .request({ type: 'session.status', sessionId: session.id })
      .catch((error) => error);
    const requestId = socket.sent.at(-1).requestId;
    const loading = client.loadEarlier(session.id);
    await client.loadEarlier(session.id);
    assert.equal(client.state.history[session.id].loadingEarlier, true);
    assert.equal(client.state.history[session.id].waitingForStatus, true);
    assert.equal(client.state.history[session.id].read, undefined);
    assert.equal(socket.sent.filter((command) => command.type === 'session.history').length, 0);

    socket.message({
      type: 'response',
      requestId,
      ok,
      message: ok ? undefined : 'native status failed',
    });
    await status;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.state.history[session.id].waitingForStatus, false);
    assert.equal(client.state.history[session.id].read.phase, 'waiting');
    assert.equal(socket.sent.filter((command) => command.type === 'session.history').length, 1);
    assert.equal(socket.sent.at(-1).beforeSequence, 100);
    snapshot(session, [event(session.id, 50)], { mode: 'prepend' });
    await loading;
    assert.deepEqual(
      client.state.events[session.id].map((item) => item.sequence),
      [50, 100],
    );
  });
}

test('a disconnected status read cancels the waiting history without sending it after disconnect', async (t) => {
  const { client, socket, sessions, snapshot } = fixture(t);
  const session = sessions[0];
  client.select(session.id);
  snapshot(session, [event(session.id, 100)], { hasEarlier: true });
  const status = client
    .request({ type: 'session.status', sessionId: session.id })
    .catch((error) => error);
  const loading = client.loadEarlier(session.id).catch((error) => error);
  socket.close();
  await status;
  assert.match((await loading).message, /服务未连接/);
  assert.equal(socket.sent.filter((command) => command.type === 'session.history').length, 0);
  assert.equal(client.state.history[session.id].loadingEarlier, false);
  assert.equal(client.state.history[session.id].waitingForStatus, false);
});

for (const type of ['session.subscribe', 'session.history']) {
  test(`${type} accepts a history page after twelve seconds without resending`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client, socket, sessions, snapshot } = fixture(t);
    const session = sessions[0];
    client.select(session.id);
    let loading;
    if (type === 'session.history') {
      snapshot(session, [event(session.id, 100)], { hasEarlier: true });
      loading = client.loadEarlier(session.id);
    }
    assert.equal(socket.sent.at(-1).type, type);
    const sent = socket.sent.length;

    t.mock.timers.tick(12_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.state.status, 'connected');
    assert.equal(client.state.error, null);
    assert.equal(client.pending.size, 1);
    snapshot(session, [event(session.id, 50)], {
      mode: type === 'session.history' ? 'prepend' : 'replace',
    });
    await loading;

    assert.deepEqual(
      client.state.events[session.id].map((item) => item.sequence),
      type === 'session.history' ? [50, 100] : [50],
    );
    assert.equal(client.state.history[session.id].loading, false);
    assert.equal(client.state.history[session.id].loadingEarlier, false);
    assert.equal(client.pending.size, 0);
    assert.equal(socket.sent.length, sent);
  });

  test(`${type} times out after a minute, keeps shown history and rejects the expired page`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client, socket, sessions, snapshot } = fixture(t);
    const session = sessions[0];
    client.select(session.id);
    const shown = event(session.id, 100);
    snapshot(session, [shown], { hasEarlier: true });
    let failure;
    if (type === 'session.history')
      failure = client.loadEarlier(session.id).catch((error) => error);
    else client.select(session.id);
    const expired = socket.sent.at(-1);
    const sent = socket.sent.length;

    t.mock.timers.tick(59_999);
    assert.equal(client.pending.has(expired.requestId), true);
    t.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    const message = type === 'session.history' ? (await failure).message : client.state.error;
    assert.equal(message, '历史读取超时（连续 60 秒无进展）；请重试。');
    assert.equal(client.state.status, 'connected');
    assert.equal(client.state.history[session.id].loading, false);
    assert.equal(client.state.history[session.id].loadingEarlier, false);
    assert.deepEqual(client.state.events[session.id], [shown]);
    assert.equal(client.pending.size, 0);
    assert.equal(socket.sent.length, sent);

    // Even while a new read is pending, the expired page cannot replace what is shown.
    let retry;
    if (type === 'session.history') retry = client.loadEarlier(session.id);
    else client.select(session.id);
    socket.message({
      type: 'session.snapshot',
      requestId: expired.requestId,
      session,
      events: [event(session.id, 50)],
      mode: 'replace',
      firstSequence: 50,
      lastSequence: 50,
      hasEarlier: false,
    });
    socket.message({ type: 'response', requestId: expired.requestId, ok: true });
    assert.deepEqual(client.state.events[session.id], [shown]);
    assert.equal(client.pending.size, 1);
    snapshot(session, [event(session.id, type === 'session.history' ? 50 : 101)], {
      mode: type === 'session.history' ? 'prepend' : 'append',
    });
    await retry;
    assert.equal(client.pending.size, 0);
    assert.equal(client.state.events[session.id].length, 2);
  });
}

for (const type of ['session.subscribe', 'session.history']) {
  test(`${type} continues beyond a minute while its own history payload advances`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client, socket, sessions, snapshot } = fixture(t);
    client.credentials.bridge = async () => 'ws://127.0.0.1:1/ws';
    const session = sessions[0];
    client.select(session.id);
    let loading;
    if (type === 'session.history') {
      snapshot(session, [event(session.id, 100)], { hasEarlier: true });
      loading = client.loadEarlier(session.id);
    }
    const request = socket.sent.at(-1);
    for (let part = 1; part <= 3; part++) {
      t.mock.timers.tick(55_000);
      socket.message({
        type: 'client.history.progress',
        requestId: request.requestId,
        sessionId: session.id,
        received: part * 16384,
        historyReceived: part * 16000,
      });
      assert.equal(client.pending.has(request.requestId), true);
      assert.equal(client.state.error, null);
    }
    snapshot(session, [event(session.id, 50)], {
      mode: type === 'session.history' ? 'prepend' : 'replace',
    });
    await loading;
    assert.equal(client.state.history[session.id].read.phase, 'complete');
    assert.equal(socket.sent.filter((command) => command.type === type).length, 1);
  });
}

test('history times out 60 seconds after its last payload advance despite other connection traffic', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, socket, sessions } = fixture(t);
  client.credentials.bridge = async () => 'ws://127.0.0.1:1/ws';
  const session = sessions[0];
  client.select(session.id);
  const requestId = socket.sent.at(-1).requestId;
  t.mock.timers.tick(55_000);
  socket.message({
    type: 'client.history.progress',
    requestId,
    sessionId: session.id,
    received: 16384,
    historyReceived: 16000,
  });
  for (let part = 1; part <= 5; part++) {
    t.mock.timers.tick(10_000);
    socket.message({ type: 'session.updated', session: { ...session, title: `status ${part}` } });
    socket.message({
      type: 'client.history.progress',
      requestId,
      sessionId: session.id,
      received: 16384 + part * 1024,
      historyReceived: 16000,
    });
    assert.equal(client.pending.has(requestId), true);
  }
  t.mock.timers.tick(9999);
  assert.equal(client.pending.has(requestId), true);
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.state.history[session.id].read.phase, 'failed');
  assert.match(client.state.error, /连续 60 秒无进展/);
  assert.equal(client.state.status, 'connected');
  assert.equal(socket.sent.length, 1);
});

test('other commands keep their existing deadlines and timeout warning', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, sessions } = fixture(t);
  for (const [type, milliseconds] of [
    ['message.send', 10_000],
    ['session.status', 30_000],
    ['account.status', 30_000],
    ['service.update.check', 30_000],
  ]) {
    const result = client.request({ type, sessionId: sessions[0].id }).catch((error) => error);
    t.mock.timers.tick(milliseconds - 1);
    assert.equal(client.pending.size, 1);
    t.mock.timers.tick(1);
    assert.equal((await result).message, '请求超时；请查看历史确认结果，未自动重发。');
    assert.equal(client.pending.size, 0);
  }
});

test('late responses cannot restore an evicted session or seed a cursor from unseen history', (t) => {
  const { client, socket, sessions, snapshot } = fixture(t);
  client.select(sessions[0].id);
  const delayed = socket.sent.at(-1);
  for (const session of sessions.slice(1)) {
    client.select(session.id);
    snapshot(session, []);
  }
  socket.message({
    type: 'session.snapshot',
    requestId: delayed.requestId,
    session: sessions[0],
    events: [event(sessions[0].id, 100)],
    mode: 'replace',
    firstSequence: 1,
    lastSequence: 100,
    hasEarlier: false,
  });
  socket.message({ type: 'response', requestId: delayed.requestId, ok: true });
  socket.message({ type: 'session.event', event: event(sessions[0].id, 101) });
  assert.equal(client.state.events[sessions[0].id], undefined);
  client.select(sessions[0].id);
  assert.equal(socket.sent.at(-1).afterSequence, 0);
  snapshot(sessions[0], []);
});

test('an event of a session not shown, as the quota of a terminal sent to all, leaves its cached history to be fetched', async (t) => {
  const { client, socket, sessions, snapshot } = fixture(t);
  const [held, shown] = sessions;
  client.select(held.id);
  snapshot(held, [event(held.id, 1)]);
  client.select(shown.id);
  snapshot(shown, []);
  // While another session is shown, the terminal's turn is recorded (2) and its quota sent to every connection (3).
  socket.message({
    type: 'session.event',
    event: {
      ...event(held.id, 3),
      payload: { type: 'native.metrics', context: null, usage: null, rateLimits: null },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    client.state.events[held.id].map((item) => item.sequence),
    [1],
  );
  client.select(held.id);
  assert.equal(socket.sent.at(-1).afterSequence, 1);
  snapshot(held, [event(held.id, 2), event(held.id, 3)], { mode: 'append' });
  assert.deepEqual(
    client.state.events[held.id].map((item) => item.sequence),
    [1, 2, 3],
  );
});
test('native input receipts update the existing user row without duplicating messages', () => {
  const sessionId = randomUUID(),
    runId = randomUUID(),
    messageId = randomUUID();
  const events = [
    { type: 'message.user', messageId, text: '补充', scenario: 'chat' },
    { type: 'message.delivery', messageId, status: 'submitted' },
    { type: 'message.delivery', messageId, status: 'queued' },
    { type: 'message.delivery', messageId, status: 'received' },
  ].map((payload, index) => ({
    sessionId,
    runId,
    payload,
    sequence: index + 1,
    createdAt: new Date().toISOString(),
  }));
  assert.equal(transcript(events).length, 1);
  assert.equal(transcript(events)[0].delivery, '原生已接收');
  assert.equal(transcript(events.slice(0, 3))[0].delivery, '等待原生处理');
});

test('account telemetry can refresh without selecting or loading a conversation', (t) => {
  const { client, socket, sessions } = fixture(t);
  const capabilities = {
    type: 'native.capabilities',
    account: { subscriptionType: 'pro' },
    models: [],
    commands: [],
  };
  socket.message({
    type: 'session.event',
    event: {
      ...event(sessions[0].id, 1),
      payload: capabilities,
    },
  });
  assert.deepEqual(client.state.capabilities, capabilities);
  assert.deepEqual(client.state.events, {});
  assert.equal(client.state.selectedId, null);
  assert.equal(socket.sent.length, 0);
});

test('conversation folds a finished turn into question, activity and answer', () => {
  const sessionId = randomUUID();
  const runId = randomUUID();
  const [question, first, final, next] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  let sequence = 0;
  const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
  const event = (seconds, payload, run = runId) => ({
    sessionId,
    runId: run,
    sequence: ++sequence,
    createdAt: at(seconds),
    payload,
  });
  const edit = JSON.stringify({
    file_path: 'D:\\work\\app.py',
    old_string: 'a',
    new_string: 'a\nb\nc',
  });
  const events = [
    event(0, { type: 'message.user', messageId: question, text: '改一下', scenario: 'chat' }),
    event(1, { type: 'text.delta', messageId: first, text: '先看文件。' }),
    event(2, {
      type: 'tool.requested',
      toolId: 't1',
      name: 'Read',
      input: '{"file_path":"/x/app.py"}',
      target: 'Linux',
    }),
    event(2, { type: 'tool.requested', toolId: 't2', name: 'Edit', input: edit, target: 'Linux' }),
    event(3, {
      type: 'tool.result',
      toolId: 't1',
      status: 'completed',
      output: 'ok',
      exitCode: null,
    }),
  ];
  let [turn] = conversation(events);
  assert.equal(turn.endedAt, undefined);
  assert.deepEqual(
    turn.steps.map((step) => step.kind),
    ['assistant', 'work'],
  );
  assert.equal(summarize(turn.steps[1], true, true).label, '正在编辑文件');
  assert.deepEqual(
    (({ verb, subject, added, removed }) => ({ verb, subject, added, removed }))(
      describe(turn.steps[1].items[1], true),
    ),
    { verb: '编辑', subject: 'app.py', added: 3, removed: 1 },
  );
  events.push(
    event(65, {
      type: 'tool.result',
      toolId: 't2',
      status: 'completed',
      output: 'ok',
      exitCode: null,
    }),
    event(66, { type: 'text.delta', messageId: final, text: '改好了。' }),
    event(67, { type: 'run.status', status: 'completed', connectionId: randomUUID() }),
    event(
      90,
      { type: 'message.user', messageId: next, text: '继续', scenario: 'chat' },
      randomUUID(),
    ),
  );
  const turns = conversation(events);
  [turn] = turns;
  assert.equal(turns.length, 2);
  assert.equal(turn.answer.text, '改好了。');
  assert.equal(turn.tools, 2);
  assert.equal(duration(turn.startedAt, turn.endedAt), '1 分 7 秒');
  assert.equal(summarize(turn.steps[1], false, false).label, '读取了 1 个文件，编辑了 1 个文件');
  assert.equal(turns[1].endedAt, undefined);
});

test('scheduled tasks: the file round-trips, bad tasks are named, and rules find their next time', () => {
  const task = {
    id: 'daily-report',
    name: '日报',
    enabled: true,
    prompt: '整理今天的提交',
    schedule: { type: 'weekly', days: [1, 5], time: '09:30' },
    target: { type: 'new', projectPath: 'D:\\项目' },
    model: null,
    effort: 'high',
  };
  const text = formatTasks([task]);
  assert.ok(JSON.parse(text).说明.length > 0);
  assert.deepEqual(parseTasks(text), { tasks: [task], problems: [] });
  // What Claude or an editor may leave behind: missing optional fields, a bad task beside a good one.
  const mixed = parseTasks(
    JSON.stringify({
      tasks: [
        { ...task, model: undefined, effort: undefined, enabled: undefined },
        { ...task, id: 'other', name: '坏时间', schedule: { type: 'daily', time: '9点' } },
        { ...task, name: '重复' },
        { ...task, id: 'fast', name: '太频繁', schedule: { type: 'interval', minutes: 1 } },
        null,
      ],
    }),
  );
  assert.deepEqual(mixed.tasks, [{ ...task, effort: null }]);
  assert.deepEqual(
    mixed.problems.map((problem) => problem.split('：')[0]),
    ['“坏时间”', '“重复”', '“太频繁”', '第 5 个任务'],
  );
  assert.ok(parseTasks('{ not json').broken);
  assert.ok(parseTasks('{}').broken);
  assert.deepEqual(parseTasks(''), { tasks: [], problems: [] });

  const local = (...parts) => new Date(...parts).getTime();
  // 2026-10-07 is a Wednesday.
  const wednesday = local(2026, 9, 7, 10, 0);
  assert.equal(nextRun({ type: 'daily', time: '10:30' }, wednesday), local(2026, 9, 7, 10, 30));
  assert.equal(nextRun({ type: 'daily', time: '10:00' }, wednesday), local(2026, 9, 8, 10, 0));
  assert.equal(nextRun(task.schedule, wednesday), local(2026, 9, 9, 9, 30));
  assert.equal(
    nextRun({ type: 'weekly', days: [3], time: '09:00' }, wednesday),
    local(2026, 9, 14, 9, 0),
  );
  assert.equal(
    nextRun({ type: 'weekly', days: [7], time: '23:59' }, wednesday),
    local(2026, 9, 11, 23, 59),
  );
  assert.equal(nextRun({ type: 'interval', minutes: 90 }, wednesday), local(2026, 9, 7, 11, 30));
  assert.equal(
    nextRun({ type: 'once', at: '2026-10-07T10:01' }, wednesday),
    local(2026, 9, 7, 10, 1),
  );
  assert.equal(nextRun({ type: 'once', at: '2026-10-07T10:00' }, wednesday), null);
  assert.equal(describeSchedule(task.schedule), '每周一、五 09:30');
  assert.equal(describeSchedule({ type: 'interval', minutes: 120 }), '每 2 小时');
  assert.equal(
    taskMessage(task, wednesday),
    '[定时任务「日报」· 计划时间 2026-10-07 10:00]\n\n整理今天的提交',
  );
});

test('a remote connection that breaks is made again through a new bridge, and only a refusal ends it', async (t) => {
  const Original = globalThis.WebSocket;
  const sockets = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    send(raw) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    message(message) {
      this.onmessage({ data: JSON.stringify(message) });
    }
  }
  globalThis.WebSocket = Socket;
  const client = new ProxyClient();
  t.after(() => {
    client.disconnect();
    globalThis.WebSocket = Original;
  });
  let bridges = 0;
  const device = { id: randomUUID(), name: 'this computer' };
  const now = new Date().toISOString();
  const session = {
    id: randomUUID(),
    title: 'kept',
    projectPath: 'D:\\project',
    device,
    permissionMode: 'auto',
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const ready = (socket) =>
    socket.message({
      type: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      version: '0.0.1',
      connectionId: randomUUID(),
      adapter: 'claude-code',
      sessions: [session],
    });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  const connect = () =>
    client.connect(
      'ws://127.0.0.1/ws',
      'test-token-with-enough-characters',
      device,
      true,
      async () => `ws://127.0.0.1:${9000 + ++bridges}/bridge`,
    );

  // Before it ever stood, a failure is shown and nothing is tried again.
  connect();
  await settle();
  sockets[0].message({ type: 'connection.error', code: 'connection_lost', message: '连不上' });
  assert.equal(client.state.status, 'disconnected');
  assert.equal(client.state.error, '连不上');

  connect();
  await settle();
  ready(sockets[1]);
  client.select(session.id);
  assert.equal(client.state.status, 'connected');
  sockets[1].message({ type: 'connection.error', code: 'connection_lost', message: '断了' });
  assert.equal(client.state.status, 'reconnecting');
  // What the window showed stays; the attempt waiting for its turn is made at once on request.
  assert.equal(client.state.selectedId, session.id);
  assert.equal(client.state.sessions.length, 1);
  client.retryNow();
  await settle();
  assert.equal(sockets.length, 3);
  assert.equal(sockets[2].url, 'ws://127.0.0.1:9003/bridge');
  ready(sockets[2]);
  assert.equal(client.state.status, 'connected');
  assert.equal(client.state.error, null);
  // The selected session is read on from where the window had it.
  assert.equal(sockets[2].sent.at(-1).type, 'session.subscribe');

  // A connection that just ends is a fault on the way too.
  sockets[2].close();
  assert.equal(client.state.status, 'reconnecting');
  client.retryNow();
  await settle();
  // The service refusing this client is not.
  sockets[3].message({ type: 'connection.error', code: 'unauthorized', message: '凭据不对' });
  assert.equal(client.state.status, 'disconnected');

  // Leaving on purpose is said to the service first.
  connect();
  await settle();
  ready(sockets[4]);
  client.disconnect();
  assert.equal(sockets[4].sent.at(-1).type, 'leave');
  assert.equal(bridges, 5);
});
