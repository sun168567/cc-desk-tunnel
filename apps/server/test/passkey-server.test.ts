import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  serverMessageSchema,
  type ServerMessage,
} from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../src/server.ts';
import { authenticator } from './fixtures/passkey.ts';
import { ca, custom, defaultCertificate } from './fixtures/web-certificates.ts';

const token = 'passkey-ws-service-' + randomUUID();
async function serverFixture(t: TestContext, selfSigned = false) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-passkey-server-'));
  writeFileSync(join(directory, 'index.html'), '<!doctype html>Workbench');
  const certificate = selfSigned ? defaultCertificate : custom;
  const tlsOptions = {
    ca: selfSigned ? defaultCertificate.cert : ca,
    servername: selfSigned ? 'default.example.test' : 'web.example.test',
  };
  const server = createProxyServer({
    token,
    dataDir: directory,
    webDirectory: directory,
    tls: { cert: Buffer.from(certificate.cert), key: Buffer.from(certificate.key) },
  });
  const url = new URL(await server.listen(0));
  const origin = `https://web.example.test:${url.port}`;
  const clients: WebSocket[] = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function client(frame: object, headers: Record<string, string> = {}, browser = false) {
    const socket = new WebSocket(`wss://127.0.0.1:${url.port}${browser ? '/api/ws' : '/ws'}`, {
      ...tlsOptions,
      ...(browser ? { origin } : {}),
      headers: { Host: `web.example.test:${url.port}`, ...headers },
    });
    clients.push(socket);
    const messages: ServerMessage[] = [];
    let browserMetadata: object | undefined;
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'ready') browserMetadata = message.browser;
      messages.push(serverMessageSchema.parse(message));
    });
    const wait = async (predicate: (message: ServerMessage) => boolean) => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('Missing server message: ' + JSON.stringify(messages));
    };
    await once(socket, 'open');
    socket.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        ...(browser ? {} : { deviceName: '桌面' }),
        ...frame,
      }),
    );
    const first = await wait(
      (message) => message.type === 'ready' || message.type === 'connection.error',
    );
    return {
      socket,
      first,
      browserMetadata,
      request: async (command: object) => {
        const requestId = randomUUID();
        socket.send(JSON.stringify({ ...command, requestId }));
        return wait((message) => 'requestId' in message && message.requestId === requestId);
      },
    };
  }
  async function http(path: string, body?: object, authorization?: string, cookie?: string) {
    return new Promise<{ status: number; data: any; cookie?: string }>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: Number(url.port),
          path,
          ...tlsOptions,
          method: body ? 'POST' : 'GET',
          headers: {
            Host: `web.example.test:${url.port}`,
            Origin: origin,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(authorization ? { Authorization: authorization } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              data: text ? JSON.parse(text) : undefined,
              cookie: res.headers['set-cookie']?.[0]?.split(';')[0],
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  const api = (path: string, body: object, cookie?: string) =>
    http('/api/passkey/' + path, body, undefined, cookie);
  const admin = await client({ type: 'auth', token });
  assert.equal(admin.first.type, 'ready');
  await admin.request({
    type: 'web.settings.update',
    values: { enabled: true, publicOrigin: origin },
  });
  return { admin, client, http, api, origin };
}

async function fixture(t: TestContext) {
  const f = await serverFixture(t);
  const { admin, api, origin } = f;
  const pending = await admin.request({ type: 'web.passkeys.start', name: '登录密钥' });
  assert.equal(pending.type, 'web.passkey.registration');
  const options = await api('register/options', {
    grant: new URL(pending.url!).hash.split('=')[1],
  });
  const device = authenticator('web.example.test', origin);
  const registered = await api('register/verify', {
    challengeId: options.data.challengeId,
    response: device.register(options.data.options.challenge),
  });
  assert.equal(registered.status, 200);
  const login = await api('login/options', {});
  const signedIn = await api('login/verify', {
    challengeId: login.data.challengeId,
    response: device.authenticate(login.data.options.challenge),
  });
  assert.equal(signedIn.status, 200);
  assert.ok(signedIn.cookie);
  return {
    ...f,
    cookie: signedIn.cookie,
    sessionId: signedIn.data.session.id,
    passkeyId: registered.data.id,
    device,
  };
}

test('the configured public origin remains independent of desktop TLS and proxy trust', async (t) => {
  const f = await serverFixture(t, true);
  const peer = await f.client(
    { type: 'auth', token },
    { Host: '192.0.2.100:8787', 'X-Real-IP': '192.0.2.10', 'X-Forwarded-For': '192.0.2.10' },
  );
  assert.equal(peer.first.type, 'ready');
  async function trust(values: object) {
    const reply = await peer.request({ type: 'web.settings.update', values });
    assert.equal(reply.type, 'web.settings.state');
    assert.equal(
      reply.values.passkeyAvailable,
      true,
      'the configured public entry does not depend on how the desktop connected',
    );
    assert.equal(Object.hasOwn(reply.values, 'selfSigned'), false);
    const certificate = await peer.request({ type: 'web.certificate.get' });
    assert.equal(certificate.type, 'web.certificate.state');
    assert.equal(certificate.selfSigned, true);
    const state = await peer.request({ type: 'web.settings.get' });
    assert.equal(state.type, 'web.settings.state');
    assert.equal(state.values.passkeyAvailable, true);
    assert.equal(state.values.url, f.origin + '/');
    const registration = await peer.request({ type: 'web.passkeys.start', name: '动态代理信任' });
    assert.equal(registration.type, 'web.passkey.registration');
    assert.equal(new URL(registration.url!).origin, f.origin);
    assert.equal(peer.socket.readyState, WebSocket.OPEN);
  }
  await trust({ proxyEnabled: true, trustedProxies: ['192.0.2.10'] });
  await trust({ trustedProxies: ['127.0.0.1'] });
  await trust({ proxyEnabled: false });
  await trust({ proxyEnabled: true });
  await trust({ trustedProxies: ['192.0.2.10'] });
});

test('a service-credential desktop manages Web Passkeys and revoking one closes only its browser connection', async (t) => {
  const f = await fixture(t);
  const browser = await f.client({ type: 'web.auth' }, { Cookie: f.cookie }, true);
  assert.equal(browser.first.type, 'ready');
  assert.deepEqual(browser.browserMetadata, {
    sessionId: f.sessionId,
    serverDeviceId: browser.first.browser?.serverDeviceId,
  });
  const state = await browser.request({ type: 'web.settings.get' });
  assert.equal(state.type, 'web.settings.state');
  assert.equal(state.values.sessions[0].id, f.sessionId);
  const denied = await browser.request({
    type: 'web.passkeys.rename',
    passkeyId: f.passkeyId,
    name: '缺少验证',
  });
  assert.equal(denied.type, 'response');
  assert.equal(denied.ok, false);
  const options = await f.api('proof/options', {}, f.cookie);
  const proof = await f.api(
    'proof/verify',
    {
      challengeId: options.data.challengeId,
      response: f.device.authenticate(options.data.options.challenge),
    },
    f.cookie,
  );
  assert.equal(proof.status, 200);
  const renamed = await browser.request({
    type: 'web.passkeys.rename',
    passkeyId: f.passkeyId,
    name: '浏览器已验证',
    proof: { passkey: proof.data.proof },
  });
  assert.equal(renamed.type, 'web.settings.state');
  assert.equal(renamed.values.passkeys[0].name, '浏览器已验证');
  const closed = once(browser.socket, 'close');
  await f.admin.request({ type: 'web.passkeys.remove', passkeyId: f.passkeyId });
  assert.equal((await closed)[0], 4001);
  assert.equal(f.admin.socket.readyState, WebSocket.OPEN);
  await f.admin.request({ type: 'web.settings.update', values: { enabled: false } });
  assert.equal((await f.api('login/options', {})).status, 404);
  const reconnected = await f.client({ type: 'auth', token });
  assert.equal(reconnected.first.type, 'ready');
  const created = await reconnected.request({ type: 'server.session.create', title: '服务端会话' });
  assert.equal(created.type, 'response');
  assert.equal(created.ok, true);
});

test('browser cookies never replace the desktop service credential or authorize installer downloads', async (t) => {
  const f = await fixture(t);
  const secret = f.cookie.split('=')[1];
  const wrong = await f.client({ type: 'auth', token: secret });
  assert.equal(wrong.first.type, 'connection.error');
  // No installer is configured: the actual service credential passes auth and reaches 404.
  assert.equal((await f.http('/client/installer', undefined, `Bearer ${token}`)).status, 404);
  assert.equal((await f.http('/client/installer', undefined, `Bearer ${secret}`)).status, 401);
  assert.equal((await f.http('/client/installer', undefined, undefined, f.cookie)).status, 401);
  assert.equal((await f.http('/api/login', { password: secret })).status, 401);
});

test('a browser registration grant belongs to the initiating desktop connection and expires when it closes', async (t) => {
  const f = await serverFixture(t);
  const registration = await f.admin.request({ type: 'web.passkeys.start', name: '新浏览器' });
  assert.equal(registration.type, 'web.passkey.registration');
  const other = await f.client({ type: 'auth', token });
  const foreign = await other.request({
    type: 'web.passkeys.status',
    registrationId: registration.registrationId,
  });
  assert.equal(foreign.type, 'web.passkey.registration');
  assert.equal(foreign.status, 'expired');
  const closed = once(f.admin.socket, 'close');
  f.admin.socket.close();
  await closed;
  const options = await f.api('register/options', {
    grant: new URL(registration.url!).hash.split('=')[1],
  });
  assert.equal(options.status, 400);
  assert.equal(options.data.code, 'passkey_expired');
});
