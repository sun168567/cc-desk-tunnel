import { z } from 'zod';

// The plugins of the service as its clients show them (see docs/plugins.md). What a plugin declares is data here: its
// functions stay with the service, which runs them in a process of their own.
// `author.plugin`, as its author names it: its settings, data and log are kept under it.
export const pluginIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/)
  .max(60);
const key = z
  .string()
  .regex(/^[a-z]\w*$/i)
  .max(60);
const label = z.string().trim().min(1).max(120);
const option = z.string().min(1).max(120);
const said = { title: label, description: z.string().max(1000).optional() };
// The longest text of a setting, in characters; it keeps a frame of them within MAX_FRAME_BYTES.
export const PLUGIN_TEXT_LIMIT = 8000;
const text = z.string().max(PLUGIN_TEXT_LIMIT);
export const pluginValueSchema = z.union([text, z.number(), z.boolean()]);
export type PluginValue = z.infer<typeof pluginValueSchema>;

export const pluginFieldSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('string'),
    ...said,
    required: z.boolean().optional(),
    default: text.optional(),
    multiline: z.boolean().optional(),
    // Kept by the service and sent to no window.
    sensitive: z.boolean().optional(),
    // Each a value, with what it is shown as where that differs.
    options: z
      .array(z.union([option, z.object({ value: option, label })]))
      .min(1)
      .max(600)
      .optional(),
  }),
  z.object({
    type: z.literal('number'),
    ...said,
    required: z.boolean().optional(),
    default: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({ type: z.literal('boolean'), ...said, default: z.boolean().optional() }),
  z.object({
    type: z.literal('button'),
    ...said,
    // What is on the button, beside its title.
    label: z.string().trim().min(1).max(20).optional(),
    // Asked before it runs.
    confirm: z.string().max(300).optional(),
    // In seconds.
    timeout: z.number().positive().max(60).optional(),
  }),
]);
export type PluginField = z.infer<typeof pluginFieldSchema>;
export const pluginGroupSchema = z.object({
  ...said,
  // A switch whose group shows its other fields only while it is on, or one of several.
  showWhen: z.union([key, z.array(key).min(1)]).optional(),
  fields: z.record(key, pluginFieldSchema),
});
export type PluginGroup = z.infer<typeof pluginGroupSchema>;
export type PluginValues = Record<string, PluginValue>;
// Whether what `showWhen` names is on.
export const shownWhen = (showWhen: string | string[] | undefined, values: PluginValues) =>
  !showWhen || [showWhen].flat().some((name) => !!values[name]);

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
  // What it may be set to; a disabled plugin is not asked.
  settings: z.array(pluginGroupSchema),
  values: z.record(key, pluginValueSchema),
  // The sensitive settings that have a value.
  secrets: z.array(key),
});
export type Plugin = z.infer<typeof pluginSchema>;

const request = { requestId: z.uuid(), id: pluginIdSchema };
// A sensitive setting left out or empty keeps its value; null clears any setting.
const values = z.record(key, pluginValueSchema.nullable());
export const pluginCommandSchemas = [
  z.object({ type: z.literal('plugin.enable'), ...request, enabled: z.boolean() }).strict(),
  // Keeps each of the values that holds.
  z.object({ type: z.literal('plugin.configure'), ...request, values }).strict(),
  // Runs a button of the plugin's settings with the values as they are in the form, kept or not.
  z.object({ type: z.literal('plugin.press'), ...request, button: key, values }).strict(),
  z
    .object({ type: z.literal('plugin.log'), ...request, clear: z.literal(true).optional() })
    .strict(),
] as const;
export const pluginMessageSchemas = [
  // Every plugin, sent on signing in and to every connection whenever it changes.
  z.object({ type: z.literal('plugins'), plugins: z.array(pluginSchema) }),
  z.object({
    type: z.literal('plugin.checked'),
    requestId: z.uuid(),
    errors: z.record(key, z.string()),
    // That the plugin's own check could not be run, which keeps nothing from being saved.
    notice: z.string().optional(),
  }),
  z.object({
    type: z.literal('plugin.done'),
    requestId: z.uuid(),
    ok: z.boolean(),
    message: z.string(),
  }),
  z.object({ type: z.literal('plugin.log'), requestId: z.uuid(), text: z.string() }),
] as const;
