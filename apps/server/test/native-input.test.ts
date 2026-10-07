import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EventPayload } from '@cc-desk-tunnel/protocol';
import { NativeInput } from '../src/native-input.ts';

function fixture() {
  const events: EventPayload[] = [];
  const sessionId = randomUUID();
  const input = new NativeInput(sessionId, (event) => events.push(event));
  return { events, sessionId, input };
}
function result(ids: string[], queued = 0) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    user_message_uuid: ids[0],
    user_message_uuids: ids,
    queued_turn_count: queued,
  } as SDKResultMessage;
}

test('streaming additions use the same native session and human message UUIDs', async () => {
  const { input, sessionId, events } = fixture();
  const stream = input.stream();
  const first = randomUUID(),
    second = randomUUID();
  input.submit(first, 'first');
  assert.deepEqual((await stream.next()).value, {
    type: 'user',
    uuid: first,
    parent_tool_use_id: null,
    session_id: sessionId,
    message: { role: 'user', content: 'first' },
    origin: { kind: 'human' },
  });
  const waiting = stream.next();
  input.submit(second, 'second');
  assert.equal((await waiting).value?.uuid, second);
  assert.deepEqual(
    events.filter((event) => event.type === 'message.delivery').map((event) => event.status),
    ['submitted', 'queued', 'submitted', 'queued'],
  );
  input.close();
  assert.equal((await stream.next()).done, true);
});

test('native merged receipts complete multiple sends without inventing additional turns', async () => {
  const { input, events } = fixture();
  const ids = [randomUUID(), randomUUID()];
  const stream = input.stream();
  for (const id of ids) {
    input.submit(id, id);
    await stream.next();
  }
  input.observe({
    type: 'stream_event',
    parent_tool_use_id: null,
    user_message_uuid: ids[0],
  } as SDKMessage);
  input.observe({
    type: 'assistant',
    parent_tool_use_id: null,
    user_message_uuid: ids[0],
  } as SDKMessage);
  const done = result(ids);
  input.observe(done);
  assert.equal(input.endTurn(done), true);
  assert.throws(() => input.submit(randomUUID(), 'too late'), { code: 'run_finishing' });
  assert.deepEqual(
    events.flatMap((event) =>
      event.type === 'message.delivery' && event.status === 'received' ? [event.messageId] : [],
    ),
    ids,
  );
  input.close();
  assert.ok(
    !events.some((event) => event.type === 'message.delivery' && event.status === 'unconfirmed'),
  );
  await stream.next();
});

test('first result cannot discard a submitted input even if its native write is still pending', async () => {
  const { input } = fixture();
  const ids = [randomUUID(), randomUUID()];
  const stream = input.stream();
  input.submit(ids[0], 'first');
  await stream.next();
  input.submit(ids[1], 'second');
  const first = result([ids[0]]);
  input.observe(first);
  assert.equal(input.endTurn(first), false);
  assert.equal((await stream.next()).value?.uuid, ids[1]);
  const second = result([ids[1]]);
  input.observe(second);
  assert.equal(input.endTurn(second), true);
  input.close();
  await stream.next();
});

test('cancel and disconnect distinguish never sent from unconfirmed and do not replay inputs', async () => {
  const { input, events } = fixture();
  const ids = [randomUUID(), randomUUID()];
  const stream = input.stream();
  input.submit(ids[0], 'delivered');
  await stream.next();
  input.submit(ids[1], 'not delivered');
  input.close();
  input.close();
  assert.equal((await stream.next()).done, true);
  assert.deepEqual(events.filter((event) => event.type === 'message.delivery').slice(-2), [
    { type: 'message.delivery', messageId: ids[0], status: 'unconfirmed' },
    { type: 'message.delivery', messageId: ids[1], status: 'not_sent' },
  ]);
  assert.throws(() => input.assertWritable(), { code: 'run_finishing' });
});

test('transport waiters close, bounded backlog rejects, and unrelated or subagent echoes cannot confirm a send', async () => {
  const { input, events } = fixture();
  const stream = input.stream();
  const ids = Array.from({ length: 32 }, () => randomUUID());
  for (const id of ids) input.submit(id, 'test');
  assert.throws(() => input.submit(randomUUID(), 'overflow'), { code: 'input_busy' });
  input.observe({
    type: 'assistant',
    parent_tool_use_id: 'nested',
    user_message_uuid: ids[0],
  } as SDKMessage);
  input.observe({
    type: 'assistant',
    parent_tool_use_id: null,
    user_message_uuid: randomUUID(),
  } as SDKMessage);
  assert.ok(
    !events.some((event) => event.type === 'message.delivery' && event.status === 'received'),
  );
  input.close();
  assert.equal((await stream.next()).done, true);
  const empty = fixture().input;
  const pending = empty.stream().next();
  empty.close();
  assert.equal((await pending).done, true);
});

test('fatal and older native results seal the input while reporting uncertain deliveries', async () => {
  for (const done of [
    { type: 'result', is_error: true, queued_turn_count: 1 },
    { type: 'result', is_error: false, queued_turn_count: 0 },
  ] as SDKResultMessage[]) {
    const { input, events } = fixture();
    const id = randomUUID();
    const stream = input.stream();
    input.submit(id, 'test');
    await stream.next();
    assert.equal(input.endTurn(done), true);
    assert.throws(() => input.assertWritable(), { code: 'run_finishing' });
    input.close();
    assert.ok(
      events.some((event) => event.type === 'message.delivery' && event.status === 'unconfirmed'),
    );
    await stream.next();
  }
});
