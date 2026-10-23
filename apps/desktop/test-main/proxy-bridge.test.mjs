import assert from 'node:assert/strict';
import { test } from 'node:test';
import { X509Certificate, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:https';
import {
  certificateMatches,
  connectionWaits,
  controlTlsOptions,
  openProxyBridge,
} from '../electron/proxy-bridge.mjs';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { defaultCertificate } from '../../server/test/fixtures/web-certificates.ts';

test('WSS pin comparison rejects empty, malformed and mismatched fingerprints', () => {
  const pin = Array(32).fill('AB').join(':');
  assert.equal(certificateMatches(pin, pin.toLowerCase().replaceAll(':', '')), true);
  assert.equal(certificateMatches(pin, 'invalid'), false);
  assert.equal(certificateMatches(undefined, pin), false);
  assert.equal(certificateMatches('CD'.repeat(32), pin), false);
  assert.equal(certificateMatches(':'.repeat(64), ':'.repeat(64)), false);
});
test('native desktop refuses plaintext control connections', async () => {
  await assert.rejects(
    openProxyBridge({ url: 'ws://example.com/ws', fingerprint: 'AB'.repeat(32) }, {}),
    /WSS/,
  );
});
test('empty certificate pin enables strict CA verification; malformed pins never disable verification', () => {
  assert.deepEqual(controlTlsOptions({ fingerprint: '' }), { rejectUnauthorized: true });
  assert.deepEqual(controlTlsOptions({}), { rejectUnauthorized: true });
  assert.deepEqual(controlTlsOptions({ fingerprint: 'AB'.repeat(32) }), {
    rejectUnauthorized: false,
  });
  assert.throws(() => controlTlsOptions({ fingerprint: 'invalid' }), /SHA256/);
});
test('local browser test bridge only accepts its explicitly configured origin', async () => {
  const bridge = await openProxyBridge(
    { url: 'wss://127.0.0.1:1/ws', fingerprint: 'AB'.repeat(32) },
    {},
    () => {},
    ['http://127.0.0.1:15873'],
  );
  try {
    const socket = new WebSocket(bridge.url, { origin: 'http://untrusted.example' });
    await assert.rejects(
      new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      }),
      /403/,
    );
  } finally {
    await bridge.close();
  }
});

test('connection waits take the defaults unless given sensible seconds, and the whole outlasts SSH', () => {
  assert.deepEqual(connectionWaits(undefined), { connect: 15000, ssh: 10000, ready: 45000 });
  assert.deepEqual(connectionWaits({ connect: 4, ssh: '30', ready: 601 }), {
    connect: 15000,
    ssh: 10000,
    ready: 45000,
  });
  assert.deepEqual(connectionWaits({ connect: 30, ssh: 40, ready: 50 }), {
    connect: 30000,
    ssh: 40000,
    ready: 75000,
  });
});

test('the main-process bridge tracks only active Passkey registration URLs', async (t) => {
  const server = createServer(defaultCertificate);
  const service = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let remote;
  const received = new Promise((resolve) => {
    service.on('connection', (ws) => {
      remote = ws;
      ws.once('message', (raw) => {
        resolve(JSON.parse(raw.toString()));
        ws.send(
          JSON.stringify({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            version: '0.3.6',
            connectionId: randomUUID(),
            adapter: 'simulation',
            sessions: [],
          }),
        );
      });
    });
  });
  const secret = 'registration-test-service-' + randomUUID();
  const bridge = await openProxyBridge(
    {
      url: `wss://127.0.0.1:${server.address().port}/ws`,
      fingerprint: new X509Certificate(defaultCertificate.cert).fingerprint256,
    },
    {},
  );
  t.after(async () => {
    await bridge.close();
    for (const ws of service.clients) ws.terminate();
    service.close();
    server.close();
  });
  const renderer = new WebSocket(bridge.url);
  await once(renderer, 'open');
  const reply = once(renderer, 'message');
  renderer.send(
    JSON.stringify({
      type: 'auth',
      protocolVersion: PROTOCOL_VERSION,
      token: secret,
      deviceName: 'Desk',
    }),
  );
  assert.deepEqual(await received, {
    type: 'auth',
    protocolVersion: PROTOCOL_VERSION,
    deviceName: 'Desk',
    tunnel: true,
    token: secret,
  });
  const ready = (await reply)[0].toString();
  assert.equal(ready.includes(secret), false);
  assert.equal(JSON.parse(ready).type, 'ready');
  // Only the active server registration is available to the main process's external-link allowlist.
  const registrationId = randomUUID();
  const registrationUrl = 'https://web.example.test/private/#passkey-register=grant';
  const announce = async (expiresAt, status = 'pending') => {
    const seen = once(renderer, 'message', { signal: AbortSignal.timeout(2000) });
    remote.send(
      JSON.stringify({
        type: 'web.passkey.registration',
        requestId: randomUUID(),
        registrationId,
        status,
        expiresAt,
        url: registrationUrl,
      }),
    );
    await seen.catch(() => assert.fail(`Missing ${status} registration reply`));
  };
  await announce(new Date(Date.now() + 60000).toISOString());
  assert.equal(bridge.registrationUrl(), registrationUrl);
  const status = once(renderer, 'message', { signal: AbortSignal.timeout(2000) });
  remote.send(
    JSON.stringify({
      type: 'web.passkey.registration',
      requestId: randomUUID(),
      registrationId,
      status: 'pending',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
  );
  await status;
  assert.equal(bridge.registrationUrl(), registrationUrl);
  const cancelled = once(remote, 'message', { signal: AbortSignal.timeout(2000) });
  renderer.send(
    JSON.stringify({ type: 'web.passkeys.cancel', requestId: randomUUID(), registrationId }),
  );
  await cancelled.catch(() => assert.fail('Missing registration cancellation frame'));
  assert.equal(bridge.registrationUrl(), null);
  await announce(new Date(Date.now() - 1000).toISOString());
  assert.equal(bridge.registrationUrl(), null);
  await announce(new Date(Date.now() + 60000).toISOString());
  await announce(new Date(Date.now() + 60000).toISOString(), 'complete');
  assert.equal(bridge.registrationUrl(), null);
});
