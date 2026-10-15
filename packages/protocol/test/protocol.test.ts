import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  PROTOCOL_VERSION,
  authSchema,
  commandSchema,
  eventSchema,
  sessionSchema,
  terminalControlSchema,
} from '../src/index.ts';

test('protocol validates UTF-8 text, IDs and bounded input', () => {
  const command = {
    type: 'message.send',
    requestId: randomUUID(),
    sessionId: randomUUID(),
    text: ' 检查 D:\\工作\\测试 ',
  };
  const parsed = commandSchema.parse(command);
  assert.equal(parsed.type, 'message.send');
  if (parsed.type === 'message.send') assert.equal(parsed.text, '检查 D:\\工作\\测试');
  assert.equal(commandSchema.safeParse({ ...command, text: ' ' }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, text: 'a'.repeat(16001) }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, sessionId: 'not-an-id' }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, token: 'unexpected' }).success, false);
});

test('authentication version and event ordering are explicit', () => {
  const auth = {
    type: 'auth',
    protocolVersion: PROTOCOL_VERSION,
    token: 'x'.repeat(32),
    deviceName: '开发机',
  };
  assert.equal(authSchema.safeParse(auth).success, true);
  // Another version still authenticates, so that the service can answer with how to upgrade.
  assert.equal(authSchema.safeParse({ ...auth, protocolVersion: 9999 }).success, true);
  assert.equal(authSchema.safeParse({ ...auth, protocolVersion: 0 }).success, false);
  const event = {
    sessionId: randomUUID(),
    runId: randomUUID(),
    sequence: 1,
    createdAt: new Date().toISOString(),
    payload: { type: 'run.status', status: 'running', connectionId: randomUUID() },
  };
  assert.equal(eventSchema.safeParse(event).success, true);
  assert.equal(eventSchema.safeParse({ ...event, sequence: 0 }).success, false);
});

test('terminal control frames are explicitly scoped and bounded without request caches', () => {
  const frame = {
    type: 'terminal.input',
    sessionId: randomUUID(),
    terminalId: randomUUID(),
    data: '中文\r',
  };
  assert.equal(terminalControlSchema.safeParse(frame).success, true);
  assert.equal(
    terminalControlSchema.safeParse({ ...frame, data: 'x'.repeat(8193) }).success,
    false,
  );
  assert.equal(
    terminalControlSchema.safeParse({ ...frame, requestId: randomUUID() }).success,
    false,
  );
  assert.equal(
    terminalControlSchema.safeParse({
      type: 'terminal.ack',
      sessionId: frame.sessionId,
      terminalId: frame.terminalId,
      bytes: -1,
    }).success,
    false,
  );
  assert.equal(
    terminalControlSchema.safeParse({
      type: 'terminal.resize',
      sessionId: frame.sessionId,
      terminalId: frame.terminalId,
      cols: 0,
      rows: 30,
    }).success,
    false,
  );
});

test('a run waiting only for background tasks, its task list and the request to end one are valid', () => {
  const event = {
    sessionId: randomUUID(),
    runId: randomUUID(),
    sequence: 1,
    createdAt: new Date().toISOString(),
  };
  const status = { type: 'run.status', status: 'running', connectionId: randomUUID() };
  assert.ok(
    eventSchema.safeParse({ ...event, payload: { ...status, waiting: 'background' } }).success,
  );
  assert.ok(
    eventSchema.safeParse({
      ...event,
      payload: {
        type: 'native.tasks',
        tasks: [{ id: 'b1', kind: 'local_bash', description: '渲染' }],
      },
    }).success,
  );
  const stop = {
    type: 'run.task.stop',
    requestId: randomUUID(),
    sessionId: event.sessionId,
    runId: event.runId,
    taskId: 'b1',
  };
  assert.ok(commandSchema.safeParse(stop).success);
  assert.equal(commandSchema.safeParse({ ...stop, taskId: '' }).success, false);
});

test('a turn report names the message it answered, or none for a turn a background task started', () => {
  const stats = {
    type: 'turn.stats',
    requests: 3,
    inputTokens: 10,
    outputTokens: 200,
    cacheReadTokens: 1000,
    cacheCreationTokens: 50,
    modelMs: 5500,
    ttftMs: null,
    outputPerSecond: null,
    partial: false,
  };
  const event = (payload: object) => ({
    sessionId: randomUUID(),
    runId: randomUUID(),
    sequence: 1,
    createdAt: new Date().toISOString(),
    payload,
  });
  assert.equal(eventSchema.safeParse(event({ ...stats, messageId: randomUUID() })).success, true);
  assert.equal(eventSchema.safeParse(event(stats)).success, true);
  assert.equal(eventSchema.safeParse(event({ ...stats, requests: -1 })).success, false);
  assert.equal(eventSchema.safeParse(event({ ...stats, partial: undefined })).success, false);
});

test('a session without a provider is Claude, and native events still decode', () => {
  const now = new Date().toISOString();
  const session = sessionSchema.parse({
    id: randomUUID(),
    title: '旧会话',
    projectPath: 'D:\\work',
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  });
  assert.equal(session.provider, 'claude');
  assert.equal(session.profileId, 'default');
  assert.equal(session.codexThreadId, undefined);
  assert.equal(sessionSchema.safeParse({ ...session, codexThreadId: 'thr_test' }).success, true);
  assert.equal(sessionSchema.safeParse({ ...session, codexThreadId: '' }).success, false);
  const created = commandSchema.parse({
    type: 'session.create',
    requestId: randomUUID(),
    title: '新会话',
    projectPath: 'D:\\work',
  });
  assert.equal(created.type, 'session.create');
  if (created.type === 'session.create') assert.equal(created.provider, 'claude');
  const openai = commandSchema.parse({
    type: 'session.create',
    requestId: randomUUID(),
    title: '新会话',
    projectPath: 'D:\\work',
    provider: 'openai',
  });
  if (openai.type === 'session.create') assert.equal(openai.provider, 'openai');
  const account = commandSchema.parse({ type: 'account.login', requestId: randomUUID() });
  if (account.type === 'account.login') assert.equal(account.provider, 'claude');
  assert.equal(
    eventSchema.safeParse({
      sessionId: session.id,
      runId: randomUUID(),
      sequence: 1,
      createdAt: now,
      payload: {
        type: 'native.session',
        nativeSessionId: randomUUID(),
        model: 'claude',
        version: '1',
      },
    }).success,
    true,
  );
});
