import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  passkeyCommandSchemas,
  passkeyNameSchema,
  passkeyRegistrationSchema,
  webCredentialProofSchema,
  webProofSchema,
} from '../src/passkey.ts';
import { z } from 'zod';

test('Passkey names and management requests are bounded and explicit', () => {
  assert.equal(passkeyNameSchema.parse(' 日常使用 '), '日常使用');
  assert.equal(passkeyNameSchema.safeParse(' ').success, false);
  assert.equal(passkeyNameSchema.safeParse('x'.repeat(81)).success, false);
  const commands = z.discriminatedUnion('type', passkeyCommandSchemas);
  const start = { type: 'web.passkeys.start', requestId: randomUUID(), name: '日常使用' };
  assert.equal(commands.safeParse(start).success, true);
  assert.equal(commands.safeParse({ ...start, privateKey: 'not accepted' }).success, false);
  assert.equal(
    commands.safeParse({
      type: 'web.passkeys.remove',
      requestId: randomUUID(),
      passkeyId: 'another-name',
    }).success,
    false,
  );
});

test('fresh Passkey proof does not become a credential login or mixed proof', () => {
  const passkey = { passkey: 'x'.repeat(43) };
  assert.equal(webProofSchema.safeParse(passkey).success, true);
  assert.equal(webCredentialProofSchema.safeParse(passkey).success, false);
  assert.equal(webProofSchema.safeParse({ ...passkey, password: 'secret' }).success, false);
  assert.equal(webProofSchema.safeParse({ password: 'secret', code: '123456' }).success, true);
  assert.equal(webProofSchema.safeParse({ password: 'secret', code: '12345' }).success, false);
});

test('registration links are HTTPS and completion names an operation rather than a label', () => {
  const registrationId = randomUUID();
  assert.equal(
    passkeyRegistrationSchema.safeParse({
      registrationId,
      status: 'pending',
      url: 'https://example.test/private/#register=grant',
    }).success,
    true,
  );
  assert.equal(
    passkeyRegistrationSchema.safeParse({
      registrationId,
      status: 'pending',
      url: 'http://example.test/',
    }).success,
    false,
  );
  assert.equal(
    passkeyRegistrationSchema.safeParse({ status: 'complete', name: '日常使用' }).success,
    false,
  );
});
