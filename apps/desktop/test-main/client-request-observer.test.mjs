import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { ProxyClient, RequestInterruptedError } from '../src/client.ts';

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.WebSocket;
  const sockets = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    failure = null;
    constructor() {
      sockets.push(this);
    }
    send(text) {
      if (this.failure) throw this.failure;
      this.sent.push(JSON.parse(text));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    message(value) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  globalThis.WebSocket = Socket;
  const client = new ProxyClient();
  const ready = () => {
    const socket = sockets.at(-1);
    socket.message({
      type: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      version: '0.0.1',
      connectionId: randomUUID(),
      adapter: 'simulation',
      sessions: [],
    });
    return socket;
  };
  const connect = () => {
    client.connect('ws://127.0.0.1:1/ws', 'test-token-with-enough-characters');
    return ready();
  };
  const socket = connect();
  const reply = (target, requestId, values = {}) => {
    const response = { type: 'response', requestId, ok: true, ...values };
    target.message(response);
    return response;
  };
  t.after(() => {
    for (const socket of sockets) socket.failure = null;
    client.disconnect();
    globalThis.WebSocket = original;
  });
  return { client, socket, sockets, connect, ready, reply };
}
const open = () => ({ type: 'terminal.open', sessionId: randomUUID(), cols: 80, rows: 24 });

test('default requests retain their original 10-second and 30-second timeouts', async (t) => {
  const { client, socket } = fixture(t);
  for (const [command, delay] of [
    [open(), 10000],
    [{ type: 'session.status', sessionId: randomUUID() }, 30000],
    [{ type: 'account.status' }, 30000],
    [{ type: 'service.update.check' }, 30000],
  ]) {
    const result = client.request(command).catch((error) => error);
    t.mock.timers.tick(delay - 1);
    assert.equal(client.pending.size, 1);
    t.mock.timers.tick(1);
    assert.match((await result).message, /请求超时/);
    assert.equal(client.pending.size, 0);
  }
  assert.equal(socket.sent.length, 4);
});

for (const ok of [true, false]) {
  test(`an observed reply (ok=${ok}) settles the original request and notifies once`, async (t) => {
    const { client, socket, reply } = fixture(t);
    const outcomes = [];
    const result = client.request(open(), (value) => outcomes.push(value)).catch((error) => error);
    const id = socket.sent.at(-1).requestId;
    const response = reply(socket, id, { ok, message: 'final reply' });
    const settled = await result;
    if (ok) assert.deepEqual(settled, response);
    else assert.equal(settled.message, 'final reply');
    reply(socket, id, { ok });
    client.disconnect();
    assert.deepEqual(outcomes, [response]);
  });
}

for (const ok of [true, false]) {
  test(`a timed-out request still reports its final reply (ok=${ok}) without replay`, async (t) => {
    const { client, socket, reply } = fixture(t);
    const outcomes = [];
    const result = client.request(open(), (value) => outcomes.push(value)).catch((error) => error);
    const id = socket.sent.at(-1).requestId;
    t.mock.timers.tick(10000);
    assert.match((await result).message, /请求超时/);
    assert.equal(client.pending.size, 0);
    assert.deepEqual(outcomes, []);
    t.mock.timers.tick(60000);
    assert.deepEqual(outcomes, []);
    const response = reply(socket, id, { ok, ...(ok ? {} : { code: 'terminal_failed' }) });
    reply(socket, id, { ok });
    assert.deepEqual(outcomes, [response]);
    assert.equal(socket.sent.length, 1);
  });
}

test('disconnect releases active and timed-out observers; old replies cannot reach a new connection', async (t) => {
  const { client, socket, connect, reply } = fixture(t);
  const late = [];
  const active = [];
  const oldResult = client.request(open(), (value) => late.push(value)).catch((error) => error);
  const oldId = socket.sent.at(-1).requestId;
  t.mock.timers.tick(10000);
  await oldResult;
  const activeResult = client
    .request(open(), (value) => active.push(value))
    .catch((error) => error);
  client.disconnect();
  assert.ok((await activeResult) instanceof RequestInterruptedError);
  assert.equal(late.length, 1);
  assert.equal(active.length, 1);
  assert.ok(late[0] instanceof RequestInterruptedError);
  assert.ok(active[0] instanceof RequestInterruptedError);
  const next = connect();
  const outcomes = [];
  const nextResult = client.request(open(), (value) => outcomes.push(value));
  const nextId = next.sent.at(-1).requestId;
  reply(socket, oldId);
  reply(socket, nextId);
  assert.deepEqual(outcomes, []);
  assert.equal(client.pending.size, 1);
  const response = reply(next, nextId);
  assert.deepEqual(await nextResult, response);
  assert.deepEqual(outcomes, [response]);
  assert.equal(late.length, 1);
  assert.equal(active.length, 1);
});

test('automatic reconnect releases late observers without replaying their commands', async (t) => {
  const { client, socket, ready, reply } = fixture(t);
  const outcomes = [];
  const result = client.request(open(), (value) => outcomes.push(value)).catch((error) => error);
  const id = socket.sent.at(-1).requestId;
  t.mock.timers.tick(10000);
  await result;
  socket.close();
  assert.equal(client.state.status, 'reconnecting');
  assert.equal(outcomes.length, 1);
  assert.ok(outcomes[0] instanceof RequestInterruptedError);
  t.mock.timers.tick(1000);
  const next = ready();
  reply(socket, id);
  assert.equal(outcomes.length, 1);
  assert.equal(socket.sent.length, 1);
  assert.equal(next.sent.length, 0);
  assert.equal(client.state.status, 'connected');
});

test('observer failures cannot break responses or other disconnect cleanup', async (t) => {
  const { client, socket, reply } = fixture(t);
  let calls = 0;
  const throwing = () => {
    calls++;
    throw new Error('observer failed');
  };
  const result = client.request(open(), throwing);
  assert.doesNotThrow(() => reply(socket, socket.sent.at(-1).requestId));
  assert.equal((await result).ok, true);
  const pending = client.request(open(), throwing).catch((error) => error);
  const others = [];
  const another = client.request(open(), (value) => others.push(value)).catch((error) => error);
  assert.doesNotThrow(() => client.disconnect());
  assert.ok((await pending) instanceof RequestInterruptedError);
  assert.ok((await another) instanceof RequestInterruptedError);
  assert.equal(calls, 2);
  assert.equal(others.length, 1);
});

test('a final callback may disconnect without changing the already received response', async (t) => {
  const { client, socket, reply } = fixture(t);
  const result = client.request(open(), () => client.disconnect());
  reply(socket, socket.sent.at(-1).requestId);
  assert.equal((await result).ok, true);
  assert.equal(client.pending.size, 0);
  assert.equal(client.state.status, 'disconnected');
});

test('an asynchronous observer failure is isolated from the client', async (t) => {
  const { client, socket, reply } = fixture(t);
  const result = client.request(open(), async () => {
    throw new Error('asynchronous observer failure');
  });
  reply(socket, socket.sent.at(-1).requestId);
  assert.equal((await result).ok, true);
  await Promise.resolve();
  assert.equal(client.state.status, 'connected');
});

test('synchronous send failure clears the request and observer immediately', async (t) => {
  const { client, socket, reply } = fixture(t);
  const outcomes = [];
  socket.failure = new Error('socket send failed');
  await assert.rejects(
    client.request(open(), (value) => outcomes.push(value)),
    /send failed/,
  );
  assert.equal(client.pending.size, 0);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0], socket.failure);
  assert.equal(socket.sent.length, 0);
  socket.failure = null;
  t.mock.timers.tick(10000);
  const next = client.request(open());
  reply(socket, socket.sent.at(-1).requestId);
  await next;
  client.disconnect();
  assert.equal(outcomes.length, 1);
});

test('observers are bounded while ordinary requests keep the original path', async (t) => {
  const { client, socket, reply } = fixture(t);
  const calls = Array.from({ length: 32 }, () => []);
  const pending = calls.map((outcomes) =>
    client.request(open(), (value) => outcomes.push(value)).catch((error) => error),
  );
  const ids = socket.sent.map(({ requestId }) => requestId);
  t.mock.timers.tick(10000);
  await Promise.all(pending);
  const refused = [];
  await assert.rejects(
    client.request(open(), (value) => refused.push(value)),
    /等待确认的请求过多/,
  );
  assert.equal(refused.length, 1);
  assert.ok(refused[0] instanceof Error);
  assert.equal(socket.sent.length, 32);
  const ordinary = client.request(open());
  reply(socket, socket.sent.at(-1).requestId);
  assert.equal((await ordinary).ok, true);
  reply(socket, ids[0], { ok: false, code: 'terminal_failed' });
  const extra = [];
  const accepted = client.request(open(), (value) => extra.push(value));
  reply(socket, socket.sent.at(-1).requestId);
  await accepted;
  client.disconnect();
  assert.ok(calls.every((values) => values.length === 1));
  assert.equal(extra.length, 1);
  assert.equal(refused.length, 1);
});

test('an observed request refused before sending reports the failure once', async (t) => {
  const { client } = fixture(t);
  client.disconnect();
  const outcomes = [];
  await assert.rejects(
    client.request(open(), (value) => outcomes.push(value)),
    /服务未连接/,
  );
  client.disconnect();
  assert.equal(client.pending.size, 0);
  assert.equal(outcomes.length, 1);
  assert.ok(outcomes[0] instanceof Error);
});
