import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createWebControl } from '../electron/web-control.mjs';
import { createWebRequests } from '../electron/web-requests.cjs';
import { ProxyClient } from '../src/client.ts';
import { createRemoteClientAdapter } from '../src/remote-client.ts';

class PageSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  messages = [];
  send(text) {
    this.messages.push(JSON.parse(text));
  }
  close(code = 1000) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.code = code;
    this.emit('close');
  }
  terminate() {
    this.close();
  }
  request(id, method = 'client:state', args = []) {
    this.emit('message', Buffer.from(JSON.stringify({ id, method, args })), false);
  }
}

test('browser request IDs are isolated by page; repeated requests do not execute twice', async () => {
  const calls = [];
  const transport = createWebControl(async (method, args, viewId) => {
    calls.push({ method, args, viewId });
    return viewId;
  });
  const first = new PageSocket();
  const second = new PageSocket();
  transport.attach(first);
  transport.attach(second);
  first.request('same');
  first.request('same');
  second.request('same');
  await setImmediate();
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].viewId, calls[1].viewId);
  assert.equal(first.messages[0].result, calls[0].viewId);
  assert.equal(second.messages[0].result, calls[1].viewId);
  first.request('same');
  assert.equal(first.messages.length, 2);
  assert.equal(calls.length, 2);
  first.close();
  second.close();
  await setImmediate();
  assert.equal(calls.filter((x) => x.method === 'client:detach').length, 2);
});

test('Web dispatch rejects arbitrary IPC and conflicting IDs without touching the desktop', async () => {
  const calls = [];
  const transport = createWebControl((method) => calls.push(method));
  const socket = new PageSocket();
  transport.attach(socket);
  socket.request('one');
  await setImmediate();
  socket.request('one', 'client:select', ['different']);
  assert.equal(socket.code, 1008);
  const attacker = new PageSocket();
  transport.attach(attacker);
  attacker.request('two', 'proxy:disconnect');
  assert.equal(attacker.code, 1008);
  await setImmediate();
  assert.deepEqual(calls, ['client:state', 'client:detach', 'client:detach']);
});

test('closing immediately after requesting state leaves no orphan desktop view', async (context) => {
  const client = new ProxyClient();
  const events = [];
  const adapter = createRemoteClientAdapter(client, (event) => events.push(event));
  context.after(() => adapter.dispose());
  adapter.setEnabled(true);
  const transport = createWebControl((method, args, viewId) =>
    adapter.invoke({ id: 'renderer-request', method, args, viewId }),
  );
  const socket = new PageSocket();
  transport.attach(socket);
  socket.request('state');
  socket.close();
  await setImmediate();
  events.length = 0;
  client.update({ error: 'A later desktop update' });
  adapter.flush();
  assert.deepEqual(events, []);
});

test('a synchronous renderer dispatch failure never escapes a browser close event', async () => {
  const transport = createWebControl(() => {
    throw new Error('Renderer disappeared');
  });
  const socket = new PageSocket();
  transport.attach(socket);
  assert.doesNotThrow(() => socket.close());
  await setImmediate();
});

test('state is broadcast but terminal data is delivered only to its browser owner', async () => {
  const ids = [];
  const transport = createWebControl((_method, _args, id) => ids.push(id));
  const first = new PageSocket();
  const second = new PageSocket();
  transport.attach(first);
  transport.attach(second);
  first.request('a');
  second.request('b');
  await setImmediate();
  transport.publish({ message: { type: 'client:state', revision: 1 } });
  transport.publish({ viewId: ids[0], message: { type: 'client:terminal', message: 'private' } });
  assert.equal(first.messages.at(-1).type, 'client:terminal');
  assert.equal(second.messages.at(-1).type, 'client:state');
  first.close();
  transport.publish({ viewId: ids[0], message: { type: 'client:terminal', message: 'late' } });
  assert.equal(second.readyState, WebSocket.OPEN);
  second.close();
});

test('only the requested desktop renderer can answer IPC, and cancel clears outstanding work', async () => {
  const sent = [];
  const sender = { isDestroyed: () => false, send: (_channel, value) => sent.push(value) };
  const requests = createWebRequests({ window: () => ({ webContents: sender }) });
  const operation = requests.invoke('client:state', [], 'page');
  requests.reply({}, { id: sent[0].id, ok: true, result: 'forged' });
  requests.reply(sender, { id: sent[0].id, ok: true, result: 'real' });
  assert.equal(await operation, 'real');
  const cancelled = requests.invoke('schedules:run-now', ['task']);
  requests.cancel();
  await assert.rejects(cancelled, /Web 入口已关闭/);
  requests.reply(sender, { id: sent[1].id, ok: true, result: 'late' });
});

test('renderer requests have bounded waits and do not replay unknown outcomes', async () => {
  let calls = 0;
  const requests = createWebRequests({
    window: () => ({ webContents: { isDestroyed: () => false, send: () => calls++ } }),
    timeout: 5,
  });
  await assert.rejects(requests.invoke('client:request', []), /操作未自动重发/);
  assert.equal(calls, 1);
  requests.cancel();
});

test('closing all views while business IPC is full releases adapter views before the next browser attaches', async (t) => {
  const client = new ProxyClient();
  const adapter = createRemoteClientAdapter(client, () => {});
  adapter.setEnabled(true);
  const held = [];
  const sender = {
    isDestroyed: () => false,
    send: (_channel, request) => {
      if (request.method === 'client:info') {
        held.push(request);
        return;
      }
      void Promise.resolve()
        .then(() => adapter.invoke(request))
        .then(
          (result) => requests.reply(sender, { id: request.id, ok: true, result }),
          (error) => requests.reply(sender, { id: request.id, error: error.message }),
        );
    },
  };
  const requests = createWebRequests({ window: () => ({ webContents: sender }) });
  const transport = createWebControl((method, args, viewId) =>
    requests.invoke(method, args, viewId),
  );
  t.after(() => {
    requests.cancel();
    adapter.dispose();
  });
  const sockets = Array.from({ length: 16 }, () => new PageSocket());
  for (const socket of sockets) {
    transport.attach(socket);
    socket.request('state');
  }
  await setImmediate();
  assert.ok(sockets.every((socket) => socket.messages.at(-1).ok));
  const pending = Promise.all(
    Array.from({ length: 128 }, () => requests.invoke('client:info', [])),
  );
  assert.equal(held.length, 128);
  for (const socket of sockets) socket.close();
  await setImmediate();
  for (const request of held) requests.reply(sender, { id: request.id, ok: true, result: {} });
  await pending;
  const next = new PageSocket();
  transport.attach(next);
  next.request('state');
  await setImmediate();
  assert.equal(next.messages.at(-1).ok, true);
  next.close();
  await setImmediate();
});
