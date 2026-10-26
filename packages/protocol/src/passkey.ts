import { z } from 'zod';

export const webCredentialProofSchema = z
  .object({
    password: z.string().min(1).max(1024),
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict();
export type WebCredentialProof = z.infer<typeof webCredentialProofSchema>;
// A fresh Passkey proof authorizes one operation within the browser login that requested it.
export const webProofSchema = z.union([
  webCredentialProofSchema,
  z.object({ passkey: z.string().min(32).max(256) }).strict(),
]);
export type WebProof = z.infer<typeof webProofSchema>;

export const passkeyNameSchema = z.string().trim().min(1).max(80);
export const passkeySchema = z.object({
  id: z.uuid(),
  name: passkeyNameSchema,
  rpId: z.string().min(1).max(253),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().optional(),
  available: z.boolean(),
});
export type Passkey = z.infer<typeof passkeySchema>;

const encoded = z
  .string()
  .min(1)
  .max(64_000)
  .regex(/^[A-Za-z0-9_-]+$/);
const credential = {
  id: encoded.max(2048),
  rawId: encoded.max(2048),
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  // Extensions are supplied by browsers; the verifier owns their cryptographic interpretation.
  clientExtensionResults: z.object({}).passthrough(),
};
export const passkeyEmptyRequestSchema = z.object({}).strict();
export const passkeyCancellationSchema = z.object({ challengeId: z.uuid() }).strict();
export const passkeyRegistrationRequestSchema = z
  .object({
    name: passkeyNameSchema,
  })
  .strict();
export const passkeyRegistrationResponseSchema = z
  .object({
    challengeId: z.uuid(),
    response: z.object({
      ...credential,
      response: z.object({
        clientDataJSON: encoded,
        attestationObject: encoded,
        transports: z.array(z.string().max(32)).max(16).optional(),
        authenticatorData: encoded.optional(),
        publicKey: encoded.optional(),
        publicKeyAlgorithm: z.number().int().optional(),
      }),
    }),
  })
  .strict();
export const passkeyAuthenticationResponseSchema = z
  .object({
    challengeId: z.uuid(),
    response: z.object({
      ...credential,
      response: z.object({
        clientDataJSON: encoded,
        authenticatorData: encoded,
        signature: encoded,
        userHandle: encoded.optional(),
      }),
    }),
  })
  .strict();

const request = { requestId: z.uuid(), passkeyId: z.uuid(), proof: webProofSchema.optional() };
export const passkeyCommandSchemas = [
  z
    .object({ type: z.literal('web.passkeys.rename'), ...request, name: passkeyNameSchema })
    .strict(),
  z.object({ type: z.literal('web.passkeys.remove'), ...request }).strict(),
] as const;
