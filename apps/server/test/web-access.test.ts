import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import type { WebCommand, WebSettingsState, WebTotpSetup } from '@cc-desk-tunnel/protocol';
import { WebAccess, webStaticPath, type WebContext } from '../src/web-access.ts';
import { custom, defaultCertificate } from './fixtures/web-certificates.ts';
import { totp, totpSecret } from '../src/web-totp.ts';

const password = 'test-web-service-token-' + randomUUID();
const proof = { password };
const context = { desktop: true, address: '127.0.0.1' };

test('static real paths cannot escape to a sibling or another Windows volume', () => {
  const root = join(tmpdir(), 'cc-web-static');
  assert.equal(webStaticPath(root, join(root, 'assets', 'app.js')), true);
  assert.equal(webStaticPath(root, join(root, '..', 'cc-web-static-other', 'secret')), false);
  assert.equal(webStaticPath(root, join(root, '..')), false);
  if (process.platform === 'win32') {
    assert.equal(webStaticPath('C:\\public', 'D:\\secret.txt'), false);
    assert.equal(webStaticPath('C:\\public', '\\\\server\\share\\secret.txt'), false);
  }
});

async function fixture(t: TestContext, tls = false) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-web-'));
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'index.html'), '<!doctype html><h1>Shared workbench</h1>');
  writeFileSync(join(directory, 'assets', 'app.js'), 'console.log("shared");');
  writeFileSync(join(directory, 'assets', 'app.js.map'), '{}');
  const database = new DatabaseSync(':memory:');
  let now = Date.UTC(2026, 0, 1);
  const options = {
    database,
    token: password,
    directory,
    dataDir: directory,
    tls: tls ? defaultCertificate : undefined,
    host: '127.0.0.1',
    now: () => now,
  };
  let web = new WebAccess(options);
  const server = createServer(
    (req, res) =>
      void web.handle(req, res).then((handled) => {
        if (!handled) res.writeHead(404).end();
      }),
  );
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const session = web.matchesUpgrade(req) && web.authenticate(req);
    if (!session) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => web.attach(session.id, ws));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `${tls ? 'https' : 'http'}://127.0.0.1:${address.port}`;
  t.after(async () => {
    web.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const http = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    method = body === undefined ? 'GET' : 'POST',
  ) =>
    new Promise<{
      status: number;
      headers: import('node:http').IncomingHttpHeaders;
      text: string;
      data: any;
      cookie?: string;
    }>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path,
          method,
          headers: {
            Origin: origin,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            let data;
            try {
              data = JSON.parse(text);
            } catch {}
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              text,
              data,
              cookie: res.headers['set-cookie']?.[0]?.split(';')[0],
            });
          });
        },
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const command = (value: object, custom: WebContext = context) => {
    const reply = web.execute({ ...value, requestId: randomUUID() } as WebCommand, custom);
    return reply.type === 'web.settings.state' ? reply.values : reply;
  };
  return {
    get web() {
      return web;
    },
    server,
    wss,
    port: address.port,
    database,
    directory,
    origin,
    http,
    command,
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    restart(token = password) {
      web.close();
      web = new WebAccess({ ...options, token });
    },
    enable() {
      return command({ type: 'web.settings.update', values: { enabled: true } });
    },
    async login(extra = {}, path = '') {
      return http(`${path}/api/login`, { password, ...extra });
    },
    async socket(cookie: string, prefix = '') {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${prefix}/api/ws`, {
        origin,
        headers: { Cookie: cookie },
      });
      await once(socket, 'open');
      return socket;
    },
  };
}

test('Web starts disabled, persists its switch and stable server device, and only serves matching static routes', async (t) => {
  const f = await fixture(t);
  const disabled = await f.http('/');
  assert.equal(disabled.status, 404);
  assert.equal(disabled.headers['content-security-policy'], undefined);
  assert.equal(f.web.state().path, '');
  const device = f.web.serverDeviceId;
  f.enable();
  f.restart();
  assert.equal(f.web.enabled, true);
  assert.equal(f.web.serverDeviceId, device);
  assert.equal((await f.http('/')).status, 200);
  assert.equal((await f.http('/assets/app.js')).status, 200);
  for (const path of [
    '/assets/app.js.map',
    '/assets/%2e%2e/index.html',
    '/assets/%00',
    '/assets/%5csecret',
    '/unknown',
    '/favicon.ico',
  ])
    assert.equal((await f.http(path)).status, 404, path);
  const outside = join(tmpdir(), `cc-web-outside-${randomUUID()}`);
  writeFileSync(outside, 'secret');
  t.after(() => rmSync(outside, { force: true }));
  try {
    symlinkSync(outside, join(f.directory, 'assets', 'escape.js'));
    assert.equal((await f.http('/assets/escape.js')).status, 404);
  } catch (error) {
    // Windows allows symbolic links only to administrators or in developer mode.
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  }
  f.command({ type: 'web.settings.update', values: { enabled: false } });
  f.restart();
  assert.equal(f.web.enabled, false);
});

test('Web index uses its HTTP CSP without changing the desktop build or static assets', async (t) => {
  const f = await fixture(t, true);
  const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src ws://[::1]:*" />`;
  const html = `<!doctype html><meta charset="UTF-8">${meta}<h1>工作台</h1>`;
  const index = join(f.directory, 'index.html');
  writeFileSync(index, html);
  writeFileSync(join(f.directory, 'assets', 'app.js'), JSON.stringify(meta));
  f.enable();
  for (const path of ['/', '/index.html']) {
    const response = await f.http(path);
    assert.equal(response.status, 200);
    assert.equal(response.text, html.replace(meta, ''));
    assert.equal(Number(response.headers['content-length']), Buffer.byteLength(response.text));
    const policy = response.headers['content-security-policy']!;
    for (const directive of [
      "font-src 'self' data:",
      "object-src 'none'",
      "frame-src 'none'",
      "frame-ancestors 'none'",
    ])
      assert.ok(policy.includes(directive), directive);
    // Under no-referrer Safari sends Origin: null with the page's own sign-in, which is refused.
    assert.equal(response.headers['referrer-policy'], 'same-origin');
  }
  assert.equal(readFileSync(index, 'utf8'), html);
  assert.equal((await f.http('/assets/app.js')).text, JSON.stringify(meta));
});

test('login checks origin/password, stores hashes only, sends protected cookies, and logout revokes sockets', async (t) => {
  const f = await fixture(t, true);
  f.enable();
  assert.equal(
    (await f.http('/api/login', proof, { Origin: 'https://attacker.test' })).status,
    403,
  );
  assert.equal((await f.login({ password: 'wrong' })).status, 401);
  const login = await f.login();
  assert.equal(login.status, 200);
  assert.ok(login.cookie);
  assert.match(
    login.headers['set-cookie']![0],
    /Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure/,
  );
  const row = f.database.prepare('SELECT * FROM web_sessions').get()!;
  assert.notEqual(row.secret_hash, login.cookie.split('=')[1]);
  assert.doesNotMatch(JSON.stringify(row), new RegExp(password));
  assert.equal(
    (await f.http('/api/session', undefined, { Cookie: login.cookie })).data.authenticated,
    true,
  );
  const socket = await f.socket(login.cookie);
  const closed = once(socket, 'close');
  assert.equal((await f.http('/api/logout', {}, { Cookie: login.cookie })).status, 200);
  await closed;
  assert.equal(f.web.active(login.data.session.id), false);
  assert.equal(
    (await f.http('/api/session', undefined, { Cookie: login.cookie })).data.authenticated,
    false,
  );
});

test('idle timeout counts only explicit touch, absolute lifetime remains capped, and token rotation invalidates cookies', async (t) => {
  const f = await fixture(t);
  f.enable();
  let login = await f.login();
  let id = login.data.session.id;
  f.advance(119 * 60_000);
  await f.http('/api/session', undefined, { Cookie: login.cookie! });
  f.advance(60_000);
  assert.equal(f.web.active(id), false, 'GET and reconnect do not extend idle');
  login = await f.login();
  id = login.data.session.id;
  f.advance(119 * 60_000);
  assert.equal(f.web.touch(id), true);
  f.advance(119 * 60_000);
  assert.equal(f.web.active(id), true);
  f.advance(30 * 86_400_000);
  assert.equal(f.web.touch(id), false);
  login = await f.login();
  const device = f.web.serverDeviceId;
  f.restart('replacement-service-token-' + randomUUID());
  assert.equal(f.web.enabled, true);
  assert.equal(f.web.serverDeviceId, device);
  assert.equal(
    (await f.http('/api/session', undefined, { Cookie: login.cookie! })).data.authenticated,
    false,
  );
});

test('TOTP matches RFC 6238 vectors and confirmation/replay protection survives restart', async (t) => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  for (const [seconds, expected] of [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ] as const)
    assert.equal(totp(secret, Math.floor(seconds / 30), 8), expected);
  assert.match(totpSecret(), /^[A-Z2-7]{32}$/);
  const f = await fixture(t);
  f.enable();
  const setup = f.command({ type: 'web.totp.setup', proof }) as WebTotpSetup;
  assert.match(setup.uri, /^otpauth:\/\/totp\//);
  assert.equal(f.web.state().totpEnabled, false);
  const code = totp(setup.secret, Math.floor(f.now() / 30_000));
  f.command({ type: 'web.totp.enable', code });
  assert.equal(f.web.state().totpEnabled, true);
  assert.equal((await f.login({ code })).status, 401, 'confirmation code cannot be replayed');
  f.advance(30_000);
  const next = totp(setup.secret, Math.floor(f.now() / 30_000));
  assert.equal((await f.login({ code: next })).status, 200);
  f.restart();
  assert.equal((await f.login({ code: next })).status, 401);
  f.command({ type: 'web.totp.disable' });
  assert.equal(f.web.state().totpEnabled, false);
  assert.equal((await f.login()).status, 200);
});

test('authenticated desktop configures TOTP without repeated proof but must confirm the new code', async (t) => {
  const f = await fixture(t);
  f.enable();
  const login = await f.login();
  const setup = f.command({ type: 'web.totp.setup' }) as WebTotpSetup;
  assert.match(setup.uri, /^otpauth:\/\/totp\//);
  assert.equal(f.web.state().totpEnabled, false);
  const code = totp(setup.secret, Math.floor(f.now() / 30_000));
  const wrong = code === '000000' ? '111111' : '000000';
  assert.throws(() => f.command({ type: 'web.totp.enable', code: wrong }), /动态码/);
  assert.equal(f.web.state().totpEnabled, false);
  assert.equal(f.web.active(login.data.session.id), true);
  f.command({ type: 'web.totp.enable', code });
  assert.equal(f.web.state().totpEnabled, true);
  assert.equal(f.web.active(login.data.session.id), false);
  assert.throws(() => f.command({ type: 'web.totp.setup' }), /请先关闭/);
  assert.equal((await f.login({ code })).status, 401);
  f.advance(30_000);
  const next = totp(setup.secret, Math.floor(f.now() / 30_000));
  assert.equal((await f.login({ code: next })).status, 200);
  f.restart();
  assert.equal((await f.login({ code: next })).status, 401);
});

test('desktop TOTP confirmation rejects missing or expired setup and allows a fresh setup', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.command({ type: 'web.totp.enable', code: '123456' }), /设置已过期/);
  const expired = f.command({ type: 'web.totp.setup' }) as WebTotpSetup;
  f.advance(600_000);
  assert.throws(
    () =>
      f.command({
        type: 'web.totp.enable',
        code: totp(expired.secret, Math.floor(f.now() / 30_000)),
      }),
    /设置已过期/,
  );
  assert.equal(f.web.state().totpEnabled, false);
  const setup = f.command({ type: 'web.totp.setup' }) as WebTotpSetup;
  assert.notEqual(setup.secret, expired.secret);
  f.command({
    type: 'web.totp.enable',
    code: totp(setup.secret, Math.floor(f.now() / 30_000)),
  });
  assert.equal(f.web.state().totpEnabled, true);
});

test('browser TOTP setup requires fresh proof and an active login; the new code alone confirms it', async (t) => {
  const f = await fixture(t);
  f.enable();
  const login = await f.login();
  const other = await f.login();
  const browser = { desktop: false, address: '127.0.0.1', sessionId: login.data.session.id };
  assert.throws(() => f.command({ type: 'web.totp.setup' }, browser), /密码/);
  assert.throws(
    () => f.command({ type: 'web.totp.setup', proof: { password: 'wrong' } }, browser),
    /密码/,
  );
  assert.throws(
    () => f.command({ type: 'web.totp.setup', proof }, { ...browser, sessionId: randomUUID() }),
    /登录已失效/,
  );
  const setup = f.command({ type: 'web.totp.setup', proof }, browser) as WebTotpSetup;
  const code = totp(setup.secret, Math.floor(f.now() / 30_000));
  assert.throws(() => f.command({ type: 'web.totp.enable', code, proof }, browser));
  assert.equal(f.web.state().totpEnabled, false);
  f.command({ type: 'web.totp.enable', code }, browser);
  assert.equal(f.web.state().totpEnabled, true);
  assert.equal(f.web.active(login.data.session.id), true);
  assert.equal(f.web.active(other.data.session.id), false);
});

test('browser path changes require proof, desktop settings revoke old sessions, and only trusted proxies control the source address', async (t) => {
  const f = await fixture(t);
  f.enable();
  const login = await f.login();
  const browser = { desktop: false, address: '127.0.0.1', sessionId: login.data.session.id };
  assert.throws(
    () => f.command({ type: 'web.settings.update', values: { path: 'private' } }, browser),
    /密码/,
  );
  const changed = f.command({
    type: 'web.settings.update',
    values: {
      path: 'private',
      idleMinutes: 15,
      proxyEnabled: true,
      trustedProxies: ['192.0.2.10'],
    },
  }) as WebSettingsState;
  assert.equal(f.web.active(login.data.session.id), false);
  assert.equal(changed.url, undefined);
  assert.equal((await f.http('/')).status, 404);
  assert.equal((await f.http('/api/session', undefined, { Cookie: login.cookie! })).status, 404);
  assert.equal((await f.http('/private/')).status, 200);
  const fresh = await f.login({}, '/private');
  assert.equal(fresh.status, 200);
  assert.match(fresh.headers['set-cookie']![0], /Path=\/private\/;/);
  const requestAt = (source: string, forward: string) =>
    ({
      socket: { remoteAddress: source },
      headers: { 'x-real-ip': forward },
    }) as unknown as IncomingMessage;
  assert.equal(f.web.address(requestAt('127.0.0.1', '198.51.100.1')), '127.0.0.1');
  assert.equal(f.web.address(requestAt('192.0.2.10', '198.51.100.1')), '198.51.100.1');
  assert.equal(f.web.address(requestAt('192.0.2.10', '198.51.100.1, 127.0.0.1')), '192.0.2.10');
});

test('browser login state does not infer certificate trust from proxy configuration', async (t) => {
  const f = await fixture(t, true);
  f.enable();
  const forwarded = { 'X-Real-IP': '198.51.100.1' };
  assert.equal(Object.hasOwn((await f.http('/api/session')).data, 'selfSigned'), false);
  assert.equal(
    Object.hasOwn((await f.http('/api/session', undefined, forwarded)).data, 'selfSigned'),
    false,
  );
  f.command({
    type: 'web.settings.update',
    values: { proxyEnabled: true, trustedProxies: ['127.0.0.1'] },
  });
  assert.equal(
    Object.hasOwn((await f.http('/api/session', undefined, forwarded)).data, 'selfSigned'),
    false,
  );
  const signedIn = await f.login();
  assert.equal(signedIn.status, 200);
  assert.equal(Object.hasOwn(signedIn.data, 'selfSigned'), false);
  assert.equal(Object.hasOwn(f.web.state(), 'selfSigned'), false);
  const certificate = f.command({ type: 'web.certificate.get' });
  assert.ok('type' in certificate && certificate.type === 'web.certificate.state');
  assert.equal(
    certificate.selfSigned,
    true,
    'the desktop can still inspect its direct certificate',
  );
});

test('authenticated desktop saves access settings without proof or consuming a TOTP code', async (t) => {
  for (const enabled of [false, true]) {
    const f = await fixture(t, true);
    f.enable();
    if (enabled) {
      const setup = f.command({ type: 'web.totp.setup', proof }) as WebTotpSetup;
      const code = totp(setup.secret, Math.floor(f.now() / 30_000));
      f.command({ type: 'web.totp.enable', code });
    }
    const before = f.database.prepare('SELECT totp_last FROM web_settings').get();
    const values = {
      publicOrigin: 'https://web.example.test',
      path: 'private',
      idleMinutes: 60,
      proxyEnabled: true,
      trustedProxies: ['127.0.0.1'],
    };
    f.command({ type: 'web.settings.update', values });
    assert.deepEqual(f.database.prepare('SELECT totp_last FROM web_settings').get(), before);
    assert.throws(
      () => f.command({ type: 'web.settings.update', values: { trustedProxies: ['invalid'] } }),
      /IP/,
    );
    f.restart();
    const state = f.web.state();
    for (const key of Object.keys(values) as (keyof typeof values)[])
      assert.deepEqual(state[key], values[key]);
    assert.equal(state.totpEnabled, enabled);
  }
});

test('root and custom-path cookies stay isolated when old browser cookies are still present', async (t) => {
  const f = await fixture(t);
  f.enable();
  const root = await f.login();
  f.command({ type: 'web.settings.update', values: { path: 'private' }, proof });
  const custom = await f.login({}, '/private');
  assert.equal(custom.status, 200);
  const cookie = `${custom.cookie}; ${root.cookie}`;
  assert.equal(
    (await f.http('/private/api/session', undefined, { Cookie: cookie })).data.authenticated,
    true,
    'the browser sends its old root cookie alongside the new subpath cookie',
  );
  assert.notEqual(custom.cookie!.split('=')[0], root.cookie!.split('=')[0]);
  const socket = await f.socket(cookie, '/private');
  socket.terminate();
  f.restart();
  assert.equal(
    (await f.http('/private/api/session', undefined, { Cookie: cookie })).data.authenticated,
    true,
    'the path-scoped cookie name survives a server restart',
  );
  f.command({ type: 'web.settings.update', values: { path: '' }, proof });
  assert.equal(
    (await f.http('/api/session', undefined, { Cookie: root.cookie! })).data.authenticated,
    false,
    'returning to a previous path does not revive its revoked session',
  );
  const fresh = await f.http('/api/login', proof, { Cookie: root.cookie! });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.cookie!.split('=')[0], root.cookie!.split('=')[0]);
  const current = `${fresh.cookie}; ${custom.cookie}`;
  assert.equal(
    (await f.http('/api/session', undefined, { Cookie: current })).data.authenticated,
    true,
  );
  assert.equal((await f.http('/api/logout', {}, { Cookie: current })).status, 200);
  assert.equal(
    (await f.http('/api/session', undefined, { Cookie: current })).data.authenticated,
    false,
  );
});

test('a delayed old socket close does not unregister a replacement after Web is re-enabled', async (t) => {
  for (const ending of ['revoke', 'idle']) {
    await t.test(ending, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const f = await fixture(t);
      f.enable();
      const login = await f.login();
      const old = await f.socket(login.cookie!);
      const serverSocket = [...f.wss.clients][0]!;
      const oldClosed = once(serverSocket, 'close');
      old.pause();
      f.command({ type: 'web.settings.update', values: { enabled: false } });
      await nextTurn();
      f.enable();
      const replacement = await f.socket(login.cookie!);
      old.resume();
      await oldClosed;
      assert.equal(replacement.readyState, WebSocket.OPEN);
      const closed = once(replacement, 'close', { signal: AbortSignal.timeout(2000) });
      if (ending === 'revoke')
        f.command({ type: 'web.sessions.revoke', sessionId: login.data.session.id, proof });
      else {
        f.advance(120 * 60_000);
        t.mock.timers.tick(120 * 60_000);
      }
      const [code] = await closed;
      assert.equal(code, 4001);
      assert.equal(f.web.active(login.data.session.id), false);
    });
  }
});

test('login and TOTP confirmation share bounded guessing limits', async (t) => {
  const f = await fixture(t);
  f.enable();
  for (let index = 0; index < 6; index++)
    assert.equal((await f.login({ password: 'bad' })).status, 401);
  assert.equal((await f.login()).status, 429);
  f.advance(60_000);
  assert.equal((await f.login()).status, 200);
  const setup = f.command({ type: 'web.totp.setup' }) as WebTotpSetup;
  const actual = totp(setup.secret, Math.floor(f.now() / 30_000));
  const wrong = actual === '000000' ? '111111' : '000000';
  for (let index = 0; index < 6; index++)
    assert.throws(() => f.command({ type: 'web.totp.enable', code: wrong }), /动态码/);
  assert.throws(() => f.command({ type: 'web.totp.enable', code: actual }), /频繁/);
  f.command({ type: 'web.totp.setup' });
  assert.throws(() => f.command({ type: 'web.totp.enable', code: actual }), /频繁/);
  assert.equal((await f.login()).status, 429);
});

test('public plain HTTP cannot be enabled and a configured domain rejects IP requests', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const web = new WebAccess({
    database: db,
    token: password,
    directory: '.',
    dataDir: tmpdir(),
    host: '0.0.0.0',
  });
  assert.throws(
    () =>
      web.execute(
        { type: 'web.settings.update', requestId: randomUUID(), values: { enabled: true } },
        context,
      ),
    /HTTPS/,
  );
  assert.equal(web.enabled, false);
  const f = await fixture(t, true);
  f.enable();
  f.command({
    type: 'web.settings.update',
    values: { publicOrigin: `https://web.example.test:${f.port}` },
    proof,
  });
  assert.equal((await f.http('/')).status, 404);
  const port = new URL(f.origin).port;
  assert.equal(
    (
      await f.http('/', undefined, {
        Host: `web.example.test:${port}`,
        Origin: `https://web.example.test:${port}`,
      })
    ).status,
    200,
  );
});

test('the server timer closes an idle WebSocket without traffic or a new authentication request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  f.enable();
  f.command({ type: 'web.settings.update', values: { idleMinutes: 15 }, proof });
  const login = await f.login();
  const socket = await f.socket(login.cookie!);
  const closed = once(socket, 'close');
  f.advance(14 * 60_000);
  t.mock.timers.tick(14 * 60_000);
  await f.http('/api/session', undefined, { Cookie: login.cookie! });
  assert.equal(socket.readyState, WebSocket.OPEN);
  f.advance(60_000);
  t.mock.timers.tick(60_000);
  await closed;
  assert.equal(f.web.active(login.data.session.id), false);
});

test('browser privileges are limited, re-login rotates rather than duplicates its session, and only the exact prefix redirects', async (t) => {
  const f = await fixture(t);
  f.enable();
  let login = await f.login();
  const browser = { desktop: false, address: '127.0.0.1', sessionId: login.data.session.id };
  for (const values of [
    { enabled: false },
    { publicOrigin: 'https://other.example.test' },
    { proxyEnabled: true },
    { idleMinutes: 60 },
  ])
    assert.throws(() => f.command({ type: 'web.settings.update', values, proof }, browser), /桌面/);
  assert.throws(() => f.command({ type: 'web.totp.disable' }, browser), /密码/);
  const previous = login.data.session.id;
  login = await f.http('/api/login', proof, { Cookie: login.cookie! });
  assert.equal(login.status, 200);
  assert.notEqual(login.data.session.id, previous);
  assert.equal(f.web.active(previous), false);
  assert.equal(f.web.state().sessions.length, 1);
  f.command({ type: 'web.settings.update', values: { path: 'private' }, proof });
  const redirect = await f.http('/private');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, '/private/');
  for (const path of ['/', '/privat', '/private-more', '/private/api/session/'])
    assert.equal((await f.http(path)).status, 404, path);
  assert.equal((await f.http('/private', proof)).status, 404);
});

test('a desktop revokes freely; a browser signs itself out freely but needs proof to end another login', async (t) => {
  const f = await fixture(t);
  f.enable();
  const [own, other, third] = [await f.login(), await f.login(), await f.login()];
  const browser = { desktop: false, address: '127.0.0.1', sessionId: own.data.session.id };
  assert.throws(
    () => f.command({ type: 'web.sessions.revoke', sessionId: other.data.session.id }, browser),
    /密码/,
  );
  f.command({ type: 'web.sessions.revoke', sessionId: other.data.session.id, proof }, browser);
  assert.equal(f.web.active(other.data.session.id), false);
  f.command({ type: 'web.sessions.revoke', sessionId: third.data.session.id });
  assert.equal(f.web.active(third.data.session.id), false);
  f.command({ type: 'web.sessions.revoke', sessionId: own.data.session.id }, browser);
  assert.equal(f.web.active(own.data.session.id), false);
});

test('strict protocol and stored settings reject unknown or incomplete fields', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.command({ type: 'web.settings.get', legacy: true }));
  assert.throws(() => f.command({ type: 'web.settings.update', values: { unknown: true } }));
  f.database.prepare('UPDATE web_settings SET settings = ? WHERE id = 1').run('{}');
  assert.throws(() => f.restart());
});

test('a configured public origin is persisted, matches the exact authority, and can be cleared', async (t) => {
  const f = await fixture(t, true);
  f.enable();
  assert.equal(f.web.state().url, undefined);
  assert.equal(f.web.state().passkeyAvailable, false);
  const publicOrigin = 'https://web.example.test:1443';
  f.command({ type: 'web.settings.update', values: { publicOrigin, path: 'entry' } });
  f.restart();
  assert.equal(f.web.state().url, publicOrigin + '/entry/');
  assert.equal(f.web.state().domain, 'web.example.test');
  for (const host of ['web.example.test', 'web.example.test:443', '127.0.0.1:1443'])
    assert.equal((await f.http('/entry/', undefined, { Host: host })).status, 404);
  assert.equal((await f.http('/entry/', undefined, { Host: 'web.example.test:1443' })).status, 200);
  f.command({ type: 'web.settings.update', values: { publicOrigin: '' } });
  assert.equal(f.web.state().publicOrigin, '');
  assert.equal(f.web.state().domain, '');
  assert.equal(f.web.state().url, undefined);
  assert.equal(f.web.state().passkeyAvailable, false);
  assert.equal(
    (await f.http('/entry/')).status,
    200,
    'direct Web remains available without a published link',
  );
});

test('released domain-only settings keep their Host constraint without borrowing a desktop address', async (t) => {
  const f = await fixture(t, true);
  const stored = {
    enabled: true,
    domain: 'web.example.test',
    path: '',
    idleMinutes: 120,
    proxyEnabled: false,
    trustedProxies: [],
  };
  f.database
    .prepare('UPDATE web_settings SET settings = ? WHERE id = 1')
    .run(JSON.stringify(stored));
  f.restart();
  assert.equal(f.web.state().domain, stored.domain);
  assert.equal(f.web.state().publicOrigin, '');
  assert.equal(f.web.state().url, undefined);
  assert.equal(f.web.state().passkeyAvailable, false);
  assert.equal((await f.http('/')).status, 404);
  assert.equal((await f.http('/', undefined, { Host: 'web.example.test:1443' })).status, 200);
});

test('an IP public origin preserves the direct self-signed Web flow but does not enable Passkeys', async (t) => {
  const f = await fixture(t, true);
  f.command({ type: 'web.settings.update', values: { enabled: true, publicOrigin: f.origin } });
  assert.equal(f.web.state().url, f.origin + '/');
  assert.equal(f.web.state().domain, '');
  assert.equal(f.web.state().passkeyAvailable, false);
  assert.equal((await f.login()).status, 200);
  assert.equal((await f.http('/', undefined, { Host: '127.0.0.1:1443' })).status, 404);
});

test('an imported domain certificate permits port edits but blocks removing or replacing its hostname', async (t) => {
  const f = await fixture(t, true);
  f.command({
    type: 'web.settings.update',
    values: { publicOrigin: 'https://web.example.test:1443' },
  });
  f.command({ type: 'web.certificate.set', ...custom });
  f.command({
    type: 'web.settings.update',
    values: { publicOrigin: 'https://web.example.test:2443' },
  });
  assert.equal(f.web.state().url, 'https://web.example.test:2443/');
  for (const publicOrigin of ['', 'https://other.example.test:2443'])
    assert.throws(
      () => f.command({ type: 'web.settings.update', values: { publicOrigin } }),
      /恢复默认证书/,
    );
  f.command({ type: 'web.certificate.reset' });
  f.command({ type: 'web.settings.update', values: { publicOrigin: '' } });
  assert.equal(f.web.state().domain, '');
});

test('a slow password login cannot recreate sessions or consume TOTP after access settings change', async (t) => {
  for (const values of [
    { publicOrigin: 'https://web.example.test:2443' },
    { publicOrigin: '' },
    { path: 'changed' },
    { enabled: false },
  ]) {
    const f = await fixture(t, true);
    const publicOrigin = 'https://web.example.test:1443';
    f.command({ type: 'web.settings.update', values: { enabled: true, publicOrigin } });
    const setup = f.command({ type: 'web.totp.setup' }) as WebTotpSetup;
    f.command({ type: 'web.totp.enable', code: totp(setup.secret, Math.floor(f.now() / 30_000)) });
    f.advance(30_000);
    const before = f.database.prepare('SELECT totp_last FROM web_settings').get();
    const payload = JSON.stringify({
      password,
      code: totp(setup.secret, Math.floor(f.now() / 30_000)),
    });
    const received = once(f.server, 'request');
    let req: ReturnType<typeof request>;
    const response = new Promise<{ status: number; data: any }>((resolve, reject) => {
      req = request(
        {
          hostname: '127.0.0.1',
          port: f.port,
          path: '/api/login',
          method: 'POST',
          headers: {
            Host: 'web.example.test:1443',
            Origin: publicOrigin,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(body) }));
        },
      );
      req.on('error', reject);
      req.write(payload.slice(0, 5));
    });
    await received;
    f.command({ type: 'web.settings.update', values });
    req!.end(payload.slice(5));
    const result = await response;
    assert.equal(result.status, 400);
    assert.equal(result.data.code, 'web_access_changed');
    assert.equal(f.web.state().sessions.length, 0);
    assert.deepEqual(f.database.prepare('SELECT totp_last FROM web_settings').get(), before);
  }
});
