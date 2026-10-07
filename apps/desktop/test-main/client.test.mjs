import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { ProxyClient } from '../src/client.ts';
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

test('terminal frames bypass conversation caches and are never stored as display history', (t) => {
  const { client, socket, sessions } = fixture(t);
  const terminalId = randomUUID();
  const received = [];
  const unsubscribe = client.onTerminal((message) => received.push(message));
  socket.message({ type: 'terminal.opened', sessionId: sessions[0].id, terminalId });
  socket.message({
    type: 'terminal.data',
    sessionId: sessions[0].id,
    terminalId,
    data: 'native output',
    bytes: 13,
  });
  assert.equal(received.length, 2);
  assert.deepEqual(client.state.events, {});
  client.terminalControl({
    type: 'terminal.ack',
    sessionId: sessions[0].id,
    terminalId,
    bytes: 13,
  });
  assert.equal(socket.sent.at(-1).type, 'terminal.ack');
  unsubscribe();
  socket.message({ type: 'terminal.closed', sessionId: sessions[0].id, terminalId, exitCode: 0 });
  assert.equal(received.length, 2);
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
