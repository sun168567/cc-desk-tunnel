import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  PROTOCOL_VERSION,
  ResumeLog,
  authSchema,
  commandSchema,
  eventSchema,
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

test('a resume log replays exactly what the other side missed and acknowledges in batches', () => {
  const acknowledged: number[] = [];
  const log = new ResumeLog((received) => acknowledged.push(received), 10);
  for (const frame of ['a', 'b', 'c']) assert.equal(log.record(frame), true);
  assert.deepEqual(log.since(1), ['b', 'c']);
  log.confirm(2);
  assert.deepEqual(log.since(2), ['c']);
  assert.equal(log.since(1), null, 'confirmed frames are gone');
  assert.equal(log.since(4), null, 'nothing was sent past the third');
  assert.deepEqual(log.since(3), []);
  assert.equal(log.record('x'.repeat(10)), false, 'over the limit');
  for (let index = 0; index < 64; index++) log.receive();
  assert.deepEqual(acknowledged, [64]);
  log.receive();
  log.flush();
  assert.deepEqual(acknowledged, [64, 65]);
  log.flush();
  assert.deepEqual(acknowledged, [64, 65], 'nothing new, no acknowledgment');
});
