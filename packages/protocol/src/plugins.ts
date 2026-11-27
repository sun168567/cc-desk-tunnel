import { z } from 'zod';
import { wordsSchema } from './phrase.ts';

// The plugins of the service as its clients show them and set them (see docs/plugins.md). A plugin is a directory of
// <data>/plugins, laid out as a Claude Code plugin: what it declares is data, and its code runs only in the processes
// its hooks start.

// The events the service hands to plugins (docs/plugins.md), which only grow.
export const pluginEvents = [
  'ApprovalRequested',
  'QuestionAsked',
  'TerminalWaiting',
  'WaitResolved',
  'BackgroundOnly',
  'RunError',
  'RunEnded',
  'DeviceOnline',
  'DeviceOffline',
] as const;
export type PluginEvent = (typeof pluginEvents)[number];
// A plugin's directory name, which its settings, data and log are kept by.
export const pluginIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
  .max(64);
const key = z
  .string()
  .regex(/^[A-Za-z_]\w*$/)
  .max(64);
// The longest text a setting holds, which keeps a frame of them small.
export const PLUGIN_TEXT_LIMIT = 8000;
export const pluginValueSchema = z.union([
  z.string().max(PLUGIN_TEXT_LIMIT),
  z.number(),
  z.boolean(),
]);
export type PluginValue = z.infer<typeof pluginValueSchema>;
// An option of `userConfig` in the plugin's .claude-plugin/plugin.json, written as Claude Code's plugins write theirs,
// of the types that mean something on a server. An unknown key is an error, as it is to Claude Code.
export const pluginOptionSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean']),
    title: z.string().trim().min(1).max(120),
    description: z.string().max(1000).optional(),
    required: z.boolean().optional(),
    default: pluginValueSchema.optional(),
    // For a string: the values it may have, as a list to pick from.
    options: z.array(z.string().min(1).max(64)).min(1).max(200).optional(),
    // Kept by the service and sent to no window.
    sensitive: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict();
export type PluginOption = z.infer<typeof pluginOptionSchema>;

// One run of a plugin's command, as its log keeps it. What the command printed has the plugin's secrets masked.
export const pluginRunSchema = z.object({
  at: z.iso.datetime(),
  event: z.string().max(60),
  sessionId: z.string().max(64).optional(),
  // Started from the settings page with an example of the event.
  trial: z.literal(true).optional(),
  result: z.enum(['ok', 'failed', 'timeout', 'unstarted']),
  exitCode: z.number().int().optional(),
  ms: z.number().int().nonnegative(),
  output: z.string(),
});
export type PluginRun = z.infer<typeof pluginRunSchema>;

export const pluginSchema = z.object({
  id: pluginIdSchema,
  // Its displayName, or its name, or the directory's.
  title: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  author: z.object({ name: z.string(), url: z.string().optional() }).optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  enabled: z.boolean(),
  // Why it does not run though it is enabled: its files cannot be read, or a required setting has no value.
  problem: wordsSchema.optional(),
  // The events it has commands for.
  events: z.array(z.string()),
  options: z.record(key, pluginOptionSchema),
  // What it is set to, but for its sensitive options, of which `secrets` names those that have a value.
  values: z.record(key, pluginValueSchema),
  secrets: z.array(key),
  // How it last failed, until a run of it goes well; since the service started.
  failure: pluginRunSchema.pick({ at: true, result: true }).optional(),
});
export type Plugin = z.infer<typeof pluginSchema>;

const request = { requestId: z.uuid(), id: pluginIdSchema };
export const pluginCommandSchemas = [
  z.object({ type: z.literal('plugin.enable'), ...request, enabled: z.boolean() }).strict(),
  // Each value is checked against its option and kept. null clears one; an empty sensitive one keeps what it has.
  z
    .object({
      type: z.literal('plugin.configure'),
      ...request,
      values: z.record(key, pluginValueSchema.nullable()),
    })
    .strict(),
  // Runs the plugin's commands for the event on an example of it, answered once they are done.
  z.object({ type: z.literal('plugin.try'), ...request, event: z.string().max(60) }).strict(),
  z
    .object({ type: z.literal('plugin.log'), ...request, clear: z.literal(true).optional() })
    .strict(),
] as const;
export const pluginMessageSchemas = [
  // Every plugin, sent on signing in and to every connection whenever one changes.
  z.object({ type: z.literal('plugins'), plugins: z.array(pluginSchema) }),
  // A plugin's runs, the latest last.
  z.object({ type: z.literal('plugin.log'), requestId: z.uuid(), runs: z.array(pluginRunSchema) }),
] as const;
