import { z } from 'zod';
import { wordsSchema } from './phrase.ts';

export const webCertificateStateSchema = z.object({
  mode: z.enum(['default', 'custom', 'external', 'unavailable']),
  selfSigned: z.boolean(),
  details: z
    .object({
      domain: z.string(),
      issuer: z.string(),
      validFrom: z.iso.datetime(),
      validTo: z.iso.datetime(),
      fingerprint: z.string(),
      selfSigned: z.boolean(),
    })
    .optional(),
  error: wordsSchema.optional(),
});
export type WebCertificateState = z.infer<typeof webCertificateStateSchema>;

const request = { requestId: z.uuid() };
export const webCertificateCommandSchemas = [
  z.object({ type: z.literal('web.certificate.get'), ...request }).strict(),
  z
    .object({
      type: z.literal('web.certificate.set'),
      ...request,
      cert: z
        .string()
        .min(1)
        .max(64 * 1024),
      key: z
        .string()
        .min(1)
        .max(16 * 1024),
    })
    .strict(),
  z.object({ type: z.literal('web.certificate.reset'), ...request }).strict(),
] as const;
