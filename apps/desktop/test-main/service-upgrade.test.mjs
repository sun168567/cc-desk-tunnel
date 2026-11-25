import { failureText } from '../electron/words.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { probeService, upgradeService } from '../electron/service-upgrade.mjs';

// A 0.3.2 service: signs in only a client of protocol 17, and answers an update check with `found`.
async function upgrade(found, service = '0.3.2', confirm) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const received = [];
  server.on('connection', (socket) => {
    const send = (message) => socket.send(JSON.stringify(message));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      received.push(message);
      if (message.type === 'auth' && message.protocolVersion !== 17)
        send({ type: 'connection.error', code: 'version_mismatch', message: '版本不一致' });
      else if (message.type === 'auth') send({ type: 'ready', update: { state: 'idle' } });
      else if (message.type === 'service.update.check')
        send({ type: 'service.update', state: found, latest: '0.3.4' });
      else if (message.type === 'service.update.install') {
        send({ type: 'service.update', state: 'installing', latest: '0.3.4', detail: '安装依赖' });
        send({ type: 'service.update', state: 'restarting', latest: '0.3.4' });
      }
    });
  });
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const updates = [];
  try {
    const result = await upgradeService(
      { url, fingerprint: '', token: 'a'.repeat(32), deviceName: '这台电脑', service },
      { open: () => new WebSocket(url), onUpdate: (update) => updates.push(update.state), confirm },
    ).catch((error) => error);
    return { result, received, updates };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a newer client signs in to an older service with its protocol version and has it upgrade', async () => {
  const { result, received, updates } = await upgrade('available');
  assert.equal(result, '0.3.4');
  assert.deepEqual(
    received.map((message) => [message.type, message.protocolVersion ?? message.version]),
    [
      ['auth', 17],
      ['service.update.check', undefined],
      ['service.update.install', '0.3.4'],
    ],
  );
  assert.deepEqual(updates, ['available', 'installing', 'restarting']);
});

test('a service that cannot upgrade from here says why', async () => {
  const manual = (await upgrade('manual')).result;
  assert.match(failureText(manual), /cc-desk-tunnel upgrade/);
  assert.equal(manual.code, 'manual');
  const idle = (await upgrade('idle')).result;
  assert.match(failureText(idle), /没有找到/);
  assert.equal(idle.code, 'current');
  assert.match(failureText((await upgrade('available', '0.1.0')).result), /太旧/);
});

test('the install waits for a yes, and a no leaves the service as it is', async () => {
  const asked = [];
  const yes = await upgrade('available', '0.3.2', async (latest) => (asked.push(latest), true));
  assert.equal(yes.result, '0.3.4');
  assert.deepEqual(asked, ['0.3.4']);
  const no = await upgrade('available', '0.3.2', async () => false);
  assert.equal(no.result.code, 'declined');
  assert.ok(!no.received.some((message) => message.type === 'service.update.install'));
});

test('a service with sessions at work says so as busy, and a forced upgrade asks it to go past them', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const installs = [];
  server.on('connection', (socket) => {
    const send = (message) => socket.send(JSON.stringify(message));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'auth') send({ type: 'ready', update: { state: 'idle' } });
      else if (message.type === 'service.update.check')
        send({ type: 'service.update', state: 'available', latest: '0.3.16' });
      else if (message.type === 'service.update.install') {
        installs.push(message);
        if (message.force) send({ type: 'service.update', state: 'restarting', latest: '0.3.16' });
        else
          send({
            type: 'response',
            requestId: message.requestId,
            ok: false,
            code: 'native_busy',
            message: '「在回答」正在运行。',
          });
      }
    });
  });
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const config = {
    url,
    fingerprint: '',
    token: 'a'.repeat(32),
    deviceName: '这台电脑',
    service: '0.3.15',
  };
  try {
    const busy = await upgradeService(config, { open: () => new WebSocket(url) }).catch(
      (error) => error,
    );
    assert.equal(busy.code, 'busy');
    assert.match(busy.message, /在回答/);
    const forced = await upgradeService(
      { ...config, force: true },
      { open: () => new WebSocket(url) },
    );
    assert.equal(forced, '0.3.16');
    assert.deepEqual(
      installs.map((message) => message.force),
      [undefined, true],
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// A service that answers a sign-in with `answer`, or not at all; what it was sent is kept.
async function probe(t, answer) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const received = [];
  server.on('connection', (socket) =>
    socket.on('message', (raw) => {
      received.push(JSON.parse(raw.toString()));
      if (answer) socket.send(JSON.stringify(answer));
    }),
  );
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const result = await probeService(
    { url, fingerprint: '', token: 'a'.repeat(32), deviceName: '这台电脑' },
    { open: () => new WebSocket(url), timeoutMs: 300 },
  );
  return { result, received };
}

test('a service is asked at sign-in what it says to this client, and how far it has fetched its installer', async (t) => {
  const preparing = await probe(t, {
    type: 'connection.error',
    code: 'version_mismatch',
    message: '版本不一致',
    service: '9.9.9',
    preparing: { version: '9.9.9', received: 25, size: 100 },
  });
  assert.deepEqual(preparing.result, {
    status: 'refused',
    service: '9.9.9',
    release: null,
    preparing: 0.25,
  });
  assert.deepEqual(preparing.received, [
    {
      type: 'auth',
      protocolVersion: PROTOCOL_VERSION,
      token: 'a'.repeat(32),
      deviceName: '这台电脑',
    },
  ]);
  const held = await probe(t, {
    type: 'connection.error',
    code: 'version_mismatch',
    message: '版本不一致',
    service: '9.9.9',
    client: { version: '9.9.9', size: 1, sha256: '0'.repeat(64) },
  });
  assert.deepEqual(held.result, {
    status: 'refused',
    service: '9.9.9',
    release: '9.9.9',
    preparing: null,
  });
  assert.deepEqual((await probe(t, { type: 'ready' })).result, { status: 'ready' });
  const wrong = await probe(t, {
    type: 'connection.error',
    code: 'unauthorized',
    message: '凭据不对',
  });
  assert.deepEqual(wrong.result, { status: 'failed', error: '凭据不对' });
  assert.deepEqual((await probe(t, null)).result, { status: 'unreachable' });
});
