import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { TUNNEL_CLOSE } from '@cc-desk-tunnel/protocol';
import { openChannels } from '../electron/tunnel-channels.mjs';

const offer = { connectionId: randomUUID(), secret: 's'.repeat(43) };
// A service end that records what each channel connection says first, and a local "SSH service" that greets.
async function fixture(t, options = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', ...options });
  await once(wss, 'listening');
  const arrivals = [];
  wss.on('connection', (socket) => {
    const arrival = { socket, frames: [], closed: false };
    socket.on('message', (data, binary) => arrival.frames.push({ data, binary }));
    socket.on('close', () => (arrival.closed = true));
    arrivals.push(arrival);
  });
  const locals = [];
  const ssh = createServer((socket) => {
    locals.push(socket);
    socket.on('error', () => {});
    // An end is only seen by a connection that reads.
    socket.resume();
    socket.write('SSH-2.0-local\r\n');
  });
  ssh.listen(0, '127.0.0.1');
  await once(ssh, 'listening');
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    for (const socket of locals) socket.destroy();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => ssh.close(resolve));
  });
  const url = `ws://127.0.0.1:${wss.address().port}`;
  async function dial() {
    const socket = new WebSocket(url);
    await once(socket, 'open');
    return socket;
  }
  async function until(check, what = 'condition') {
    for (let attempt = 0; !check(); attempt++) {
      assert.ok(attempt < 600, `timed out waiting for ${what}`);
      await delay(5);
    }
  }
  return { arrivals, locals, port: ssh.address().port, dial, until };
}

test('a requested channel signs in with the tunnel secret and joins the local SSH service', async (t) => {
  const f = await fixture(t);
  const failures = [];
  const channels = openChannels(offer, f.port, f.dial, (message) => failures.push(message));
  t.after(() => channels.close());
  const channelId = randomUUID();
  channels.open(channelId);
  await f.until(() => f.arrivals[0]?.frames.length >= 2, 'the attach frame and the greeting');
  const [attach, greeting] = f.arrivals[0].frames;
  assert.equal(attach.binary, false);
  assert.deepEqual(JSON.parse(attach.data.toString()), {
    type: 'tunnel.attach',
    connectionId: offer.connectionId,
    channelId,
    secret: offer.secret,
  });
  assert.deepEqual([greeting.binary, greeting.data.toString()], [true, 'SSH-2.0-local\r\n']);
  let heard = '';
  f.locals[0].on('data', (chunk) => (heard += chunk));
  f.arrivals[0].socket.send(Buffer.from('SSH-2.0-remote\r\n'));
  await f.until(() => heard === 'SSH-2.0-remote\r\n', 'bytes from the service');
  // The service ends the SSH connection: the local one ends with it, and the reverse.
  f.arrivals[0].socket.close();
  await once(f.locals[0], 'close');
  channels.open(randomUUID());
  await f.until(() => f.locals.length === 2 && f.arrivals.length === 2);
  f.locals[1].end();
  await once(f.arrivals[1].socket, 'close');
  await f.until(() => channels.size === 0, 'channels to be forgotten');
  assert.deepEqual(failures, []);
});
test('a channel that cannot connect is tried again, and given up without ending the connection', async (t) => {
  const f = await fixture(t);
  const failures = [];
  let attempts = 0;
  const flaky = () =>
    ++attempts < 3 ? Promise.reject(new Error('Unexpected server response: 429')) : f.dial();
  const channels = openChannels(offer, f.port, flaky, (message) => failures.push(message));
  t.after(() => channels.close());
  channels.open(randomUUID());
  await f.until(() => f.arrivals.length === 1 && channels.size === 1, 'the third attempt');
  assert.equal(attempts, 3);
  assert.equal(channels.lastError, undefined);

  const refused = openChannels(
    offer,
    f.port,
    () => Promise.reject(new Error('Unexpected server response: 502')),
    (message) => failures.push(message),
    300,
  );
  refused.open(randomUUID());
  await f.until(() => refused.lastError, 'the failure to be remembered');
  await delay(1500);
  assert.match(refused.lastError.message, /502/);
  assert.equal(f.arrivals.length, 1);
  assert.deepEqual(failures, []);
});
test('a service that is not the one signed in to ends the connection before the secret is sent', async (t) => {
  const f = await fixture(t);
  const failures = [];
  let attempts = 0;
  const channels = openChannels(
    offer,
    f.port,
    () => {
      attempts++;
      return Promise.reject(Object.assign(new Error('指纹不匹配'), { fatal: true }));
    },
    (message) => failures.push(message),
  );
  channels.open(randomUUID());
  await f.until(() => failures.length, 'the failure');
  assert.deepEqual(failures, ['指纹不匹配']);
  assert.equal(attempts, 1);
  // Nothing more is opened once the connection has failed.
  channels.open(randomUUID());
  await delay(100);
  assert.equal(attempts, 1);
  assert.equal(f.arrivals.length, 0);
});
test('a refused secret ends the connection; a channel nobody waits for any more does not', async (t) => {
  const f = await fixture(t);
  const failures = [];
  const channels = openChannels(offer, f.port, f.dial, (message) => failures.push(message));
  t.after(() => channels.close());
  channels.open(randomUUID());
  await f.until(() => f.arrivals.length === 1);
  f.arrivals[0].socket.close(TUNNEL_CLOSE.unknown, 'Unknown channel');
  await f.until(() => channels.size === 0);
  await delay(50);
  assert.deepEqual(failures, []);
  channels.open(randomUUID());
  await f.until(() => f.arrivals.length === 2);
  f.arrivals[1].socket.close(TUNNEL_CLOSE.refused, 'Unauthorized');
  await f.until(() => failures.length, 'the failure');
  assert.match(failures[0], /认证没有通过/);
  assert.equal(failures.length, 1);
});
test('a channel that stops answering is given up with its local connection; one that answers is kept', async (t) => {
  const silent = await fixture(t, { autoPong: false });
  const answering = await fixture(t);
  const lost = openChannels(
    offer,
    silent.port,
    silent.dial,
    () => assert.fail('no failure'),
    10000,
    40,
  );
  const kept = openChannels(
    offer,
    answering.port,
    answering.dial,
    () => assert.fail('no failure'),
    10000,
    40,
  );
  t.after(() => [lost, kept].forEach((channels) => channels.close()));
  lost.open(randomUUID());
  kept.open(randomUUID());
  await silent.until(() => silent.locals.length === 1 && answering.locals.length === 1);
  const localClosed = once(silent.locals[0], 'close');
  const started = Date.now();
  await silent.until(() => lost.size === 0, 'the silent channel to be given up');
  // Two unanswered askings are allowed for; the third interval ends it.
  assert.ok(Date.now() - started >= 80, `given up after ${Date.now() - started}ms`);
  await localClosed;
  await delay(200);
  assert.equal(kept.size, 1);
  assert.equal(answering.arrivals[0].closed, false);
});
test('closing ends every channel and its local connection; a local service that is gone ends the channel', async (t) => {
  const f = await fixture(t);
  const channels = openChannels(offer, f.port, f.dial, () => assert.fail('no failure expected'));
  channels.open(randomUUID());
  channels.open(randomUUID());
  await f.until(() => f.locals.length === 2 && f.arrivals.length === 2);
  const ended = Promise.all([
    ...f.locals.map((socket) => once(socket, 'close')),
    ...f.arrivals.map((arrival) => once(arrival.socket, 'close')),
  ]);
  channels.close();
  await ended;
  assert.equal(channels.size, 0);
  channels.open(randomUUID());
  await delay(100);
  assert.equal(f.arrivals.length, 2);

  // Port 1 answers nothing on a development machine: the SSH service is not there.
  const orphan = openChannels(offer, 1, f.dial, () => assert.fail('no failure expected'));
  t.after(() => orphan.close());
  orphan.open(randomUUID());
  await f.until(() => f.arrivals[2]?.closed, 'the channel without a local service to end');
});
