import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { ProxyClient } from '../src/client.ts';
import { hostCapabilities } from '../src/host-capabilities.ts';
import { browserEndpoint, browserSocket } from '../src/browser-api.ts';

function fixture(t) {
  const original = { WebSocket: globalThis.WebSocket, location: globalThis.location };
  globalThis.location = new URL('https://work.example.com/entry/');
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() {
      Socket.current = this;
    }
    send(raw) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.onclose?.({ code: 1000 });
    }
    message(value) {
      this.onmessage({ data: JSON.stringify(value) });
    }
  }
  globalThis.WebSocket = Socket;
  let expired = 0;
  const client = new ProxyClient();
  client.connectBrowser(browserSocket(), () => expired++);
  const socket = Socket.current;
  socket.onopen();
  const browser = { sessionId: randomUUID(), serverDeviceId: randomUUID() };
  socket.message({
    type: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    version: '0.3.4',
    connectionId: randomUUID(),
    adapter: 'claude-code',
    sessions: [],
    browser,
  });
  t.after(() => {
    client.disconnect();
    Object.assign(globalThis, original);
  });
  return { client, socket, browser, expired: () => expired };
}

test('browser transport uses same-origin cookie authentication and never introduces a device or leave frame', (t) => {
  const { client, socket, browser } = fixture(t);
  assert.equal(browserEndpoint('session').href, 'https://work.example.com/entry/api/session');
  assert.deepEqual(socket.sent, [{ type: 'web.auth', protocolVersion: PROTOCOL_VERSION }]);
  assert.equal(client.state.device, null);
  assert.deepEqual(client.state.browser, browser);
  assert.equal(client.credentials.reconnect, true);
  assert.throws(() => client.connectBrowser('wss://elsewhere.example.com/entry/api/ws', () => {}));
  assert.throws(() => client.connectBrowser('ws://work.example.com/entry/api/ws', () => {}));
  client.disconnect();
  assert.equal(socket.sent.length, 1);
});

test('revocation ends browser reconnect and reports expiry; settings data remains request-local', async (t) => {
  const { client, socket, expired } = fixture(t);
  const pending = client.fetch({ type: 'web.settings.get' });
  const request = socket.sent.at(-1);
  const values = {
    enabled: true,
    domain: '',
    publicOrigin: '',
    path: 'entry',
    idleMinutes: 120,
    proxyEnabled: false,
    trustedProxies: [],
    totpEnabled: false,
    sessions: [],
    passkeys: [],
    passkeyAvailable: false,
  };
  socket.message({ type: 'web.settings.state', requestId: request.requestId, values });
  socket.message({ type: 'response', requestId: request.requestId, ok: true });
  assert.deepEqual((await pending).values, values);
  assert.equal('webSettings' in client.state, false);
  assert.equal('web' in client.state, false);
  socket.onclose({ code: 4001 });
  assert.equal(expired(), 1);
  assert.equal(client.state.status, 'disconnected');
  assert.equal(client.retryTimer, undefined);
});

test('browser capabilities exclude local-only features without changing desktop capabilities', () => {
  assert.ok(Object.values(hostCapabilities(false)).every(Boolean));
  assert.ok(Object.values(hostCapabilities(true)).every((value) => !value));
});

test('a connected browser tells the service its user is active; a desktop or a closed socket does not', (t) => {
  const { client, socket } = fixture(t);
  assert.equal(client.markActive(), true);
  assert.deepEqual(socket.sent.at(-1), { type: 'web.activity' });
  const sent = socket.sent.length;
  client.update({ browser: null });
  assert.equal(client.markActive(), false);
  socket.readyState = 3;
  assert.equal(client.markActive(), false);
  assert.equal(socket.sent.length, sent);
});

test('a browser reconnect probes cookies before the handshake, distinguishes offline, and ignores a late probe after disconnect', async (t) => {
  const { client, socket, expired } = fixture(t);
  let answer = 'offline';
  let probes = 0;
  client.credentials.validate = async () => {
    probes++;
    if (answer === 'offline') throw new Error('offline');
    return answer === 'authenticated';
  };
  socket.onclose({ code: 1006 });
  client.retryNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 1);
  assert.equal(client.state.status, 'reconnecting');
  assert.equal(expired(), 0);
  answer = 'expired';
  client.retryNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 2);
  assert.equal(expired(), 1);
  assert.equal(client.state.status, 'disconnected');
  let resolve;
  client.connectBrowser(
    browserSocket(),
    () => assert.fail('late expiry'),
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  client.disconnect();
  resolve(false);
  await new Promise((done) => setImmediate(done));
  assert.equal(client.socket, null);
});

for (const end of ['failed', 'disconnected', 'timeout'])
  test(`request-local TOTP setup secrets are discarded when the response is ${end}`, async (t) => {
    if (end === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client, socket } = fixture(t);
    const pending = client.fetch({
      type: 'web.totp.setup',
      proof: { password: 'fixture-password' },
    });
    const { requestId } = socket.sent.at(-1);
    socket.message({
      type: 'web.totp.setup',
      requestId,
      secret: 'FIXTURESECRET',
      uri: 'otpauth://totp/test?secret=FIXTURESECRET',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    });
    assert.equal(client.results.size, 1);
    if (end === 'failed')
      socket.message({ type: 'response', requestId, ok: false, message: 'test failure' });
    else if (end === 'disconnected') client.disconnect();
    else t.mock.timers.tick(10000);
    await assert.rejects(pending);
    assert.equal(client.results.size, 0);
  });

test('disconnect cleanup does not discard a successful response awaiting its promise continuation', async (t) => {
  const { client, socket } = fixture(t);
  const pending = client.fetch({ type: 'web.totp.setup', proof: { password: 'fixture-password' } });
  const { requestId } = socket.sent.at(-1);
  socket.message({
    type: 'web.totp.setup',
    requestId,
    secret: 'FIXTURESECRET',
    uri: 'otpauth://totp/test?secret=FIXTURESECRET',
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  socket.message({ type: 'response', requestId, ok: true });
  client.disconnect();
  assert.equal((await pending).secret, 'FIXTURESECRET');
  assert.equal(client.results.size, 0);
});

test('Passkey registration URLs stay request-local and are discarded after a failed response', async (t) => {
  const { client, socket } = fixture(t);
  const pending = client.fetch({
    type: 'web.passkeys.start',
    name: 'Test key',
    proof: { password: 'fixture-password' },
  });
  const { requestId } = socket.sent.at(-1);
  const registration = {
    type: 'web.passkey.registration',
    requestId,
    registrationId: randomUUID(),
    status: 'pending',
    url: 'https://work.example.com/entry/#passkey-register=test-only-grant',
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  };
  socket.message(registration);
  assert.equal(client.results.size, 1);
  assert.equal(JSON.stringify(client.state).includes('test-only-grant'), false);
  socket.message({ type: 'response', requestId, ok: false, message: 'test failure' });
  await assert.rejects(pending);
  assert.equal(client.results.size, 0);
  socket.message(registration);
  assert.equal(client.results.size, 0);
});
