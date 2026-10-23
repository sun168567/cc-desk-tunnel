import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Passkeys } from '../src/passkeys.ts';
import { authenticator } from './fixtures/passkey.ts';

const entry = {
  rpId: 'web.example.test',
  origin: 'https://web.example.test',
  url: 'https://web.example.test/',
};
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let now = Date.now();
  const keys = new Passkeys(db, 'token-digest', randomUUID(), () => now);
  async function register() {
    const device = authenticator();
    const pending = keys.start('测试密钥', 'owner', entry);
    const grant = new URL(pending.url).hash.split('=')[1];
    const options = await keys.registrationOptions(grant, entry);
    const id = await keys.register(
      options.challengeId,
      device.register(options.options.challenge),
      entry,
    );
    return { id, device, pending, grant, options };
  }
  return {
    db,
    keys,
    register,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('registration verifies real attestation, stores only public material, and requires UV', async (t) => {
  const f = fixture(t);
  const registered = await f.register();
  assert.equal(f.keys.list(entry.rpId)[0].id, registered.id);
  assert.equal(f.keys.status(registered.pending.registrationId, 'owner').status, 'complete');
  assert.equal(f.keys.status(registered.pending.registrationId, 'another').status, 'expired');
  assert.equal(f.keys.list('elsewhere.example.test')[0].available, false);
  await assert.rejects(f.keys.registrationOptions(registered.grant, entry));
  const pending = f.keys.start('无验证', 'owner', entry);
  const options = await f.keys.registrationOptions(new URL(pending.url).hash.split('=')[1], entry);
  assert.equal(options.options.authenticatorSelection?.userVerification, 'required');
  assert.equal(options.options.authenticatorSelection?.residentKey, 'required');
  await assert.rejects(
    f.keys.register(
      options.challengeId,
      authenticator().register(options.options.challenge, false),
      entry,
    ),
  );
  const stored = f.db.prepare('SELECT * FROM passkeys').get()!;
  assert.equal(stored.credential_id, registered.device.id);
  assert.ok(stored.public_key instanceof Uint8Array);
  assert.equal('private_key' in stored, false);
});

test('login is bound to origin, RP, challenge, UV and counter; concurrent replays succeed only once', async (t) => {
  const f = fixture(t);
  const { device, id } = await f.register();
  for (const failure of ['uv', 'origin', 'challenge', 'rp'] as const) {
    const options = await f.keys.authenticationOptions('login', entry);
    assert.equal(options.options.allowCredentials?.length ?? 0, 0);
    const response = device.authenticate(
      options.options.challenge,
      failure !== 'uv',
      failure === 'origin'
        ? { origin: 'https://attacker.example' }
        : failure === 'challenge'
          ? { challenge: 'wrong' }
          : {},
    );
    await assert.rejects(
      f.keys.authenticate(
        'login',
        options.challengeId,
        response,
        failure === 'rp' ? { ...entry, rpId: 'other.example.test' } : entry,
      ),
    );
  }
  const options = await f.keys.authenticationOptions('login', entry);
  const response = device.authenticate(options.options.challenge);
  const results = await Promise.allSettled([
    f.keys.authenticate('login', options.challengeId, response, entry),
    f.keys.authenticate('login', options.challengeId, response, entry),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    (results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<string>)
      .value,
    id,
  );
  assert.ok(f.keys.list(entry.rpId)[0].lastUsedAt);
});

test('registration retries replace the previous challenge; owner cancellation and expiry revoke it', async (t) => {
  const f = fixture(t);
  const pending = f.keys.start('重试', 'owner', entry);
  const grant = new URL(pending.url).hash.split('=')[1];
  const first = await f.keys.registrationOptions(grant, entry);
  const second = await f.keys.registrationOptions(grant, entry);
  const device = authenticator();
  await assert.rejects(
    f.keys.register(first.challengeId, device.register(first.options.challenge), entry),
  );
  f.keys.cancel(pending.registrationId, 'another');
  assert.equal(f.keys.status(pending.registrationId, 'owner').status, 'pending');
  f.keys.cancel(pending.registrationId, 'owner');
  await assert.rejects(
    f.keys.register(second.challengeId, device.register(second.options.challenge), entry),
  );
  const expired = f.keys.start('过期', 'owner', entry);
  f.advance(300_001);
  assert.equal(f.keys.status(expired.registrationId, 'owner').status, 'expired');
});

test('fresh proof is single-use, short-lived and bound to an active credential and its browser session', async (t) => {
  const f = fixture(t);
  const { id } = await f.register();
  const secret = f.keys.proof('browser', id);
  assert.throws(() => f.keys.consumeProof(secret, 'another'));
  f.keys.consumeProof(secret, 'browser');
  assert.throws(() => f.keys.consumeProof(secret, 'browser'));
  const expired = f.keys.proof('browser', id);
  f.advance(60_001);
  assert.throws(() => f.keys.consumeProof(expired, 'browser'));
  const removed = f.keys.proof('browser', id);
  f.keys.remove(id);
  assert.throws(() => f.keys.consumeProof(removed, 'browser'));
});

test('entry changes, revoked owners and credential rotation invalidate pending and stored access', async (t) => {
  const f = fixture(t);
  const { device } = await f.register();
  const options = await f.keys.authenticationOptions('login', entry);
  f.keys.clearPending();
  await assert.rejects(
    f.keys.authenticate(
      'login',
      options.challengeId,
      device.authenticate(options.options.challenge),
      entry,
    ),
  );
  const pending = f.keys.start('已断开', 'connection', entry);
  f.keys.revokeOwner('connection');
  assert.equal(f.keys.status(pending.registrationId, 'connection').status, 'expired');
  new Passkeys(f.db, 'rotated-token', randomUUID());
  assert.equal(f.keys.list(entry.rpId).length, 0);
});

test('anonymous ceremonies and registration grants have explicit memory limits', async (t) => {
  const f = fixture(t);
  await f.register();
  for (let index = 0; index < 128; index++) await f.keys.authenticationOptions('login', entry);
  await assert.rejects(f.keys.authenticationOptions('login', entry));
  f.advance(300_001);
  await f.keys.authenticationOptions('login', entry);
  for (let index = 0; index < 64; index++) f.keys.start('待设置', `owner-${index}`, entry);
  assert.throws(() => f.keys.start('超限', 'owner', entry));
});

test('in-flight signature checks cannot outlive cancellation, expiry, key removal or a changed entry', async (t) => {
  const f = fixture(t);
  const { device, id } = await f.register();
  const pending = f.keys.start('已取消', 'owner', entry);
  const registration = await f.keys.registrationOptions(
    new URL(pending.url).hash.split('=')[1],
    entry,
  );
  const creating = f.keys.register(
    registration.challengeId,
    authenticator().register(registration.options.challenge),
    entry,
  );
  f.keys.cancel(pending.registrationId, 'owner');
  await assert.rejects(creating);
  const options = await f.keys.authenticationOptions('login', entry);
  const verifying = f.keys.authenticate(
    'login',
    options.challengeId,
    device.authenticate(options.options.challenge),
    entry,
  );
  f.keys.clearPending();
  await assert.rejects(verifying);
  const expiringOptions = await f.keys.authenticationOptions('login', entry);
  const expiring = f.keys.authenticate(
    'login',
    expiringOptions.challengeId,
    device.authenticate(expiringOptions.options.challenge),
    entry,
  );
  f.advance(300_001);
  await assert.rejects(expiring);
  const removingOptions = await f.keys.authenticationOptions('login', entry);
  const removing = f.keys.authenticate(
    'login',
    removingOptions.challengeId,
    device.authenticate(removingOptions.options.challenge),
    entry,
  );
  f.keys.remove(id);
  await assert.rejects(removing);
});

test('registration lifetime never exceeds its granting browser session and revocation invalidates its grant', async (t) => {
  const f = fixture(t);
  const pending = f.keys.start('即将到期', 'browser', entry, f.now() + 1000);
  f.keys.revokeOwner('browser');
  assert.equal(f.keys.status(pending.registrationId, 'browser').status, 'expired');
  const expiring = f.keys.start('到期', 'browser', entry, f.now() + 1000);
  f.advance(1001);
  assert.equal(f.keys.status(expiring.registrationId, 'browser').status, 'expired');
});

test('issuance limits are per-address, expire, and keep the address table bounded', (t) => {
  const f = fixture(t);
  for (let index = 0; index < 12; index++) assert.equal(f.keys.issue('first'), 0);
  assert.equal(f.keys.issue('first'), 300);
  assert.equal(f.keys.issue('second'), 0);
  for (let index = 2; index < 1024; index++) assert.equal(f.keys.issue(String(index)), 0);
  assert.equal(f.keys.issue('over-capacity'), 300);
  f.advance(300_001);
  assert.equal(f.keys.issue('first'), 0);
  assert.equal(f.keys.issue('over-capacity'), 0);
});
