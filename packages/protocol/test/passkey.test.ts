import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  passkeyAuthenticationResponseSchema,
  passkeyCancellationSchema,
  passkeyRegistrationRequestSchema,
  passkeyRegistrationResponseSchema,
  webCommandSchema,
  webLoginSchema,
  webProofSchema,
} from '../src/index.ts';

test('Registration accepts only a name; sensitive operations still accept Passkey proof', () => {
  const proof = { passkey: 'p'.repeat(43) };
  assert.equal(webProofSchema.safeParse(proof).success, true);
  assert.equal(webLoginSchema.safeParse(proof).success, false);
  assert.equal(
    passkeyRegistrationRequestSchema.safeParse({ name: '日常使用', proof }).success,
    false,
  );
  assert.equal(
    passkeyRegistrationRequestSchema.safeParse({
      name: '日常使用',
      proof: { password: 'service-token' },
    }).success,
    false,
  );
  assert.equal(passkeyRegistrationRequestSchema.safeParse({ name: '日常使用' }).success, true);
  assert.equal(passkeyRegistrationRequestSchema.safeParse({ name: ' ' }).success, false);
  assert.equal(
    webCommandSchema.safeParse({
      type: 'web.passkeys.rename',
      requestId: randomUUID(),
      passkeyId: randomUUID(),
      name: '日常使用',
      proof,
    }).success,
    true,
  );
});

test('WebAuthn requests validate the complete registration and assertion envelope before verification', () => {
  const credential = { id: 'AA', rawId: 'AA', type: 'public-key', clientExtensionResults: {} };
  const request = {
    challengeId: randomUUID(),
    response: { ...credential, response: { clientDataJSON: 'AA', attestationObject: 'AA' } },
  };
  assert.equal(passkeyRegistrationResponseSchema.safeParse(request).success, true);
  assert.equal(passkeyAuthenticationResponseSchema.safeParse(request).success, false);
  assert.equal(
    passkeyAuthenticationResponseSchema.safeParse({
      ...request,
      response: {
        ...credential,
        response: { clientDataJSON: 'AA', authenticatorData: 'AA', signature: 'AA' },
      },
    }).success,
    true,
  );
  assert.equal(
    passkeyRegistrationResponseSchema.safeParse({
      ...request,
      response: { ...credential, response: { clientDataJSON: 'AA' } },
    }).success,
    false,
  );
});

test('Cancellation accepts only a challenge identifier', () => {
  const request = { challengeId: randomUUID() };
  assert.equal(passkeyCancellationSchema.safeParse(request).success, true);
  assert.equal(passkeyCancellationSchema.safeParse({ challengeId: 'invalid' }).success, false);
  assert.equal(
    passkeyCancellationSchema.safeParse({ ...request, sessionId: randomUUID() }).success,
    false,
  );
});
