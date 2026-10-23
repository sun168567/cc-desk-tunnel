import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

// A fresh software authenticator for cryptographic regression tests. Verification uses the production library.
export function authenticator(rpId = 'web.example.test', origin = 'https://web.example.test') {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const credentialId = randomBytes(32);
  const publicKey = keys.publicKey.export({ format: 'jwk' });
  let counter = 0;
  const client = (type: string, challenge: string, overrides: Record<string, unknown> = {}) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...overrides }));
  const data = (flags: number) => {
    const value = Buffer.alloc(37);
    createHash('sha256').update(rpId).digest().copy(value);
    value[32] = flags;
    value.writeUInt32BE(counter, 33);
    return value;
  };
  return {
    id: credentialId.toString('base64url'),
    register(
      challenge: string,
      uv = true,
      overrides: Record<string, unknown> = {},
    ): RegistrationResponseJSON {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credentialId.length);
      const cose = isoCBOR.encode(
        new Map<number, number | Uint8Array>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(publicKey.x!, 'base64url')],
          [-3, Buffer.from(publicKey.y!, 'base64url')],
        ]),
      );
      const authData = Buffer.concat([
        data(0x41 | (uv ? 0x04 : 0)),
        Buffer.alloc(16),
        length,
        credentialId,
        cose,
      ]);
      const attestation = isoCBOR.encode(
        new Map<string, string | Uint8Array | Map<string, never>>([
          ['fmt', 'none'],
          ['attStmt', new Map<string, never>()],
          ['authData', authData],
        ]),
      );
      return {
        id: credentialId.toString('base64url'),
        rawId: credentialId.toString('base64url'),
        type: 'public-key',
        response: {
          clientDataJSON: client('webauthn.create', challenge, overrides).toString('base64url'),
          attestationObject: Buffer.from(attestation).toString('base64url'),
          transports: ['internal'],
        },
        clientExtensionResults: { credProps: { rk: true } },
      };
    },
    authenticate(
      challenge: string,
      uv = true,
      overrides: Record<string, unknown> = {},
    ): AuthenticationResponseJSON {
      counter++;
      const authData = data(0x01 | (uv ? 0x04 : 0));
      const clientData = client('webauthn.get', challenge, overrides);
      return {
        id: credentialId.toString('base64url'),
        rawId: credentialId.toString('base64url'),
        type: 'public-key',
        response: {
          clientDataJSON: clientData.toString('base64url'),
          authenticatorData: authData.toString('base64url'),
          signature: sign(
            'sha256',
            Buffer.concat([authData, createHash('sha256').update(clientData).digest()]),
            keys.privateKey,
          ).toString('base64url'),
        },
        clientExtensionResults: {},
      };
    },
  };
}
