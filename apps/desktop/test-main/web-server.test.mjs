import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createWebAuthStore, SESSION_LIFETIME_MS } from '../electron/web-auth.cjs';
import { startWebServer } from '../electron/web-server.mjs';
import { createWebControl } from '../electron/web-control.mjs';
import { ProxyClient } from '../src/client.ts';
import { createRemoteClientAdapter } from '../src/remote-client.ts';

async function start(t, options = {}) {
  const distDirectory = await mkdtemp(join(tmpdir(), 'ccdt-web-server-'));
  await writeFile(join(distDirectory, 'index.html'), '<!doctype html><title>Workbench</title>');
  const authStore = options.authStore ?? createWebAuthStore();
  const server = await startWebServer({
    distDirectory,
    authStore,
    getInfo: async () => ({ connected: true }),
    invoke: async () => 'done',
    onConnection: (socket) => socket.on('message', (data) => socket.send(data.toString())),
    ...options,
  });
  t.after(async () => {
    await server.close();
    await rm(distDirectory, { recursive: true, force: true });
  });
  return { ...server, authStore };
}

function http(server, path, { method = 'GET', body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      new URL(path, server.url),
      {
        method,
        agent: false,
        headers: {
          Origin: server.url,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: response.headers['content-type']?.includes('application/json')
              ? JSON.parse(text)
              : text,
          });
        });
        response.on('error', reject);
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function pair(server, headers) {
  const result = await http(server, '/api/login', {
    method: 'POST',
    body: { token: server.authStore.token },
    headers,
  });
  assert.equal(result.status, 200);
  return result.headers['set-cookie'][0].split(';')[0];
}

async function connect(server, cookie, origin = server.url) {
  const socket = new WebSocket(`${server.url.replace('http:', 'ws:')}/api/control`, {
    origin,
    headers: cookie ? { Cookie: cookie } : {},
  });
  socket.on('error', () => {});
  await once(socket, 'open');
  return socket;
}

test('pairing issues a finite cookie without sliding expiry or leaking management credentials', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1) });
  const server = await start(t);
  const result = await http(server, '/api/login', {
    method: 'POST',
    body: { token: server.authStore.token },
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36' },
  });
  assert.equal(result.status, 200);
  const cookie = result.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=2592000; Expires=/);
  const [metadata] = server.authStore.list();
  assert.equal(metadata.label, 'Chrome · Windows');
  assert.equal(cookie.includes(metadata.id), false);
  const authorized = await http(server, '/api/info', { cookie: cookie.split(';')[0] });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.headers['set-cookie'], undefined);
  assert.equal(server.authStore.list()[0].expiresAt, metadata.expiresAt);
  assert.deepEqual(authorized.body, { connected: true });
});

test('HTTP and WebSocket reject missing credentials, cross-origin access and ambiguous cookies', async (t) => {
  const server = await start(t);
  assert.equal((await http(server, '/api/info')).status, 401);
  assert.equal(
    (
      await http(server, '/api/login', {
        method: 'POST',
        body: { token: 'wrong-code' },
      })
    ).status,
    401,
  );
  const cookie = await pair(server);
  assert.equal(
    (await http(server, '/api/info', { cookie, headers: { Origin: 'http://untrusted.example' } }))
      .status,
    403,
  );
  assert.equal(
    (await http(server, '/api/info', { cookie, headers: { Host: 'untrusted.example' } })).status,
    403,
  );
  assert.equal((await http(server, '/api/info', { cookie: `${cookie}; ${cookie}` })).status, 401);
  await assert.rejects(connect(server), /401/);
  await assert.rejects(connect(server, cookie, 'http://untrusted.example'), /403/);
});

test('a running listener accepts current local interfaces but not removed addresses or arbitrary hosts', async (t) => {
  let addresses = [{ family: 'IPv4', address: '192.0.2.10' }];
  const mocked = t.mock.method(os, 'networkInterfaces', () => ({ lan: addresses }));
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  const server = await start(t);
  const cookie = await pair(server);
  const host = (address) => `${address}:${server.port}`;
  const local = (address) =>
    http(server, '/api/info', {
      cookie,
      headers: { Host: host(address), Origin: `http://${host(address)}` },
    });
  assert.equal((await local('192.0.2.10')).status, 200);
  addresses = [
    { family: 'IPv4', address: '192.0.2.20' },
    { family: 'IPv6', address: '2001:db8::20' },
  ];
  assert.equal((await local('192.0.2.20')).status, 200);
  assert.equal((await local('[2001:db8::20]')).status, 200);
  assert.equal((await local('192.0.2.10')).status, 403);
  assert.equal((await local('192.0.2.99')).status, 403);
  assert.equal((await local('untrusted.example')).status, 403);
  assert.equal(
    (await http(server, '/api/info', { cookie, headers: { Host: host('192.0.2.20') } })).status,
    403,
  );
  const socket = new WebSocket(`${server.url.replace('http:', 'ws:')}/api/control`, {
    origin: `http://${host('192.0.2.20')}`,
    headers: { Cookie: cookie, Host: host('192.0.2.20') },
  });
  socket.on('error', () => {});
  await once(socket, 'open');
  const echoed = once(socket, 'message');
  socket.send('new interface');
  assert.equal((await echoed)[0].toString(), 'new interface');
});

test('revoking one browser closes all its sockets and leaves other browsers usable', async (t) => {
  const server = await start(t);
  const first = await pair(server);
  const second = await pair(server);
  const firstId = first.split('=')[1];
  const firstSocket = await connect(server, first);
  const otherTab = await connect(server, first);
  const secondSocket = await connect(server, second);
  const closed = Promise.all([once(firstSocket, 'close'), once(otherTab, 'close')]);
  server.authStore.revokeSession(server.authStore.get(firstId).id);
  await closed;
  assert.equal((await http(server, '/api/info', { cookie: first })).status, 401);
  await assert.rejects(connect(server, first), /401/);
  assert.equal(secondSocket.readyState, WebSocket.OPEN);
  const echoed = once(secondSocket, 'message');
  secondSocket.send('still connected');
  assert.equal((await echoed)[0].toString(), 'still connected');
  assert.equal(
    (
      await http(server, '/api/rpc', {
        cookie: second,
        method: 'POST',
        body: { method: 'getState', args: [] },
      })
    ).status,
    200,
  );
});

test('absolute expiry disconnects idle sockets and rejects subsequent HTTP, RPC and upgrades', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 0, 1) });
  let calls = 0;
  const server = await start(t, {
    invoke: async () => ++calls,
  });
  const cookie = await pair(server);
  const socket = await connect(server, cookie);
  const closed = once(socket, 'close');
  t.mock.timers.tick(2 ** 31 - 1);
  assert.equal(socket.readyState, WebSocket.OPEN);
  t.mock.timers.tick(SESSION_LIFETIME_MS - (2 ** 31 - 1));
  await closed;
  assert.deepEqual(server.authStore.list(), []);
  assert.equal((await http(server, '/api/info', { cookie })).status, 401);
  assert.equal(
    (
      await http(server, '/api/rpc', {
        cookie,
        method: 'POST',
        body: { method: 'getState', args: [] },
      })
    ).status,
    401,
  );
  assert.equal(calls, 0);
  await assert.rejects(connect(server, cookie), /401/);
});

test('authorization is checked again before returning an in-flight RPC result', async (t) => {
  const invoked = Promise.withResolvers();
  const result = Promise.withResolvers();
  const server = await start(t, {
    invoke: async () => {
      invoked.resolve();
      return result.promise;
    },
  });
  const cookie = await pair(server);
  const pending = http(server, '/api/rpc', {
    cookie,
    method: 'POST',
    body: { method: 'getState', args: [] },
  });
  await invoked.promise;
  server.authStore.revokeSession(server.authStore.list()[0].id);
  result.resolve('private response');
  const response = await pending;
  assert.equal(response.status, 401);
  assert.equal(JSON.stringify(response.body).includes('private response'), false);
});

test('logout revokes its grant while stopping the listener preserves other saved grants', async (t) => {
  const server = await start(t);
  const first = await pair(server);
  const second = await pair(server);
  const loggedOut = await http(server, '/api/logout', { cookie: first, method: 'POST', body: {} });
  assert.equal(loggedOut.status, 200);
  assert.match(loggedOut.headers['set-cookie'][0], /Max-Age=0;/);
  assert.equal(server.authStore.get(first.split('=')[1]), null);
  await server.close();
  const restarted = await start(t, { authStore: server.authStore });
  assert.equal((await http(restarted, '/api/info', { cookie: second })).status, 200);
});

async function snapshot(t, text, count) {
  const client = new ProxyClient();
  const sessionId = randomUUID();
  const events = Array.from({ length: count }, (_, index) => ({
    sessionId,
    runId: randomUUID(),
    sequence: index + 1,
    createdAt: Date.now(),
    payload: { type: 'text.delta', messageId: randomUUID(), text },
  }));
  client.update({ status: 'connected', events: { [sessionId]: events } });
  let control;
  const adapter = createRemoteClientAdapter(client, (event) => control.publish(event));
  adapter.setEnabled(true);
  control = createWebControl((method, args, viewId) =>
    adapter.invoke({ id: 'snapshot', method, args, viewId }),
  );
  const server = await start(t, { onConnection: (socket) => control.attach(socket) });
  t.after(() => adapter.dispose());
  const socket = await connect(server, await pair(server));
  const result = new Promise((resolve, reject) => {
    const chunks = [];
    let received;
    socket.on('message', (raw) => {
      try {
        const value = JSON.parse(raw.toString());
        if (value.type === 'client:chunk') {
          assert.equal(value.index, chunks.length);
          chunks.push(value.text);
          if (chunks.length === value.total) received = JSON.parse(chunks.join(''));
        } else if (value.type === 'response') {
          assert.equal(value.ok, true);
          assert.equal(received.events[sessionId].replace.length, count);
          assert.equal(received.events[sessionId].replace.at(-1).payload.text, text);
          resolve();
        }
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('Socket closed before the snapshot completed')));
  });
  socket.send(JSON.stringify({ id: 'snapshot', method: 'client:state', args: [] }));
  await result;
  socket.close();
}

test(
  'a 12 MiB history snapshot survives its synchronous chunk burst on a real socket',
  { timeout: 30_000 },
  async (t) => {
    await snapshot(t, 'a'.repeat(192 * 1024), 64);
  },
);

test(
  'the outgoing budget includes JSON escaping for a nearly 64 MiB history snapshot',
  { timeout: 30_000 },
  async (t) => {
    // Each event stays below the service frame limit, while the complete state approaches 64 MiB.
    // A backslash is escaped once in the snapshot and a second time inside the chunk envelope.
    await snapshot(t, '\\'.repeat(63 * 1024), 512);
  },
);

test('a slow browser exceeding its bounded outgoing queue does not disconnect another browser', async (t) => {
  const peers = [];
  const server = await start(t, {
    onConnection: (socket) => {
      peers.push(socket);
      socket.on('message', (data) => socket.send(data.toString()));
    },
  });
  const cookie = await pair(server);
  const slow = await connect(server, cookie);
  const other = await connect(server, cookie);
  slow._socket.pause();
  const closed = once(slow, 'close');
  const frame = 'a'.repeat(16 * 1024 * 1024);
  // Completion callbacks have not run yet: nine frames exceed the limit, including in-flight data.
  for (let index = 0; index < 9; index++) peers[0].send(frame);
  assert.notEqual(peers[0].readyState, WebSocket.OPEN);
  slow._socket.resume();
  await closed;
  const echoed = once(other, 'message');
  other.send('another browser stays connected');
  assert.equal((await echoed)[0].toString(), 'another browser stays connected');
  assert.equal((await http(server, '/api/info', { cookie })).status, 200);
});

test('a browser that stops reading is closed after the bounded send timeout', async (t) => {
  const peers = [];
  const server = await start(t, { onConnection: (socket) => peers.push(socket) });
  const socket = await connect(server, await pair(server));
  socket._socket.pause();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const closed = once(socket, 'close');
  peers[0].send('a'.repeat(16 * 1024 * 1024));
  t.mock.timers.tick(30_000);
  assert.notEqual(peers[0].readyState, WebSocket.OPEN);
  socket._socket.resume();
  await closed;
});
