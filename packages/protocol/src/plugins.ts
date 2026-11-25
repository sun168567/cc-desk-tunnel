import { z } from 'zod';

// The plugins of the service as its clients show them (see docs/plugins.md). What a plugin declares is data here: its
// functions stay with the service, which runs them in a process of their own.
// `author.plugin`, as its author names it: its settings, data, log and buttons' states are kept under it.
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

// How many plugins may have a button beside the message input at once; a narrow toolbar holds no more.
export const COMPOSER_SLOTS = 2;
// A button of the plugin beside the message input, whose state each session has its own of. The service keeps the
// state and the clients draw it; what the states mean is the plugin's alone.
export const slotGestureSchema = z.enum(['click', 'doubleClick', 'longPress']);
export type SlotGesture = z.infer<typeof slotGestureSchema>;
export const composerSlotSchema = z.object({
  title: label,
  showWhen: z.union([key, z.array(key).min(1)]).optional(),
  // A state, or the setting that names it.
  initial: z.union([key, z.object({ setting: key })]),
  // How a long press shows: when it counts, a ring that fills until then, and the icon trembling meanwhile.
  hold: z
    .object({
      ms: z.number().int().min(400).max(5000).default(800),
      ring: z.boolean().optional(),
      effect: z.literal('tremble').optional(),
    })
    .default({ ms: 800 }),
  // Shown beside the session in the list, in a state that is `active`.
  mark: z.boolean().optional(),
  states: z
    .record(
      key,
      z.object({
        // An SVG, of which the shape is drawn in the colour of the text.
        icon: z.string().max(16_000),
        title: label,
        tip: z.string().max(120).optional(),
        effect: z.enum(['shake', 'pulse']).optional(),
        pivot: z.enum(['center', 'top']).optional(),
        active: z.boolean().optional(),
      }),
    )
    .refine((states) => Object.keys(states).length <= 10, '最多 10 个状态'),
  // What a gesture or an event makes of the state: another for any, or by the state it is in.
  on: z.record(z.string().max(60), z.union([key, z.record(key, key)])),
});
export type ComposerSlot = z.infer<typeof composerSlotSchema>;
// The state a gesture or an event brings the slot to; nothing when it stays.
export function slotMove(slot: ComposerSlot, cause: string, state: string) {
  const move = slot.on[cause];
  const to = typeof move === 'object' ? move[state] : move;
  return to !== state && to !== undefined && slot.states[to] ? to : undefined;
}
// The state the slot is in: the one kept for the session, or what it begins with.
export function slotState(slot: ComposerSlot, kept: string | undefined, values: PluginValues) {
  if (kept !== undefined && slot.states[kept]) return kept;
  const initial =
    typeof slot.initial === 'string' ? slot.initial : String(values[slot.initial.setting]);
  return slot.states[initial] ? initial : Object.keys(slot.states)[0]!;
}

const link = z.url({ protocol: /^https?$/ }).max(500);
// A plugin's own .claude-plugin/plugin.json, of which an installed one needs the id.
export const pluginManifestSchema = z.object({
  id: pluginIdSchema,
  displayName: label.optional(),
  description: z.string().max(1000).optional(),
  version: z.string().max(60).optional(),
  // The oldest service it works with.
  minVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .optional(),
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
// owner/name of the GitHub repository the plugin's versions are released in.
export const releasesOf = (repository?: string) =>
  /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(\.git)?\/?$/.exec(repository ?? '')?.[1];
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
  // The version released since, and when that was last asked.
  newer: z.string().max(60).optional(),
  checkedAt: z.iso.datetime().optional(),
  enabled: z.boolean(),
  // Why it does not run though it is enabled, or could not be enabled.
  problem: z.string().optional(),
  // How it last failed, until it next goes well.
  failure: z.object({ at: z.iso.datetime(), message: z.string() }).optional(),
  // The events it has commands for, and what it may be set to; a disabled plugin is not asked.
  events: z.array(z.string()),
  settings: z.array(pluginGroupSchema),
  values: z.record(key, pluginValueSchema),
  // The sensitive settings that have a value.
  secrets: z.array(key),
  composerSlot: composerSlotSchema.optional(),
});
export type Plugin = z.infer<typeof pluginSchema>;

// A plugin's archive comes in parts, so that a frame of one is within MAX_FRAME_BYTES.
export const PLUGIN_PART_BYTES = 128 * 1024;
export const PLUGIN_ARCHIVE_LIMIT = 5 * 1024 * 1024;
const request = { requestId: z.uuid(), id: pluginIdSchema };
// A sensitive setting left out or empty keeps its value; null clears any setting.
const values = z.record(key, pluginValueSchema.nullable());
export const pluginCommandSchemas = [
  z.object({ type: z.literal('plugin.enable'), ...request, enabled: z.boolean() }).strict(),
  // Keeps each of the values that holds.
  z.object({ type: z.literal('plugin.configure'), ...request, values }).strict(),
  // Runs a button of the plugin's settings with the values as they are in the form, kept or not.
  z.object({ type: z.literal('plugin.press'), ...request, button: key, values }).strict(),
  // Runs the plugin's commands for an example of the event.
  z.object({ type: z.literal('plugin.try'), ...request, event: z.string().max(60) }).strict(),
  z
    .object({ type: z.literal('plugin.log'), ...request, clear: z.literal(true).optional() })
    .strict(),
  // What the user did to the plugin's button in a session, which counts if it still is in the state they saw.
  z
    .object({
      type: z.literal('plugin.composerSlot'),
      ...request,
      sessionId: z.uuid(),
      gesture: slotGestureSchema,
      from: key,
    })
    .strict(),
  // With its settings, data and log.
  z.object({ type: z.literal('plugin.remove'), ...request }).strict(),
  // A part of a zip archive, base64; after the last one the service says what is in it.
  z
    .object({
      type: z.literal('plugin.upload'),
      requestId: z.uuid(),
      uploadId: z.uuid(),
      data: z.base64().max(Math.ceil(PLUGIN_PART_BYTES / 3) * 4),
      last: z.boolean(),
    })
    .strict(),
  // Asks every plugin's repository for a newer version, of which `plugins` tells, or that of one.
  z.object({ type: z.literal('plugin.checkAll'), requestId: z.uuid() }).strict(),
  z.object({ type: z.literal('plugin.check'), ...request }).strict(),
  // Fetches a newer version's archive, as if it had been uploaded.
  z.object({ type: z.literal('plugin.download'), ...request, uploadId: z.uuid() }).strict(),
  // Puts the archive uploaded in place, once the user has seen what is in it.
  z.object({ type: z.literal('plugin.install'), requestId: z.uuid(), uploadId: z.uuid() }).strict(),
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
  z.object({
    type: z.literal('plugin.archive'),
    requestId: z.uuid(),
    manifest: pluginManifestSchema,
    events: z.array(z.string()),
    commands: z.array(z.string()),
    files: z.number().int().nonnegative(),
    access: pluginAccessSchema,
    // The plugin of its id, which it takes the place of.
    replaces: z
      .object({ version: z.string().optional(), author: z.string().optional() })
      .optional(),
  }),
] as const;
