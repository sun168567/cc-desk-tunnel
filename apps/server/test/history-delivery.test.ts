import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ServerMessage } from '@cc-desk-tunnel/protocol';
import { HistoryDelivery } from '../src/history-delivery.ts';

test('history bounds the in-flight window and preserves escaped text and Unicode exactly', async () => {
  const messages: ServerMessage[] = [];
  const delivery = new HistoryDelivery((message) => messages.push(message));
  const requestId = randomUUID(),
    sessionId = randomUUID();
  const original: ServerMessage[] = [
    {
      type: 'session.fragment',
      sessionId,
      runId: randomUUID(),
      payload: { type: 'text.delta', messageId: randomUUID(), text: '中文🙂\n"\\'.repeat(30000) },
    },
  ];
  const done = delivery.deliver(requestId, sessionId, original);
  assert.equal(messages.length, 4);
  delivery.next(randomUUID());
  assert.equal(messages.length, 4);
  const parts: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const part = messages[i];
    assert.equal(part.type, 'session.history.part');
    if (part.type !== 'session.history.part') throw Error('part expected');
    assert.ok(Buffer.byteLength(JSON.stringify(part)) < 200 * 1024);
    parts.push(part.data);
    delivery.next(requestId);
  }
  await done;
  assert.deepEqual(JSON.parse(parts.join('')), original);
});

test('replacing or abandoning a page releases it; late acknowledgments do not advance its replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const messages: ServerMessage[] = [];
  const delivery = new HistoryDelivery((message) => messages.push(message));
  const sessionId = randomUUID(),
    first = randomUUID(),
    second = randomUUID();
  const page: ServerMessage[] = [
    {
      type: 'session.fragment',
      sessionId,
      runId: randomUUID(),
      payload: { type: 'text.delta', messageId: randomUUID(), text: 'x'.repeat(300000) },
    },
  ];
  const old = delivery.deliver(first, sessionId, page).catch((error) => error);
  const next = delivery.deliver(second, sessionId, page).catch((error) => error);
  assert.equal((await old).code, 'history_cancelled');
  delivery.next(first);
  assert.equal(messages.length, 8);
  t.mock.timers.tick(20000);
  delivery.next(second);
  t.mock.timers.tick(20000);
  assert.equal(messages.length, 9);
  t.mock.timers.tick(10001);
  assert.equal((await next).code, 'history_stalled');
  delivery.next(second);
  assert.equal(messages.length, 9);
});
