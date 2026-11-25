import { z } from 'zod';

// The plugins of the service as its clients show them (see docs/plugins.md). What a plugin declares is data here: its
// functions stay with the service, which runs them in a process of their own.
// `author.plugin`, as its author names it: its settings, data and log are kept under it.
export const pluginIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/)
  .max(60);
const label = z.string().trim().min(1).max(120);
const link = z.url({ protocol: /^https?$/ }).max(500);
// A plugin's own .claude-plugin/plugin.json.
export const pluginManifestSchema = z.object({
  id: pluginIdSchema,
  displayName: label.optional(),
  description: z.string().max(1000).optional(),
  version: z.string().max(60).optional(),
  // What it needs beyond its own files and the network; only `full` is known.
  permissions: z.array(z.string().max(60)).max(20).optional(),
  author: z
    .union([
      label.transform((name): { name: string; url?: string } => ({ name })),
      z.object({ name: label, url: link.optional() }),
    ])
    .optional(),
  homepage: link.optional(),
  // Where its new versions are published.
  repository: link.optional(),
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
// What a plugin reaches: its own files and the network, or all that the service does, which it asked for or the
// service's system cannot keep it from.
export const pluginAccessSchema = z.enum(['own', 'full', 'unlimited']);
export type PluginAccess = z.infer<typeof pluginAccessSchema>;
export const pluginSchema = z.object({
  id: pluginIdSchema,
  access: pluginAccessSchema,
  title: label.optional(),
  ...pluginManifestSchema.pick({
    description: true,
    version: true,
    author: true,
    homepage: true,
    repository: true,
  }).shape,
  enabled: z.boolean(),
  // Why it does not run though it is enabled, or could not be enabled.
  problem: z.string().optional(),
  // How it last failed, until it next goes well.
  failure: z.object({ at: z.iso.datetime(), message: z.string() }).optional(),
});
export type Plugin = z.infer<typeof pluginSchema>;

const request = { requestId: z.uuid(), id: pluginIdSchema };
export const pluginCommandSchemas = [
  z.object({ type: z.literal('plugin.enable'), ...request, enabled: z.boolean() }).strict(),
  z
    .object({ type: z.literal('plugin.log'), ...request, clear: z.literal(true).optional() })
    .strict(),
] as const;
export const pluginMessageSchemas = [
  // Every plugin, sent on signing in and to every connection whenever it changes.
  z.object({ type: z.literal('plugins'), plugins: z.array(pluginSchema) }),
  z.object({ type: z.literal('plugin.log'), requestId: z.uuid(), text: z.string() }),
] as const;
