import { z } from 'zod';
import { webCertificateCommandSchemas } from './web-certificate.ts';
import {
  passkeyCommandSchemas,
  passkeySchema,
  webCredentialProofSchema,
  webProofSchema,
} from './passkey.ts';
export { webProofSchema } from './passkey.ts';
export type { WebProof } from './passkey.ts';

export const webDomainSchema = z
  .string()
  .trim()
  .max(253)
  .toLowerCase()
  .refine(
    (value) =>
      value === '' ||
      (value.includes('.') &&
        /^[a-z]/.test(value.split('.').at(-1)!) &&
        value.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))),
    '请填写域名，不含协议、端口或路径。',
  );
export const webPathSchema = z
  .string()
  .max(64)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)?$/)
  .refine(
    (value) => !['ws', 'health', 'client', 'assets', 'api'].includes(value),
    '此路径已保留。',
  );
export const webLoginSchema = webCredentialProofSchema;
export const webAuthSchema = z
  .object({ type: z.literal('web.auth'), protocolVersion: z.number().int().positive() })
  .strict();
export const webSessionSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  lastActiveAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type WebSession = z.infer<typeof webSessionSchema>;
export const webStoredSettingsSchema = z
  .object({
    enabled: z.boolean(),
    domain: webDomainSchema,
    path: webPathSchema,
    idleMinutes: z.number().int().min(15).max(1440),
    proxyEnabled: z.boolean(),
    trustedProxies: z.array(z.union([z.ipv4(), z.ipv6()])).max(16),
  })
  .strict();
export const webSettingsValuesSchema = webStoredSettingsSchema.partial();
export const webSettingsStateSchema = z.object({
  enabled: z.boolean(),
  domain: webDomainSchema,
  path: webPathSchema,
  idleMinutes: z.number().int().min(15).max(1440),
  proxyEnabled: z.boolean(),
  trustedProxies: z.array(z.string()),
  totpEnabled: z.boolean(),
  sessions: z.array(webSessionSchema),
  passkeys: z.array(passkeySchema),
  passkeyAvailable: z.boolean(),
  passkeyReason: z.string().optional(),
  url: z.url().optional(),
  selfSigned: z.boolean(),
  // The last address that sent a client address without being a trusted proxy, to help name the right one.
  forwardedBy: z.string().optional(),
});
export type WebSettingsState = z.infer<typeof webSettingsStateSchema>;
export const webTotpSetupSchema = z.object({
  secret: z.string(),
  uri: z.string(),
  expiresAt: z.iso.datetime(),
});
export type WebTotpSetup = z.infer<typeof webTotpSetupSchema>;
export const webLoginStateSchema = z.object({
  authenticated: z.boolean(),
  passkeyAvailable: z.boolean(),
  session: webSessionSchema.optional(),
  totpEnabled: z.boolean(),
  selfSigned: z.boolean(),
  url: z.url().optional(),
});
export type WebLoginState = z.infer<typeof webLoginStateSchema>;
const request = { requestId: z.uuid() };
export const webCommandSchemas = [
  z
    .object({
      type: z.literal('web.settings.get'),
      ...request,
    })
    .strict(),
  z
    .object({
      type: z.literal('web.settings.update'),
      ...request,
      values: webSettingsValuesSchema,
      proof: webProofSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('web.sessions.revoke'),
      ...request,
      sessionId: z.uuid(),
      proof: webProofSchema.optional(),
    })
    .strict(),
  z
    .object({ type: z.literal('web.totp.setup'), ...request, proof: webProofSchema.optional() })
    .strict(),
  z
    .object({
      type: z.literal('web.totp.enable'),
      ...request,
      code: z.string().regex(/^\d{6}$/),
    })
    .strict(),
  z
    .object({ type: z.literal('web.totp.disable'), ...request, proof: webProofSchema.optional() })
    .strict(),
  ...webCertificateCommandSchemas,
  ...passkeyCommandSchemas,
] as const;
export const webCommandSchema = z.discriminatedUnion('type', webCommandSchemas);
export type WebCommand = z.infer<typeof webCommandSchema>;
// A browser tells the service its user is still there, so that the login's idle time starts over.
export const webActivitySchema = z.object({ type: z.literal('web.activity') }).strict();
