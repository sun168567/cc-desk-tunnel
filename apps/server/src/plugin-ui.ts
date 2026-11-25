import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { pluginGroupSchema, composerSlotSchema, shownWhen } from '@cc-desk-tunnel/protocol';
import type {
  PluginField,
  PluginGroup,
  ComposerSlot,
  PluginValues,
} from '@cc-desk-tunnel/protocol';
import { HOST, launch, stop } from './plugin-process.ts';
import type { Where } from './plugin-process.ts';

const LOAD_MS = 5000;
const CHECK_MS = 2000;
const BUTTON_SECONDS = 20;
// The longest answer, in characters.
const REPLY_LIMIT = 256 * 1024;
const ICON_LIMIT = 16_000;

const declaredSchema = z.object({
  settings: z.array(pluginGroupSchema),
  slots: z.object({ composer: composerSlotSchema.optional() }),
});
export type Declared = { settings: PluginGroup[]; composerSlot?: ComposerSlot };
export const NOTHING: Declared = { settings: [] };

const uiFile = (root: string) =>
  ['ui.ts', 'ui.js', 'ui.mjs'].map((name) => join(root, name)).find(existsSync);

// Asks a plugin's ui file in a process of its own. What it answers is data, which may be anything: the plugin's code
// could write it as well. What it printed comes along, for the plugin's log.
function ask(where: Where, file: string, request: object, ms: number) {
  return new Promise<{ reply: Reply; printed: string }>((resolve) => {
    const { before, env } = launch(where);
    // Not with the service's own arguments, which name the file its credentials are in.
    const [program, ...args] = [...before, process.execPath, HOST];
    const child = spawn(program!, args, {
      cwd: where.root,
      env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    let failure: string | undefined;
    let answer = '';
    let printed = '';
    for (const stream of [child.stdout!, child.stderr!])
      stream.setEncoding('utf8').on('data', (text: string) => {
        printed = (printed + text).slice(-8192);
      });
    (child.stdio[3] as Readable).setEncoding('utf8').on('data', (text: string) => {
      if (answer.length <= REPLY_LIMIT) answer += text;
    });
    const timer = setTimeout(() => {
      failure = `超过 ${ms / 1000} 秒，已结束`;
      stop(child);
    }, ms);
    child.on('error', (error) => {
      failure = error.message;
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ reply: failure ? { failure } : read(answer), printed });
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(JSON.stringify({ ...request, file: pathToFileURL(file).href }));
  });
}
const replySchema = z.looseObject({
  failure: z
    .string()
    .transform((text) => text.slice(0, 500))
    .optional(),
});
type Reply = z.infer<typeof replySchema>;
function read(answer: string): Reply {
  if (answer.length > REPLY_LIMIT) return { failure: `声明的内容超过 ${REPLY_LIMIT / 1024} KB` };
  try {
    return replySchema.parse(JSON.parse(answer));
  } catch {
    return { failure: '没有结果就退出了' };
  }
}

// What the plugin declares; nothing for one without a ui file.
export async function loadUi(where: Where): Promise<Declared> {
  const { root } = where;
  const file = uiFile(root);
  if (!file) return NOTHING;
  const { reply } = await ask(where, file, {}, LOAD_MS);
  if (reply.failure) throw new Error(reply.failure);
  const declared = declaredSchema.safeParse(reply);
  if (!declared.success)
    throw new Error(
      declared.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('；'),
    );
  const names = declared.data.settings.flatMap((group) => Object.keys(group.fields));
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice) throw new Error(`字段 ${twice} 重复`);
  const { settings, slots } = declared.data;
  return { settings, composerSlot: slots.composer && drawn(root, slots.composer) };
}
// The slot with its icons in place of the paths of their files.
function drawn(root: string, slot: ComposerSlot): ComposerSlot {
  const states = Object.entries(slot.states).map(([name, state]) => {
    const path = resolve(root, state.icon);
    if (!path.startsWith(resolve(root) + sep) || !path.endsWith('.svg') || !existsSync(path))
      throw new Error(`没有图标 ${state.icon}（要是插件目录里的 .svg）`);
    const icon = readFileSync(path, 'utf8');
    if (icon.length > ICON_LIMIT) throw new Error(`图标 ${state.icon} 超过 ${ICON_LIMIT} 个字符`);
    return [name, { ...state, icon }] as const;
  });
  const strays = Object.values(slot.on)
    .flatMap((move) => (typeof move === 'object' ? Object.entries(move).flat() : [move]))
    .filter((name) => !slot.states[name]);
  if (strays.length) throw new Error(`slots.composer.on 里没有这个状态：${strays[0]}`);
  return { ...slot, states: Object.fromEntries(states) };
}

export const fieldsOf = (groups: PluginGroup[]): Record<string, PluginField> =>
  Object.assign({}, ...groups.map((group) => group.fields));
// The groups that are in use, and so checked: those shown whole.
export const inUse = (groups: PluginGroup[], values: PluginValues) =>
  groups.filter((group) => shownWhen(group.showWhen, values));

// What the service can tell of the values by itself.
export function checkValues(groups: PluginGroup[], values: PluginValues) {
  const errors: Record<string, string> = {};
  for (const [name, field] of Object.entries(fieldsOf(inUse(groups, values)))) {
    const value = values[name];
    if (field.type === 'button') continue;
    const missing = value === undefined || value === '';
    if (missing) {
      if (field.type !== 'boolean' && field.required) errors[name] = '必填';
    } else if (typeof value !== field.type) errors[name] = '类型不对';
    else if (field.type === 'number') {
      if (field.min !== undefined && (value as number) < field.min)
        errors[name] = `不能小于 ${field.min}`;
      if (field.max !== undefined && (value as number) > field.max)
        errors[name] = `不能大于 ${field.max}`;
    } else if (
      field.type === 'string' &&
      field.options &&
      !field.options.some(
        (option) => (typeof option === 'string' ? option : option.value) === value,
      )
    )
      errors[name] = '不在可选的值里';
  }
  return errors;
}
// What the plugin says of them. Its check failing is told and keeps nothing from being saved.
export async function askCheck(where: Where, groups: PluginGroup[], values: PluginValues) {
  const file = uiFile(where.root);
  const check = Object.keys(fieldsOf(inUse(groups, values)));
  if (!file || !check.length) return { errors: {}, printed: '' };
  const { reply, printed } = await ask(where, file, { values, check }, CHECK_MS);
  if (reply.failure) return { errors: {}, notice: `插件的检查没跑成：${reply.failure}`, printed };
  const said = z.record(z.string(), z.string()).safeParse(reply.errors).data ?? {};
  const errors = Object.fromEntries(Object.entries(said).filter(([key]) => check.includes(key)));
  return { errors, printed };
}
export async function askButton(
  where: Where,
  button: string,
  seconds = BUTTON_SECONDS,
  values: PluginValues,
) {
  const { reply, printed } = await ask(
    where,
    uiFile(where.root)!,
    { values, button },
    seconds * 1000,
  );
  return reply.failure
    ? { ok: false, message: reply.failure, printed }
    : { ok: reply.ok === true, message: String(reply.message).slice(0, 1000), printed };
}
