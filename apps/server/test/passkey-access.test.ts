import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { WebCommand } from '@cc-desk-tunnel/protocol';
import { WebAccess } from '../src/web-access.ts';
import { totp } from '../src/web-totp.ts';
import { authenticator } from './fixtures/passkey.ts';

const origin = 'https://web.example.test:1443';
async function fixture(t: TestContext, persistent = false) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-passkey-'));
  const databasePath = persistent ? join(directory, 'web.sqlite') : ':memory:';
  let database = new DatabaseSync(databasePath);
  const password = `test-passkey-${randomUUID()}`;
  let now = Date.UTC(2026, 0, 1);
  const open = () =>
    new WebAccess({
      database,
      token: password,
      directory,
      dataDir: directory,
      reverseProxy: true,
      now: () => now,
    });
  let web = open();
  const command = (value: object, sessionId?: string) =>
    web.execute({ requestId: randomUUID(), ...value } as WebCommand, {
      desktop: !sessionId,
      address: '127.0.0.1',
      origin,
      sessionId,
    });
  command({
    type: 'web.settings.update',
    values: { enabled: true, domain: 'web.example.test', path: 'desk' },
  });
  const server = createServer(
    (req, res) =>
      void web
        .handle(req, res)
        .then((handled) => {
          if (!handled) res.writeHead(404).end();
        })
        .catch(() => res.writeHead(500).end()),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    web.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const http = (
    path: string,
    body?: unknown,
    cookie?: string,
    headers: Record<string, string> = {},
  ) =>
    new Promise<{ status: number; data: any; cookie?: string }>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path: `/desk/api/${path}`,
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Host: 'web.example.test:1443',
            Origin: origin,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (value) => {
            text += value;
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
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const login = () => http('login', { password });
  const auth = authenticator('web.example.test', origin);
  const add = async (cookie: string) => {
    const start = await http('passkey/register/options', { name: '日常使用' }, cookie);
    assert.equal(start.status, 200);
    const result = await http(
      'passkey/register/verify',
      {
        challengeId: start.data.challengeId,
        response: auth.register(start.data.options.challenge),
      },
      cookie,
    );
    assert.equal(result.status, 200);
    return result.data.id as string;
  };
  const passkeyLogin = async () => {
    const options = await http('passkey/login/options', {});
    assert.equal(options.status, 200);
    return http('passkey/login/verify', {
      challengeId: options.data.challengeId,
      response: auth.authenticate(options.data.options.challenge),
    });
  };
  return {
    get web() {
      return web;
    },
    get database() {
      return database;
    },
    password,
    command,
    http,
    login,
    add,
    auth,
    passkeyLogin,
    reopen: () => {
      assert.ok(persistent);
      web.close();
      database.close();
      database = new DatabaseSync(databasePath);
      web = open();
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('Only a logged-in browser registers; custom-path login validates HTTPS proxy Host and Origin over HTTP', async (t) => {
  const f = await fixture(t);
  const input = { name: '日常使用' };
  assert.equal((await f.http('passkey/register/options', input)).status, 401);
  assert.equal(
    (
      await f.http('passkey/register/options', {
        ...input,
        proof: { password: f.password },
      })
    ).status,
    401,
  );
  const login = await f.login();
  assert.equal(login.status, 200);
  assert.equal(
    (
      await f.http(
        'passkey/register/options',
        {
          ...input,
          proof: { password: f.password },
        },
        login.cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.http('passkey/register/options', input, login.cookie, {
        Origin: 'https://evil.example.test',
      })
    ).status,
    403,
  );
  await f.add(login.cookie!);
  const state = await f.http('session');
  assert.equal(state.data.passkeyAvailable, true);
  assert.equal(state.data.url, `${origin}/desk/`);
  const signedIn = await f.passkeyLogin();
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.data.authenticated, true);
  assert.ok(signedIn.cookie);
  const stored = f.database
    .prepare('SELECT * FROM web_sessions WHERE id = ?')
    .get(signedIn.data.session.id)!;
  assert.equal(typeof stored.passkey_id, 'string');
  assert.notEqual(stored.secret_hash, signedIn.cookie!.split('=')[1]);
});

test('Published session rows survive schema upgrade; credentials and Passkey logins survive reopening the database', async (t) => {
  const f = await fixture(t, true);
  const original = await f.login();
  // Recreate the published pre-Passkey table layout with a real credential login already stored.
  f.database.exec('ALTER TABLE web_sessions DROP COLUMN passkey_id');
  f.reopen();
  const restored = await f.http('session', undefined, original.cookie);
  assert.equal(restored.data.authenticated, true);
  assert.equal(restored.data.session.id, original.data.session.id);
  assert.equal(
    f.database
      .prepare('SELECT passkey_id FROM web_sessions WHERE id = ?')
      .get(original.data.session.id)!.passkey_id,
    null,
  );
  const id = await f.add(original.cookie!);
  const signedIn = await f.passkeyLogin();
  assert.equal(signedIn.status, 200);
  const pending = f.web.passkeys.proof(signedIn.data.session.id);
  const keys = f.web.passkeys.list('web.example.test');
  f.reopen();
  assert.deepEqual(f.web.passkeys.list('web.example.test'), keys);
  assert.equal((await f.http('session', undefined, original.cookie)).data.authenticated, true);
  assert.equal((await f.http('session', undefined, signedIn.cookie)).data.authenticated, true);
  assert.throws(() => f.web.passkeys.consumeProof(pending.proof, signedIn.data.session.id), {
    code: 'passkey_expired',
  });
  assert.equal((await f.passkeyLogin()).status, 200);
  f.command({ type: 'web.passkeys.remove', passkeyId: id });
  assert.equal((await f.http('session', undefined, signedIn.cookie)).data.authenticated, false);
  assert.equal((await f.http('session', undefined, original.cookie)).data.authenticated, true);
});

test('Registration rejects proof fields while other proof operations remain available', async (t) => {
  const f = await fixture(t);
  const login = await f.login();
  const id = await f.add(login.cookie!);
  const options = await f.http('passkey/proof/options', {}, login.cookie);
  const proof = await f.http(
    'passkey/proof/verify',
    {
      challengeId: options.data.challengeId,
      response: f.auth.authenticate(options.data.options.challenge, false),
    },
    login.cookie,
  );
  assert.equal(proof.status, 200);
  assert.equal(proof.data.expiresAt, new Date(Date.UTC(2026, 0, 1, 0, 1)).toISOString());
  assert.equal(
    (
      await f.http(
        'passkey/register/options',
        {
          name: '另一把密钥',
          proof: { passkey: proof.data.proof },
        },
        login.cookie,
      )
    ).status,
    400,
  );
  f.command(
    {
      type: 'web.passkeys.rename',
      passkeyId: id,
      name: '仍可管理',
      proof: { passkey: proof.data.proof },
    },
    login.data.session.id,
  );
  assert.equal(f.web.passkeys.list('web.example.test')[0].name, '仍可管理');
});

test('TOTP protects login, but the authenticated session registers without another credential or code', async (t) => {
  const f = await fixture(t);
  const setup = f.command({ type: 'web.totp.setup' });
  assert.ok(setup.type === 'web.totp.setup');
  const step = Math.floor(Date.UTC(2026, 0, 1) / 30_000);
  f.command({ type: 'web.totp.enable', code: totp(setup.secret, step) });
  f.advance(30_000);
  assert.equal((await f.http('login', { password: f.password })).status, 401);
  assert.equal(
    (await f.http('login', { password: f.password, code: totp(setup.secret, step) })).status,
    401,
  );
  const login = await f.http('login', { password: f.password, code: totp(setup.secret, step + 1) });
  assert.equal(login.status, 200);
  const start = await f.http('passkey/register/options', { name: '日常使用' }, login.cookie);
  assert.equal(start.status, 200);
  assert.equal(
    (
      await f.http(
        'passkey/register/verify',
        {
          challengeId: start.data.challengeId,
          response: f.auth.register(start.data.options.challenge, false),
        },
        login.cookie,
      )
    ).status,
    200,
  );
  f.advance(120 * 60_000);
  assert.equal(
    (await f.http('passkey/register/options', { name: '另一把密钥' }, login.cookie)).status,
    401,
  );
});

test('Browser registration belongs to its session; logout and access changes invalidate outstanding challenges', async (t) => {
  const f = await fixture(t);
  const first = await f.login(),
    second = await f.login();
  const start = await f.http('passkey/register/options', { name: '日常使用' }, first.cookie);
  const response = {
    challengeId: start.data.challengeId,
    response: f.auth.register(start.data.options.challenge),
  };
  assert.equal((await f.http('passkey/register/verify', response, second.cookie)).status, 400);
  await f.http('logout', {}, first.cookie);
  assert.equal((await f.http('passkey/register/verify', response, first.cookie)).status, 401);
  await f.add(second.cookie!);
  const pending = await f.http('passkey/login/options', {});
  f.command({ type: 'web.settings.update', values: { enabled: false } });
  f.command({ type: 'web.settings.update', values: { enabled: true } });
  assert.equal(
    (
      await f.http('passkey/login/verify', {
        challengeId: pending.data.challengeId,
        response: f.auth.authenticate(pending.data.options.challenge),
      })
    ).status,
    400,
  );
});

test('Removing a Passkey revokes its logins without signing credential logins out', async (t) => {
  const f = await fixture(t);
  const original = await f.login();
  const id = await f.add(original.cookie!);
  const signedIn = await f.passkeyLogin();
  const start = await f.http('passkey/proof/options', {}, signedIn.cookie);
  const proof = await f.http(
    'passkey/proof/verify',
    {
      challengeId: start.data.challengeId,
      response: f.auth.authenticate(start.data.options.challenge),
    },
    signedIn.cookie,
  );
  assert.equal(proof.status, 200);
  f.command(
    {
      type: 'web.passkeys.rename',
      passkeyId: id,
      name: '随身使用',
      proof: { passkey: proof.data.proof },
    },
    signedIn.data.session.id,
  );
  assert.throws(() =>
    f.command(
      {
        type: 'web.passkeys.rename',
        passkeyId: id,
        name: '重复使用',
        proof: { passkey: proof.data.proof },
      },
      signedIn.data.session.id,
    ),
  );
  f.command({ type: 'web.passkeys.remove', passkeyId: id });
  assert.equal((await f.http('session', undefined, signedIn.cookie)).data.authenticated, false);
  assert.equal((await f.http('session', undefined, original.cookie)).data.authenticated, true);
  assert.equal((await f.http('session')).data.passkeyAvailable, false);
});

test('Revocation after verification cannot be followed by a newly committed Passkey login', async (t) => {
  const f = await fixture(t);
  const original = await f.login();
  const id = await f.add(original.cookie!);
  const authenticate = f.web.passkeys.authenticate.bind(f.web.passkeys);
  t.mock.method(
    f.web.passkeys,
    'authenticate',
    async (...args: Parameters<typeof authenticate>) => {
      const result = await authenticate(...args);
      // Exercise the boundary between cryptographic verification and its caller's continuation.
      f.command({ type: 'web.passkeys.remove', passkeyId: id });
      return result;
    },
  );
  const result = await f.passkeyLogin();
  assert.equal((await f.http('session', undefined, result.cookie)).data.authenticated, false);
  assert.equal((await f.http('session', undefined, original.cookie)).data.authenticated, true);
});

test('Cancellation preserves the registration and proof session gates and exact Origin check', async (t) => {
  const f = await fixture(t);
  const login = await f.login();
  await f.add(login.cookie!);
  for (const kind of ['register', 'proof'] as const) {
    const options = await f.http(
      `passkey/${kind}/options`,
      kind === 'register' ? { name: '日常使用' } : {},
      login.cookie,
    );
    assert.equal(options.status, 200);
    assert.equal(options.data.expiresAt, new Date(Date.UTC(2026, 0, 1, 0, 5)).toISOString());
    const body = { challengeId: options.data.challengeId };
    const path = `passkey/${kind}/cancel`;
    assert.equal((await f.http(path, body)).status, 401);
    assert.equal(
      (await f.http(path, body, login.cookie, { Origin: 'https://evil.example.test' })).status,
      403,
    );
    const cancelled = await f.http(path, body, login.cookie);
    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancelled.data, { cancelled: true });
    assert.equal(cancelled.cookie, undefined);
  }
});

test('Anonymous cancellation releases a slot during login backoff without clearing the backoff or signing in', async (t) => {
  const f = await fixture(t);
  const login = await f.login();
  await f.add(login.cookie!);
  const attempts = [];
  for (let i = 0; i < 4; i++) attempts.push(await f.http('passkey/login/options', {}));
  assert.ok(attempts.every((value) => value.status === 200));
  const full = await f.http('passkey/login/options', {});
  assert.equal(full.status, 429);
  assert.equal(full.data.code, 'passkey_busy');
  const first = attempts[0].data;
  assert.equal(first.expiresAt, new Date(Date.UTC(2026, 0, 1, 0, 5)).toISOString());
  for (let i = 0; i < 6; i++)
    assert.equal((await f.http('login', { password: 'wrong' })).status, 401);
  assert.equal((await f.http('passkey/login/options', {})).status, 429);
  const cancelled = await f.http('passkey/login/cancel', { challengeId: first.challengeId });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.cookie, undefined);
  assert.equal((await f.http('session')).data.authenticated, false);
  assert.equal((await f.http('passkey/login/options', {})).status, 429);
  f.advance(60_000);
  assert.equal((await f.http('passkey/login/options', {})).status, 200);
  const fullAgain = await f.http('passkey/login/options', {});
  assert.equal(fullAgain.status, 429);
  assert.equal(fullAgain.data.code, 'passkey_busy');
});
