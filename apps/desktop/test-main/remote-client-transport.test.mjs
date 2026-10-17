import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { ProxyClient } from '../src/client.ts';
import { RemoteClient, createRemoteClientAdapter } from '../src/remote-client.ts';
import { createWebControl } from '../electron/web-control.mjs';
import { createWebRequests } from '../electron/web-requests.cjs';

async function until(check) {
  for (let n = 0; n < 1000; n++) {
    if (check()) return;
    await wait(10);
  }
  throw new Error('Transport did not settle');
}
async function server(t, connected) {
  const result = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(result, 'listening');
  result.on('connection', connected);
  t.after(async () => {
    for (const socket of result.clients) socket.terminate();
    await new Promise((resolve) => result.close(resolve));
  });
  return result;
}
async function browser(t, desktop, delay = 0) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = WebSocket;
  let adapter, ipc;
  const sender = {
    isDestroyed: () => false,
    send(_channel, request) {
      setTimeout(() => {
        Promise.resolve(adapter.invoke(request)).then(
          (result) => ipc.reply(sender, { id: request.id, ok: true, result }),
          (error) => ipc.reply(sender, { id: request.id, ok: false, error: error.message }),
        );
      }, delay);
    },
  };
  ipc = createWebRequests({ window: () => ({ webContents: sender }) });
  const control = createWebControl((method, args, viewId) => ipc.invoke(method, args, viewId));
  adapter = createRemoteClientAdapter(desktop, (event) => control.publish(event));
  adapter.setEnabled(true);
  let socket,
    closed = null;
  const listener = await server(t, (next) => {
    socket = next;
    socket.once('close', (code) => {
      closed = code;
    });
    control.attach(socket);
  });
  const client = new RemoteClient();
  client.connect(`ws://127.0.0.1:${listener.address().port}`, '', {});
  t.after(() => {
    client.disconnect();
    adapter.dispose();
    ipc.cancel();
    globalThis.WebSocket = original;
  });
  await until(() => client.state.status === 'connected');
  return { client, socket, closed: () => closed };
}

test('large terminal paste crosses real Web sockets without exhausting the renderer RPC limit', async (t) => {
  const desktop = new ProxyClient();
  const sessionId = randomUUID(),
    terminalId = randomUUID();
  desktop.update({
    status: 'connected',
    connectionId: randomUUID(),
    sessions: [{ id: sessionId, title: 'terminal', activeRun: null }],
    selectedId: sessionId,
  });
  const input = [];
  let closed = 0;
  desktop.terminalControl = (command) => {
    if (command.type === 'terminal.input') input.push(command.data);
  };
  desktop.request = async (command, onFinal) => {
    if (command.type === 'terminal.open')
      for (const listener of desktop.terminalListeners)
        listener({ type: 'terminal.opened', sessionId, terminalId });
    if (command.type === 'terminal.close') closed++;
    const result = { type: 'response', ok: true, requestId: randomUUID(), sessionId };
    onFinal?.(result);
    return result;
  };
  const web = await browser(t, desktop, 25);
  t.after(() => desktop.update({ status: 'disconnected', connectionId: null }));
  await web.client.request({ type: 'terminal.open', sessionId, cols: 80, rows: 24 });
  const text = 'large-paste\n'.repeat(30000);
  for (let offset = 0; offset < text.length; offset += 4096)
    web.client.terminalControl({
      type: 'terminal.input',
      sessionId,
      terminalId,
      data: text.slice(offset, offset + 4096),
    });
  await until(() => input.join('').length === text.length);
  assert.equal(input.join(''), text);
  assert.equal(web.closed(), null);
  assert.equal(closed, 0);
  assert.equal(web.client.state.status, 'connected');
});

test('a browser frame delayed across two real service connections cannot log out the new service', async (t) => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = WebSocket;
  t.after(() => {
    globalThis.WebSocket = original;
  });
  async function service() {
    const connectionId = randomUUID(),
      requests = [];
    const listener = await server(t, (socket) =>
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'auth')
          socket.send(
            JSON.stringify({
              type: 'ready',
              protocolVersion: PROTOCOL_VERSION,
              version: '0.0.1',
              connectionId,
              adapter: 'simulation',
              sessions: [],
            }),
          );
        if (message.requestId) {
          requests.push(message);
          socket.send(JSON.stringify({ type: 'response', requestId: message.requestId, ok: true }));
        }
      }),
    );
    return { connectionId, requests, url: `ws://127.0.0.1:${listener.address().port}/ws` };
  }
  const first = await service(),
    second = await service();
  const desktop = new ProxyClient();
  const device = { id: randomUUID(), name: 'desktop', platform: 'win32' };
  const login = (target) =>
    desktop.connect(target.url, 'test-token-with-enough-characters', device, false);
  t.after(() => desktop.disconnect());
  login(first);
  await until(() => desktop.state.connectionId === first.connectionId);
  const web = await browser(t, desktop);
  web.socket.pause();
  const pending = web.client.request({ type: 'account.logout' });
  desktop.disconnect();
  login(second);
  await until(() => desktop.state.connectionId === second.connectionId);
  web.socket.resume();
  await assert.rejects(pending, /连接已变化/);
  assert.deepEqual(first.requests, []);
  assert.deepEqual(second.requests, []);
  await until(() => web.client.state.connectionId === second.connectionId);
  await web.client.request({ type: 'account.logout' });
  assert.deepEqual(
    second.requests.map((command) => command.type),
    ['account.logout'],
  );
});
