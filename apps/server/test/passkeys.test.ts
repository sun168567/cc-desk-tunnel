import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Passkeys } from '../src/passkeys.ts';
import { authenticator } from './fixtures/passkey.ts';

const entry = { rpId: 'web.example.test', origin: 'https://web.example.test:1443' };
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let now = Date.UTC(2026, 0, 1);
  const keys = new Passkeys(db, 'test-token-hash', randomUUID(), () => now);
  const auth = authenticator(entry.rpId, entry.origin);
  const session = randomUUID();
  async function add() {
    const options = await keys.registrationOptions('日常使用', session, entry, '127.0.0.1');
    return keys.register(
      options.challengeId,
      auth.register(options.options.challenge),
      entry,
      session,
    );
  }
  return {
    keys,
    auth,
    session,
    db,
    add,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('Passkey stores public credentials, verifies signatures, and consumes challenges and proofs once', async (t) => {
  const f = fixture(t);
  const id = await f.add();
  const login = await f.keys.authenticationOptions('login', entry, '127.0.0.1');
  const signed = f.auth.authenticate(login.options.challenge);
  assert.equal(
    await f.keys.authenticate('login', login.challengeId, signed, entry, undefined, (id) => id),
    id,
  );
  await assert.rejects(
    f.keys.authenticate('login', login.challengeId, signed, entry, undefined, (id) => id),
  );
  const challenge = await f.keys.authenticationOptions('proof', entry, '127.0.0.1', f.session);
  assert.equal(
    await f.keys.authenticate(
      'proof',
      challenge.challengeId,
      f.auth.authenticate(challenge.options.challenge),
      entry,
      f.session,
      (id) => id,
    ),
    id,
  );
  const { proof } = f.keys.proof(f.session);
  assert.throws(() => f.keys.consumeProof(proof, randomUUID()));
  f.keys.consumeProof(proof, f.session);
  assert.throws(() => f.keys.consumeProof(proof, f.session));
  f.keys.rename(id, '安全密钥');
  assert.equal(f.keys.list(entry.rpId)[0].name, '安全密钥');
  assert.equal(f.keys.list('another.example.test')[0].available, false);
});

test('Proof expiry matches its reported deadline and does not extend on consumption attempts', (t) => {
  const f = fixture(t);
  const first = f.keys.proof(f.session);
  const second = f.keys.proof(f.session);
  assert.equal(first.expiresAt, new Date(Date.UTC(2026, 0, 1, 0, 1)).toISOString());
  assert.equal(second.expiresAt, first.expiresAt);
  f.advance(59_999);
  assert.throws(() => f.keys.consumeProof(second.proof, randomUUID()), { code: 'passkey_expired' });
  f.keys.consumeProof(first.proof, f.session);
  f.advance(1);
  assert.throws(() => f.keys.consumeProof(second.proof, f.session), { code: 'passkey_expired' });
});

test('Registration, login and proof prefer user verification but accept either UV flag', async (t) => {
  for (const uv of [true, false]) {
    await t.test(`UV=${uv}`, async (t) => {
      const f = fixture(t);
      const registration = await f.keys.registrationOptions(
        '日常使用',
        f.session,
        entry,
        '127.0.0.1',
      );
      assert.equal(registration.options.authenticatorSelection?.userVerification, 'preferred');
      const id = await f.keys.register(
        registration.challengeId,
        f.auth.register(registration.options.challenge, uv),
        entry,
        f.session,
      );
      for (const kind of ['login', 'proof'] as const) {
        const sessionId = kind === 'proof' ? f.session : undefined;
        const options = await f.keys.authenticationOptions(kind, entry, '127.0.0.1', sessionId);
        assert.equal(options.options.userVerification, 'preferred');
        assert.equal(
          await f.keys.authenticate(
            kind,
            options.challengeId,
            f.auth.authenticate(options.options.challenge, uv),
            entry,
            sessionId,
            (key) => key,
          ),
          id,
        );
      }
    });
  }
});

test('Optional UV does not relax presence, signature, challenge, Origin or RP ID checks', async (t) => {
  const f = fixture(t);
  for (const fault of ['challenge', 'origin', 'rpId'] as const) {
    const options = await f.keys.registrationOptions('日常使用', f.session, entry, '127.0.0.1');
    const auth = authenticator(fault === 'rpId' ? 'other.example.test' : entry.rpId, entry.origin);
    const response = auth.register(
      fault === 'challenge' ? 'wrong-challenge' : options.options.challenge,
      false,
      fault === 'origin' ? { origin: 'https://other.example.test' } : {},
    );
    await assert.rejects(f.keys.register(options.challengeId, response, entry, f.session));
  }
  await f.add();
  for (const kind of ['login', 'proof'] as const) {
    const sessionId = kind === 'proof' ? f.session : undefined;
    for (const fault of ['presence', 'signature', 'challenge', 'origin', 'rpId'] as const) {
      const options = await f.keys.authenticationOptions(kind, entry, '127.0.0.1', sessionId);
      const response = f.auth.authenticate(
        fault === 'challenge' ? 'wrong-challenge' : options.options.challenge,
        false,
        fault === 'origin' ? { origin: 'https://other.example.test' } : {},
        fault !== 'presence',
      );
      if (fault === 'signature') {
        const signature = Buffer.from(response.response.signature, 'base64url');
        signature[signature.length - 1] ^= 1;
        response.response.signature = signature.toString('base64url');
      }
      if (fault === 'rpId') {
        const data = Buffer.from(response.response.authenticatorData, 'base64url');
        data[0] ^= 1;
        response.response.authenticatorData = data.toString('base64url');
      }
      await assert.rejects(
        f.keys.authenticate(kind, options.challengeId, response, entry, sessionId, (key) => key),
        fault === 'rpId' ? { name: 'UnexpectedRPIDHash' } : Error,
      );
    }
  }
});

test('Registration binds the login, exact origin and user presence, and rejects expired attempts', async (t) => {
  const f = fixture(t);
  const options = await f.keys.registrationOptions('日常使用', f.session, entry, '127.0.0.1');
  const response = f.auth.register(options.options.challenge);
  await assert.rejects(f.keys.register(options.challengeId, response, entry, randomUUID()));
  await assert.rejects(
    f.keys.register(
      options.challengeId,
      response,
      { ...entry, origin: 'https://web.example.test' },
      f.session,
    ),
  );
  await assert.rejects(
    f.keys.register(
      options.challengeId,
      f.auth.register(options.options.challenge, false, {}, false),
      entry,
      f.session,
    ),
  );
  await assert.rejects(f.keys.register(options.challengeId, response, entry, f.session));
  const expired = await f.keys.registrationOptions('日常使用', f.session, entry, '127.0.0.1');
  assert.equal(expired.expiresAt, new Date(Date.UTC(2026, 0, 1, 0, 5)).toISOString());
  f.advance(5 * 60_000);
  await assert.rejects(
    f.keys.register(
      expired.challengeId,
      f.auth.register(expired.options.challenge),
      entry,
      f.session,
    ),
  );
  assert.equal(f.keys.list(entry.rpId).length, 0);
});

test('Cancellation binds the ceremony and releases capacity once; expiry still releases abandoned slots', async (t) => {
  const f = fixture(t);
  await f.add();
  for (const kind of ['register', 'login', 'proof'] as const) {
    const sessionId = kind === 'login' ? undefined : f.session;
    const prepare = () =>
      kind === 'register'
        ? f.keys.registrationOptions('安全密钥', f.session, entry, '127.0.0.1')
        : f.keys.authenticationOptions(kind, entry, '127.0.0.1', sessionId);
    const first = await prepare();
    for (let i = 0; i < 3; i++) await prepare();
    const full = () => assert.rejects(prepare(), { code: 'passkey_busy' });
    await full();
    f.keys.cancel(first.challengeId, kind === 'login' ? 'proof' : 'login', entry, sessionId);
    f.keys.cancel(first.challengeId, kind, { ...entry, rpId: 'other.example.test' }, sessionId);
    f.keys.cancel(
      first.challengeId,
      kind,
      { ...entry, origin: 'https://other.example.test' },
      sessionId,
    );
    f.keys.cancel(first.challengeId, kind, entry, randomUUID());
    await full();
    f.keys.cancel(first.challengeId, kind, entry, sessionId);
    f.keys.cancel(first.challengeId, kind, entry, sessionId);
    f.keys.cancel(randomUUID(), kind, entry, sessionId);
    await prepare();
    await full();
    f.advance(5 * 60_000);
    await prepare();
    f.keys.clearPending();
  }
});

test('Authentication options expose their expiry, capped by the browser session lifetime', async (t) => {
  const f = fixture(t);
  const id = await f.add();
  const login = await f.keys.authenticationOptions('login', entry, '127.0.0.1');
  const deadline = Date.UTC(2026, 0, 1, 0, 2);
  const proof = await f.keys.authenticationOptions(
    'proof',
    entry,
    '127.0.0.1',
    f.session,
    deadline,
  );
  assert.equal(login.expiresAt, new Date(Date.UTC(2026, 0, 1, 0, 5)).toISOString());
  assert.equal(proof.expiresAt, new Date(deadline).toISOString());
  f.advance(2 * 60_000);
  await assert.rejects(
    f.keys.authenticate(
      'proof',
      proof.challengeId,
      f.auth.authenticate(proof.options.challenge),
      entry,
      f.session,
      () => {},
    ),
    { code: 'passkey_expired' },
  );
  assert.equal(
    await f.keys.authenticate(
      'login',
      login.challengeId,
      f.auth.authenticate(login.options.challenge),
      entry,
      undefined,
      (key) => key,
    ),
    id,
  );
});

test('Invalidation covers asynchronous generation, verification, logout and key deletion', async (t) => {
  const f = fixture(t);
  const pending = f.keys.registrationOptions('日常使用', f.session, entry, '127.0.0.1');
  f.keys.clearPending();
  await assert.rejects(pending);
  const options = await f.keys.registrationOptions('日常使用', f.session, entry, '127.0.0.1');
  const verifying = f.keys.register(
    options.challengeId,
    f.auth.register(options.options.challenge),
    entry,
    f.session,
  );
  f.keys.revokeSession(f.session);
  await assert.rejects(verifying);
  assert.equal(f.keys.list(entry.rpId).length, 0);
  const id = await f.add();
  const cancelled = await f.keys.authenticationOptions('login', entry, '127.0.0.1');
  let committed = false;
  const verifyingLogin = f.keys.authenticate(
    'login',
    cancelled.challengeId,
    f.auth.authenticate(cancelled.options.challenge),
    entry,
    undefined,
    () => {
      committed = true;
    },
  );
  f.keys.cancel(cancelled.challengeId, 'login', entry);
  await assert.rejects(verifyingLogin, { code: 'passkey_expired' });
  assert.equal(committed, false);
  const login = await f.keys.authenticationOptions('login', entry, '127.0.0.1');
  const signingIn = f.keys.authenticate(
    'login',
    login.challengeId,
    f.auth.authenticate(login.options.challenge),
    entry,
    undefined,
    (id) => id,
  );
  f.keys.remove(id);
  await assert.rejects(signingIn);
  assert.equal(f.keys.list(entry.rpId).length, 0);
});

test('Only one concurrent verification can commit, and changing the service credential removes stored keys', async (t) => {
  const f = fixture(t);
  const options = await f.keys.registrationOptions('日常使用', f.session, entry, '127.0.0.1');
  const response = f.auth.register(options.options.challenge);
  const results = await Promise.allSettled([
    f.keys.register(options.challengeId, response, entry, f.session),
    f.keys.register(options.challengeId, response, entry, f.session),
  ]);
  assert.equal(results.filter((value) => value.status === 'fulfilled').length, 1);
  assert.equal(f.keys.list(entry.rpId).length, 1);
  assert.equal(new Passkeys(f.db, 'changed-token-hash', randomUUID()).list(entry.rpId).length, 0);
});

test('Different challenges for one credential cannot both commit against the same stored counter', async (t) => {
  const f = fixture(t);
  const id = await f.add();
  const first = await f.keys.authenticationOptions('login', entry, '127.0.0.1');
  const second = await f.keys.authenticationOptions('login', entry, '127.0.0.1');
  assert.notEqual(first.challengeId, second.challengeId);
  let commits = 0;
  const attempts = [first, second].map((options) =>
    f.keys.authenticate(
      'login',
      options.challengeId,
      f.auth.authenticate(options.options.challenge),
      entry,
      undefined,
      () => ++commits,
    ),
  );
  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(commits, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected?.reason.code, 'passkey_expired');
  const counter = f.db.prepare('SELECT counter FROM passkeys WHERE id = ?').get(id)!.counter;
  assert.ok(counter === 1 || counter === 2);
  const next = await f.keys.authenticationOptions('login', entry, '127.0.0.1');
  await f.keys.authenticate(
    'login',
    next.challengeId,
    f.auth.authenticate(next.options.challenge),
    entry,
    undefined,
    () => ++commits,
  );
  assert.equal(commits, 2);
  assert.equal(f.db.prepare('SELECT counter FROM passkeys WHERE id = ?').get(id)!.counter, 3);
});
