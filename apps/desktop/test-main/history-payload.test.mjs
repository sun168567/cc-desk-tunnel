import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Receiver, Sender } from 'ws';
import { observeHistoryPayload } from '../electron/history-payload.mjs';

test('only snapshot payload bytes count; framing, ping, pong and other JSON messages are excluded', async () => {
  const receiver = new Receiver();
  const progress = [];
  const messages = [];
  observeHistoryPayload(receiver, (requestId, bytes) => progress.push({ requestId, bytes }));
  receiver.on('message', (data) => messages.push(JSON.parse(String(data))));
  const requestId = randomUUID();
  const page = JSON.stringify({
    type: 'session.snapshot',
    session: { title: '历史记录'.repeat(100) },
    requestId,
    events: [{ text: 'history'.repeat(1000) }],
  });
  const control = Buffer.concat(
    Sender.frame(Buffer.from('still online'), { fin: true, opcode: 9, mask: false }),
  );
  const pong = Buffer.concat(Sender.frame(Buffer.alloc(0), { fin: true, opcode: 10, mask: false }));
  const other = Buffer.concat(
    Sender.frame(
      Buffer.from(
        JSON.stringify({
          type: 'session.updated',
          requestId,
          session: { title: 'unrelated status' },
        }),
      ),
      { fin: true, opcode: 1, mask: false },
    ),
  );
  const frame = Buffer.concat(
    Sender.frame(Buffer.from(page), { fin: true, opcode: 1, mask: false }),
  );
  const input = Buffer.concat([control, other, frame, pong, other]);
  // Split headers, UTF-8 and JSON fields at arbitrary transport chunk boundaries.
  for (let offset = 0; offset < input.length; offset += 37)
    await new Promise((resolve, reject) =>
      receiver.write(input.subarray(offset, offset + 37), (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  assert.ok(progress.length > 2);
  assert.ok(progress.every((item) => item.requestId === requestId));
  assert.equal(
    progress.reduce((sum, item) => sum + item.bytes, 0),
    Buffer.byteLength(page),
  );
  assert.deepEqual(messages, [
    JSON.parse(other.subarray(2).toString()),
    JSON.parse(page),
    JSON.parse(other.subarray(2).toString()),
  ]);
});

test('fragmented history counts across frames without counting interleaved control frames or another page', async () => {
  const receiver = new Receiver();
  const progress = [];
  observeHistoryPayload(receiver, (requestId, bytes) => progress.push({ requestId, bytes }));
  const requestId = randomUUID();
  const oldId = randomUUID();
  const text = JSON.stringify({
    type: 'session.snapshot',
    requestId,
    events: [{ text: 'data'.repeat(300) }],
  });
  const frame = (text, opcode, fin = true) =>
    Buffer.concat(Sender.frame(Buffer.from(text), { opcode, fin, mask: false }));
  const input = Buffer.concat([
    frame(text.slice(0, 15), 1, false),
    frame('alive', 9),
    frame(text.slice(15, 46), 0, false),
    frame('', 10),
    frame(text.slice(46), 0),
    frame(JSON.stringify({ type: 'session.snapshot', requestId: oldId, events: [] }), 1),
  ]);
  for (let offset = 0; offset < input.length; offset += 43)
    await new Promise((resolve, reject) =>
      receiver.write(input.subarray(offset, offset + 43), (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  assert.equal(
    progress
      .filter((item) => item.requestId === requestId)
      .reduce((sum, item) => sum + item.bytes, 0),
    Buffer.byteLength(text),
  );
  assert.ok(progress.some((item) => item.requestId === oldId));
});
