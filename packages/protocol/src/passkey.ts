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
// A fresh Passkey proof authorizes one operation within the login that requested it.
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

export const passkeyRegistrationSchema = z.object({
  registrationId: z.uuid(),
  status: z.enum(['pending', 'complete', 'expired']),
  url: z.url({ protocol: /^https$/ }).optional(),
  expiresAt: z.iso.datetime().optional(),
  passkeyId: z.uuid().optional(),
});
export type PasskeyRegistration = z.infer<typeof passkeyRegistrationSchema>;

const request = { requestId: z.uuid() };
export const passkeyCommandSchemas = [
  z
    .object({
      type: z.literal('web.passkeys.start'),
      ...request,
      name: passkeyNameSchema,
      proof: webProofSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('web.passkeys.status'),
      ...request,
      registrationId: z.uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal('web.passkeys.cancel'),
      ...request,
      registrationId: z.uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal('web.passkeys.rename'),
      ...request,
      passkeyId: z.uuid(),
      name: passkeyNameSchema,
      proof: webProofSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('web.passkeys.remove'),
      ...request,
      passkeyId: z.uuid(),
      proof: webProofSchema.optional(),
    })
    .strict(),
] as const;
