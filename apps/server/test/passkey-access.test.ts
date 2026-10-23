import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTlsServer, request as tlsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type { WebCommand } from '@cc-desk-tunnel/protocol';
import { WebAccess } from '../src/web-access.ts';
import { authenticator } from './fixtures/passkey.ts';
import { ca, custom, defaultCertificate } from './fixtures/web-certificates.ts';

const origin = 'https://web.example.test';
const token = 'passkey-test-service-' + randomUUID();
async function fixture(t: TestContext, proxy?: 'http' | 'https') {
  const directory = mkdtempSync(join(tmpdir(), 'cc-passkey-access-'));
  writeFileSync(join(directory, 'index.html'), '<!doctype html><title>Workbench</title>');
  const database = new DatabaseSync(':memory:');
  const options = {
    database,
    token,
    directory,
    dataDir: directory,
    reverseProxy: proxy !== 'https',
    tls: proxy === 'https' ? defaultCertificate : undefined,
  };
  let web = new WebAccess(options);
  const context = {
    desktop: true,
    address: '127.0.0.1',
    connectionId: randomUUID(),
  };
  let proxied = !proxy;
  const execute = (command: Omit<WebCommand, 'requestId'> | object, next = context) =>
    web.execute({ requestId: randomUUID(), ...command } as WebCommand, next);
  const prefix = proxy ? '/private' : '';
  execute({
    type: 'web.settings.update',
    values: { enabled: true, path: prefix.slice(1) },
  });
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (proxy) {
      // Match the server's connection context using the actual upstream request, not a test boolean.
      context.address = web.address(req);
      proxied = web.proxied(req);
    }
    void web.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  };
  const server =
    proxy === 'https' ? createTlsServer(defaultCertificate, handle) : createServer(handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const upstreamTls = { ca: defaultCertificate.cert, servername: 'default.example.test' };
  const gateway = proxy
    ? createTlsServer(custom, (req, res) => {
        const upstream = (proxy === 'https' ? tlsRequest : request)(
          {
            hostname: '127.0.0.1',
            port,
            path: req.url,
            method: req.method,
            ...(proxy === 'https' ? upstreamTls : {}),
            headers: { ...req.headers, 'x-real-ip': req.socket.remoteAddress! },
          },
          (response) => {
            res.writeHead(response.statusCode!, response.headers);
            response.pipe(res);
          },
        );
        upstream.on('error', (error) => res.writeHead(502).end(error.message));
        req.pipe(upstream);
      })
    : undefined;
  let publicPort = port;
  if (gateway) {
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const address = gateway.address();
    assert.ok(address && typeof address !== 'string');
    publicPort = address.port;
  }
  const entryOrigin = proxy ? `${origin}:${publicPort}` : origin;
  execute({ type: 'web.settings.update', values: { publicOrigin: entryOrigin } });
  t.after(async () => {
    web.close();
    if (gateway) {
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function http(
    path: string,
    body?: object,
    cookie?: string,
    headers: Record<string, string> = {},
    direct = false,
  ) {
    return new Promise<{ status: number; data: any; cookie?: string }>((resolve, reject) => {
      const secure = !!proxy && (!direct || proxy === 'https');
      const req = (secure ? tlsRequest : request)(
        {
          hostname: '127.0.0.1',
          port: direct ? port : publicPort,
          ...(secure ? (direct ? upstreamTls : { ca, servername: 'web.example.test' }) : {}),
          path,
          method: body ? 'POST' : 'GET',
          headers: {
            Host: new URL(entryOrigin).host,
            Origin: entryOrigin,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (part) => {
            text += part;
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
  const api = (route: string, body: object = {}, cookie?: string) =>
    http(prefix + '/api/passkey/' + route, body, cookie);
  async function slow(route: string, body: object, change: () => void) {
    const received = once(server, 'request');
    const payload = JSON.stringify(body);
    let req: ReturnType<typeof request>;
    const response = new Promise<{ status: number; data: any }>((resolve, reject) => {
      req = request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/passkey/' + route,
          method: 'POST',
          headers: {
            Host: 'web.example.test',
            Origin: origin,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(text) }));
        },
      );
      req.on('error', reject);
      req.flushHeaders();
    });
    await received;
    change();
    req!.end(payload);
    return response;
  }
  async function register() {
    if (proxy) await http(prefix + '/api/session');
    const device = authenticator('web.example.test', entryOrigin);
    const pending = execute({ type: 'web.passkeys.start', name: '工作电脑' });
    assert.equal(pending.type, 'web.passkey.registration');
    const grant = new URL(pending.url!).hash.split('=')[1];
    const options = await api('register/options', { grant });
    assert.equal(options.status, 200);
    const registered = await api('register/verify', {
      challengeId: options.data.challengeId,
      response: device.register(options.data.options.challenge),
    });
    assert.equal(registered.status, 200);
    return { device, id: registered.data.id as string, url: pending.url! };
  }
  async function login(device: ReturnType<typeof authenticator>, path = prefix) {
    const options = await http(path + '/api/passkey/login/options', {});
    assert.equal(options.status, 200);
    const signedIn = await http(path + '/api/passkey/login/verify', {
      challengeId: options.data.challengeId,
      response: device.authenticate(options.data.options.challenge),
    });
    assert.equal(signedIn.status, 200);
    return signedIn;
  }
  return {
    web: () => web,
    execute,
    context,
    proxied: () => proxied,
    origin: entryOrigin,
    prefix,
    api,
    slow,
    http,
    database,
    register,
    login,
    rotate: () => {
      web.close();
      web = new WebAccess({ ...options, token: token + '-rotated' });
    },
  };
}

test('Passkey registration/login/proof uses browser cookies and deleting a key preserves credential logins', async (t) => {
  const f = await fixture(t);
  const { device, id } = await f.register();
  const signedIn = await f.login(device);
  assert.equal(signedIn.data.authenticated, true);
  const credentialLogin = await f.http('/api/login', { password: token });
  assert.equal(credentialLogin.status, 200);
  assert.notEqual(credentialLogin.cookie, signedIn.cookie);
  const sessions = f.web().state().sessions;
  assert.equal(sessions.length, 2);
  const stored = f.database
    .prepare('SELECT secret_hash, passkey_id FROM web_sessions WHERE id = ?')
    .get(signedIn.data.session.id)!;
  assert.equal(stored.passkey_id, id);
  assert.notEqual(stored.secret_hash, signedIn.cookie!.split('=')[1]);
  assert.equal(JSON.stringify(sessions).includes(token), false);

  const proofOptions = await f.api('proof/options', {}, signedIn.cookie);
  const proof = await f.api(
    'proof/verify',
    {
      challengeId: proofOptions.data.challengeId,
      response: device.authenticate(proofOptions.data.options.challenge),
    },
    signedIn.cookie,
  );
  assert.equal(proof.status, 200);
  const context = { ...f.context, desktop: false, sessionId: signedIn.data.session.id };
  f.execute(
    {
      type: 'web.passkeys.rename',
      passkeyId: id,
      name: '已改名',
      proof: { passkey: proof.data.proof },
    },
    context,
  );
  assert.equal(f.web().state().passkeys[0].name, '已改名');
  assert.throws(() =>
    f.execute(
      {
        type: 'web.passkeys.rename',
        passkeyId: id,
        name: '重放',
        proof: { passkey: proof.data.proof },
      },
      context,
    ),
  );
  assert.throws(() => f.execute({ type: 'web.passkeys.remove', passkeyId: id }, context));
  f.execute({ type: 'web.passkeys.remove', passkeyId: id });
  assert.equal(f.web().state().sessions.length, 1);
  assert.equal(
    (await f.http('/api/session', undefined, signedIn.cookie)).data.authenticated,
    false,
  );
  assert.equal(
    (await f.http('/api/session', undefined, credentialLogin.cookie)).data.authenticated,
    true,
  );
});

test('Web disable closes browser access but keeps Passkey management available to the authenticated desktop', async (t) => {
  const f = await fixture(t);
  const { device, id } = await f.register();
  const signedIn = await f.login(device);
  f.execute({ type: 'web.settings.update', values: { enabled: false } });
  assert.equal((await f.api('login/options')).status, 404);
  assert.equal(f.web().active(signedIn.data.session.id), false);
  assert.equal(f.web().state().passkeys.length, 1);
  assert.equal(f.web().state().passkeyAvailable, false);
  f.execute({ type: 'web.passkeys.rename', passkeyId: id, name: '关闭后管理' });
  assert.equal(f.web().state().passkeys[0].name, '关闭后管理');
  f.execute({ type: 'web.settings.update', values: { enabled: true } });
  assert.equal(f.web().state().passkeyAvailable, true);
});

test('path changes keep keys but end browser sessions; domain changes revoke key sessions; token rotation removes keys', async (t) => {
  const f = await fixture(t);
  const { device } = await f.register();
  const signedIn = await f.login(device);
  const pending = f.execute({ type: 'web.passkeys.start', name: '未完成' });
  assert.equal(pending.type, 'web.passkey.registration');
  f.execute({ type: 'web.settings.update', values: { path: 'entry' } });
  assert.equal(f.web().active(signedIn.data.session.id), false);
  assert.equal(f.web().state().passkeys[0].available, true);
  assert.equal(
    f.web().passkeys.status(pending.registrationId, f.context.connectionId).status,
    'expired',
  );
  const moved = await f.login(device, '/entry');
  f.execute({
    type: 'web.settings.update',
    values: { publicOrigin: 'https://other.example.test' },
  });
  assert.equal(f.web().active(moved.data.session.id), false);
  assert.equal(f.web().state().passkeys[0].available, false);
  f.rotate();
  assert.equal(f.web().state().passkeys.length, 0);
});

test('changing only the public port revokes sessions and ceremonies while preserving keys for the same RP', async (t) => {
  const f = await fixture(t);
  const { device } = await f.register();
  const signedIn = await f.login(device);
  const credential = await f.http('/api/login', { password: token });
  const pending = f.execute({ type: 'web.passkeys.start', name: '旧端口注册' });
  assert.equal(pending.type, 'web.passkey.registration');
  const options = await f.api('login/options');
  f.execute({ type: 'web.settings.update', values: { publicOrigin: origin + ':1443' } });
  assert.equal(f.web().active(signedIn.data.session.id), false);
  assert.equal(f.web().active(credential.data.session.id), false);
  assert.equal(
    f.web().passkeys.status(pending.registrationId, f.context.connectionId).status,
    'expired',
  );
  assert.equal(f.web().state().passkeys[0].available, true);
  assert.equal((await f.api('login/options')).status, 404);
  const stale = await f.http(
    '/api/passkey/login/verify',
    {
      challengeId: options.data.challengeId,
      response: device.authenticate(options.data.options.challenge),
    },
    undefined,
    { Host: 'web.example.test:1443', Origin: origin + ':1443' },
  );
  assert.equal(stale.status, 400);
  assert.equal(stale.data.code, 'passkey_expired');
});

test('ceremonies reject foreign origins and IP Host, and registration requires an owner', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.http('/api/passkey/login/options', {}, undefined, {
        Origin: 'https://attacker.example',
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.http('/api/passkey/login/options', {}, undefined, { Host: '127.0.0.1' })).status,
    404,
  );
  assert.equal(f.web().state().passkeyAvailable, true);
  assert.throws(() =>
    f.execute({ type: 'web.passkeys.start', name: '缺少所有者' }, {
      desktop: true,
      address: '127.0.0.1',
    } as typeof f.context),
  );
});

for (const upstream of ['http', 'https'] as const) {
  test(`a real HTTPS gateway preserves Web Passkey origin and path over ${upstream.toUpperCase()} upstream`, async (t) => {
    const f = await fixture(t, upstream);
    const forged = {
      'X-Real-IP': '192.0.2.10',
      'X-Forwarded-Host': new URL(f.origin).host,
      'X-Forwarded-Proto': 'https',
      Forwarded: `for=192.0.2.10;host="${new URL(f.origin).host}";proto=https`,
    };
    if (upstream === 'https') {
      f.execute({
        type: 'web.settings.update',
        values: { proxyEnabled: true, trustedProxies: ['192.0.2.10'] },
      });
      const untrusted = await f.http(f.prefix + '/api/session', undefined, undefined, forged, true);
      assert.equal(Object.hasOwn(untrusted.data, 'selfSigned'), false);
      assert.equal(untrusted.data.passkeyAvailable, false);
      assert.equal(f.proxied(), false);
      assert.equal(f.context.address, '127.0.0.1', 'X-Real-IP cannot impersonate a trusted source');
      const started = f.execute({ type: 'web.passkeys.start', name: '独立公开入口' });
      assert.equal(started.type, 'web.passkey.registration');
      assert.equal(new URL(started.url!).origin, f.origin);
      const options = await f.api('register/options', {
        grant: new URL(started.url!).hash.split('=')[1],
      });
      assert.equal(options.status, 200);
      f.execute({
        type: 'web.settings.update',
        values: { trustedProxies: ['127.0.0.1'] },
      });
    }
    const session = await f.http(f.prefix + '/api/session');
    assert.equal(Object.hasOwn(session.data, 'selfSigned'), false);
    assert.equal(f.proxied(), true, 'trust is derived from the real upstream socket');
    const { device, id, url } = await f.register();
    assert.equal(new URL(url).origin, f.origin);
    assert.equal(new URL(url).pathname, '/private/');
    assert.equal(
      f
        .web()
        .passkeys.list('web.example.test')
        .find((key) => key.id === id)?.rpId,
      'web.example.test',
    );

    const endpoint = f.prefix + '/api/passkey/login/options';
    assert.equal(
      (await f.http(endpoint, {}, undefined, { ...forged, Host: '127.0.0.1' })).status,
      404,
    );
    assert.equal(
      (await f.http(endpoint, {}, undefined, { ...forged, Origin: 'https://attacker.example' }))
        .status,
      403,
    );
    assert.equal(
      (await f.http(endpoint, {}, undefined, { Host: 'web.example.test' })).status,
      404,
      'dropping the external port changes the configured origin',
    );
    assert.equal((await f.http('/api/passkey/login/options', {})).status, 404);

    const options = await f.http(endpoint, {}, undefined, {
      'X-Forwarded-Host': 'attacker.example',
      'X-Forwarded-Proto': 'http',
      Forwarded: 'host=attacker.example;proto=http',
    });
    assert.equal(options.status, 200, 'forwarded host/proto cannot replace the actual public Host');
    const login = await f.api('login/verify', {
      challengeId: options.data.challengeId,
      response: device.authenticate(options.data.options.challenge),
    });
    assert.equal(login.data.authenticated, true);
    assert.equal(login.data.url, f.origin + '/private/');
  });
}

test('changing the entry while an HTTP body is arriving prevents a challenge under stale routing', async (t) => {
  const f = await fixture(t);
  await f.register();
  const response = await f.slow('login/options', {}, () =>
    f.execute({ type: 'web.settings.update', values: { path: 'changed' } }),
  );
  assert.equal(response.status, 400);
  assert.equal(response.data.code, 'passkey_expired');
  assert.equal(f.web().state().sessions.length, 0);
});

test('serial issuance is throttled without blocking an issued verification or browser logout', async (t) => {
  const f = await fixture(t);
  const { device } = await f.register();
  let options: any;
  for (let index = 0; index < 11; index++) {
    const response = await f.api('login/options');
    assert.equal(response.status, 200);
    options = response.data;
  }
  assert.equal((await f.api('login/options')).status, 429);
  const signedIn = await f.api('login/verify', {
    challengeId: options.challengeId,
    response: device.authenticate(options.options.challenge),
  });
  assert.equal(signedIn.status, 200);
  assert.equal((await f.http('/api/logout', {}, signedIn.cookie)).status, 200);
  assert.equal(f.web().state().sessions.length, 0);
});
