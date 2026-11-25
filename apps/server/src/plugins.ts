import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';
import {
  COMPOSER_SLOTS,
  pluginManifestSchema,
  pluginIdSchema,
  slotMove,
  slotState,
} from '@cc-desk-tunnel/protocol';
import type {
  Plugin,
  PluginAccess,
  PluginManifest,
  PluginValue,
  PluginValues,
} from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';
import { eventExample } from './event-examples.ts';
import { readPluginConfig, removePluginConfig, writePluginConfig } from './plugin-config.ts';
import type { PluginConfig } from './plugin-config.ts';
import { hooksFileSchema, matches } from './plugin-hooks.ts';
import type { Hook } from './plugin-hooks.ts';
import { checkVersion, installArchive } from './plugin-install.ts';
import type { PluginArchive } from './plugin-install.ts';
import { masked, PluginLog } from './plugin-log.ts';
import { confinable, launch, stop } from './plugin-process.ts';
import { askButton, askCheck, checkValues, fieldsOf, loadUi, NOTHING } from './plugin-ui.ts';
import type { Declared } from './plugin-ui.ts';
import { matcherFields } from './service-events.ts';
import type { ServiceEvent } from './service-events.ts';

// What is known of a plugin, read anew whenever its directory changes.
type Entry = {
  manifest: Partial<PluginManifest>;
  access: PluginAccess;
  declared: Declared;
  events: string[];
  broken?: string;
  // It wanted a button when none was left, and so was not enabled.
  refused?: string;
};

// Where the states of the plugins' buttons are kept: with each session.
type ComposerSlots = {
  of: (sessionId: string, id: string) => string | undefined;
  set: (sessionId: string, id: string, state: string) => void;
};

// How much of what a command printed is kept, and how long changes in the directory are gathered.
const OUTPUT_LIMIT = 8192;
const SETTLE_MS = 300;

// Why a plugin that is not confined does not run until the user enables it.
const unconfined = {
  full: '它要完整权限，由你启用。',
  unlimited: '这个服务端限制不了插件，由你启用。',
};

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The plugins in <data>/plugins, each a directory with a hooks/hooks.json and, for its settings, a ui file (see
// docs/plugins.md): hands them the service's events and keeps what they are set to. The directory is watched, so a
// change there holds a moment later. A plugin's code runs in processes of its own, and how they went goes to its log.
export class Plugins {
  private directory: string;
  private changed: () => void;
  private composerSlots: ComposerSlots;
  private log: PluginLog;
  private entries = new Map<string, Entry>();
  // Apart from what is read anew, which may be while a plugin is set or runs.
  private configs = new Map<string, PluginConfig>();
  private failures = new Map<string, { at: string; message: string }>();
  private running = new Set<ChildProcess>();
  private pressed = new Set<string>();
  private watcher?: FSWatcher;
  private settle?: NodeJS.Timeout;
  private stale = new Set<string>();
  private loading: Promise<void> = Promise.resolve();
  private closed = false;
  private confinable = false;
  constructor(
    directory: string,
    changed: () => void = () => {},
    composerSlots: ComposerSlots = { of: () => undefined, set: () => {} },
  ) {
    this.directory = directory;
    this.changed = changed;
    this.composerSlots = composerSlots;
    this.log = new PluginLog(directory);
  }
  async start() {
    const plugins = join(this.directory, 'plugins');
    mkdirSync(plugins, { recursive: true, mode: 0o700 });
    this.confinable = await confinable();
    this.watcher = watch(plugins, { recursive: true }, (_event, file) => {
      if (file) this.stale.add(String(file).split(/[\\/]/)[0]!);
      clearTimeout(this.settle);
      this.settle = setTimeout(() => void this.refresh(), SETTLE_MS);
    });
    // Left unwatched, as where the system has no watch to spare, a plugin is read when the service starts.
    this.watcher.on('error', (error) => console.error(`Plugins are not watched: ${error.message}`));
    await this.refresh();
  }
  close() {
    this.closed = true;
    this.watcher?.close();
    clearTimeout(this.settle);
    for (const child of this.running) stop(child);
  }
  // Whether an event reaches anyone.
  any() {
    return this.entries.size > 0;
  }
  list(): Plugin[] {
    return [...this.entries].map(([id, entry]) => {
      const fields = fieldsOf(entry.declared.settings);
      const values = this.values(id);
      const config = this.config(id);
      const enabled = this.enabled(id, entry.access);
      const waiting = entry.access === 'own' ? undefined : unconfined[entry.access];
      const secret = (key: string) => {
        const field = fields[key];
        return field?.type === 'string' && !!field.sensitive;
      };
      return {
        id,
        title: entry.manifest.displayName,
        description: entry.manifest.description,
        version: entry.manifest.version,
        author: entry.manifest.author,
        homepage: entry.manifest.homepage,
        repository: entry.manifest.repository,
        access: entry.access,
        enabled,
        problem: enabled
          ? this.problem(id)
          : (entry.refused ?? (config.enabled ? (entry.broken ?? waiting) : undefined)),
        failure: this.failures.get(id),
        events: entry.events,
        settings: entry.declared.settings,
        composerSlot: entry.declared.composerSlot,
        values: Object.fromEntries(Object.entries(values).filter(([key]) => !secret(key))),
        secrets: Object.keys(values).filter((key) => secret(key) && values[key] !== ''),
      };
    });
  }

  // Reads the plugins whose files changed, one read after another.
  private refresh() {
    const read = async () => {
      const plugins = join(this.directory, 'plugins');
      const names = readdirSync(plugins).filter(
        (id) =>
          pluginIdSchema.safeParse(id).success &&
          existsSync(join(plugins, id, 'hooks', 'hooks.json')),
      );
      const stale = new Set(this.stale);
      this.stale.clear();
      const entries = new Map<string, Entry>();
      for (const id of names.sort()) {
        const known = this.entries.get(id);
        entries.set(id, known && !stale.has(id) ? known : await this.load(id));
      }
      if (this.closed) return;
      this.grant(entries);
      this.entries = entries;
      this.changed();
    };
    this.loading = this.loading
      .then(read)
      .catch((error) => console.error(`Plugins were not read: ${reason(error)}`));
    return this.loading;
  }
  // Of the plugins that want a button, those that had one keep it, and the others get what is left. One that gets
  // none is not enabled.
  private grant(entries: Map<string, Entry>) {
    const had = (id: string) => Number(!!this.entries.get(id)?.declared.composerSlot);
    const wanting = [...entries]
      .filter(([, entry]) => entry.declared.composerSlot)
      .sort(([a], [b]) => had(b) - had(a));
    const holders = wanting.slice(0, COMPOSER_SLOTS);
    if (holders.length < COMPOSER_SLOTS) for (const entry of entries.values()) delete entry.refused;
    const named = holders.map(([id, { manifest }]) => `“${manifest.displayName ?? id}”`);
    for (const [id, entry] of wanting.slice(COMPOSER_SLOTS)) {
      entry.declared = NOTHING;
      entry.refused = `${COMPOSER_SLOTS} 个输入框插槽已被${named.join('')}占用，停用其中一个后再启用。`;
      const config = { ...this.config(id), enabled: false };
      writePluginConfig(this.directory, id, config);
      this.configs.set(id, config);
      this.log.write(id, `没有启用：${entry.refused}`);
    }
  }
  private async load(id: string): Promise<Entry> {
    const root = join(this.directory, 'plugins', id);
    const entry: Entry = {
      manifest: {},
      access: this.access({}),
      declared: NOTHING,
      events: [],
      // Still so, unless it is being enabled anew.
      refused: this.config(id).enabled ? undefined : this.entries.get(id)?.refused,
    };
    try {
      const manifest = join(root, '.claude-plugin', 'plugin.json');
      if (existsSync(manifest))
        entry.manifest = pluginManifestSchema
          .partial()
          .parse(JSON.parse(readFileSync(manifest, 'utf8')));
      entry.access = this.access(entry.manifest);
      checkVersion(entry.manifest);
      entry.events = Object.keys(this.hooks(id)).filter((event) => eventExample(event));
      // A disabled plugin's code does not run, and so it has nothing to be set.
      if (this.enabled(id, entry.access))
        entry.declared = await loadUi({ root, confined: entry.access === 'own' });
    } catch (error) {
      entry.broken = `加载失败：${reason(error)}`;
      this.log.write(id, entry.broken);
    }
    return entry;
  }
  private hooks(id: string) {
    const path = join(this.directory, 'plugins', id, 'hooks', 'hooks.json');
    return hooksFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).hooks;
  }
  private config(id: string) {
    let config = this.configs.get(id);
    if (!config) this.configs.set(id, (config = readPluginConfig(this.directory, id)));
    return config;
  }
  access({ permissions }: Partial<PluginManifest>): PluginAccess {
    if (permissions?.includes('full')) return 'full';
    return this.confinable ? 'own' : 'unlimited';
  }
  // One that is not confined is enabled once the user said so of it as it is: an update of a confined one may ask for
  // more.
  private enabled(id: string, access = this.entry(id).access) {
    const { enabled, agreed } = this.config(id);
    return enabled && (access === 'own' || agreed);
  }
  private where(id: string) {
    return { root: this.root(id), confined: this.entry(id).access === 'own' };
  }
  private entry(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new DomainError('not_found', '插件不存在。');
    return entry;
  }
  // What the plugin is set to, with the defaults of what it was not.
  private values(id: string, changes: Record<string, PluginValue | null> = {}): PluginValues {
    const values: PluginValues = {};
    const { values: all } = this.config(id);
    for (const [key, field] of Object.entries(fieldsOf(this.entry(id).declared.settings))) {
      if (field.type === 'button') continue;
      // An update of the plugin may have made the field one of another type.
      const kept = typeof all[key] === field.type ? all[key] : undefined;
      const change = changes[key];
      const same = field.type === 'string' && field.sensitive && change === '';
      const value = change === undefined || same ? kept : (change ?? undefined);
      // Text not set is empty and a switch not set is off, so that the plugin's own code need not tell them apart.
      const unset = { string: '', boolean: false, number: undefined }[field.type];
      const effective = value ?? field.default ?? unset;
      if (effective !== undefined) values[key] = effective;
    }
    return values;
  }
  private secrets(id: string, values = this.values(id)) {
    const kept = this.config(id).values;
    return Object.entries(fieldsOf(this.entry(id).declared.settings)).flatMap(([key, field]) =>
      field.type === 'string' && field.sensitive
        ? [values[key], kept[key]].filter((value) => typeof value === 'string')
        : [],
    );
  }
  private problem(id: string) {
    const entry = this.entry(id);
    if (entry.broken) return entry.broken;
    const groups = entry.declared.settings;
    const wrong = Object.keys(checkValues(groups, this.values(id)))[0];
    return wrong && `待配置：${fieldsOf(groups)[wrong]!.title}`;
  }
  private write(id: string, config: PluginConfig) {
    writePluginConfig(this.directory, id, config);
    this.configs.set(id, config);
    this.changed();
  }

  async enable(id: string, enabled: boolean) {
    const { access } = this.entry(id);
    this.write(id, { ...this.config(id), enabled, agreed: enabled && access !== 'own' });
    this.stale.add(id);
    await this.refresh();
    const { refused } = this.entry(id);
    if (enabled && refused) throw new DomainError('composer_slots', refused);
    this.log.write(id, enabled ? '启用' : '停用');
  }
  // Keeps each of the changes that holds, whatever else is still to be set.
  async configure(id: string, changes: Record<string, PluginValue | null>) {
    const entry = this.entry(id);
    const groups = entry.declared.settings;
    const values = this.values(id, changes);
    const secrets = this.secrets(id, values);
    const own = checkValues(groups, values);
    const said = await askCheck(this.where(id), groups, values);
    this.printed(id, '检查设置', said.printed, secrets);
    const errors = { ...said.errors, ...own };
    for (const key of Object.keys(errors)) errors[key] = masked(errors[key]!, secrets);
    const kept = { ...this.config(id).values };
    const held = Object.entries(changes).filter(([key]) => {
      const empty = values[key] === undefined || values[key] === '';
      return empty || !errors[key];
    });
    for (const [key, change] of held)
      if (change === null) delete kept[key];
      else if (values[key] !== undefined) kept[key] = values[key];
    if (held.length) {
      this.write(id, { ...this.config(id), values: kept });
      const fields = fieldsOf(this.entry(id).declared.settings);
      const titles = held.map(([key]) => fields[key]?.title ?? key);
      this.log.write(id, `设置：${titles.join('、')}`);
    }
    return { errors, notice: said.notice && masked(said.notice, secrets) };
  }
  async press(id: string, button: string, changes: Record<string, PluginValue | null>) {
    const entry = this.entry(id);
    const group = entry.declared.settings.find((item) => button in item.fields);
    const field = group?.fields[button];
    if (field?.type !== 'button') throw new DomainError('not_found', '插件没有这个按钮。');
    const key = `${id}/${button}`;
    if (this.pressed.has(key)) return { ok: false, message: '正在运行。' };
    this.pressed.add(key);
    try {
      const values = this.values(id, changes);
      const secrets = this.secrets(id, values);
      const errors = {
        ...(await askCheck(this.where(id), [group!], values)).errors,
        ...checkValues([group!], values),
      };
      const wrong = Object.entries(errors)[0];
      const result = wrong
        ? { ok: false, message: `${group!.fields[wrong[0]]!.title}：${wrong[1]}`, printed: '' }
        : await askButton(this.where(id), button, field.timeout, values);
      const message = masked(result.message, secrets);
      this.log.write(id, `[${field.title}] ${result.ok ? '成功' : '失败'} ${message}`.trim());
      this.printed(id, field.title, result.printed, secrets);
      return { ok: result.ok, message };
    } finally {
      this.pressed.delete(key);
    }
  }
  // Runs what the plugin has for an example of the event, as the event itself would.
  async attempt(id: string, event: string) {
    const problem = this.enabled(id) ? this.problem(id) : '插件没有启用。';
    if (problem) return { ok: false, message: problem };
    const example = eventExample(event);
    if (!example) throw new DomainError('not_found', '没有这个事件。');
    const { composerSlot: slot } = this.entry(id).declared;
    if (slot && example.session_id) {
      const active = Object.keys(slot.states).find((state) => slot.states[state]!.active);
      example.slots = { composer: active ?? slotState(slot, undefined, this.values(id)) };
    }
    const hooks = this.hooksFor(id, example);
    if (!hooks.length) return { ok: false, message: '这个事件没有匹配的命令。' };
    const results = await Promise.all(hooks.map((hook) => this.run(id, hook, example, '[试跑] ')));
    return {
      ok: results.every(({ ok }) => ok),
      message: results.map(({ text }) => text).join('\n'),
    };
  }
  // What an archive of the id would take the place of.
  replaced(id: string) {
    const manifest = this.entries.get(id)?.manifest;
    return manifest && { version: manifest.version, author: manifest.author?.name };
  }
  async install(archive: PluginArchive) {
    const { id, version } = archive.manifest;
    installArchive(this.directory, archive);
    this.log.write(id, `安装 ${version ?? ''}`.trim());
    this.stale.add(id);
    await this.refresh();
    const { refused } = this.entry(id);
    return refused
      ? { ok: false, message: `已安装，但没有启用：${refused}` }
      : { ok: true, message: '' };
  }
  async remove(id: string) {
    this.entry(id);
    rmSync(this.root(id), { recursive: true, force: true });
    rmSync(join(this.directory, 'plugin-data', id), { recursive: true, force: true });
    removePluginConfig(this.directory, id);
    this.configs.delete(id);
    this.failures.delete(id);
    this.log.clear(id);
    await this.refresh();
  }
  logOf(id: string, clear = false) {
    this.entry(id);
    if (clear) this.log.clear(id);
    return this.log.read(id);
  }

  dispatch(event: ServiceEvent) {
    const sessionId = event.session_id as string | undefined;
    for (const id of this.entries.keys()) {
      const state = sessionId && this.state(id, sessionId);
      // The state changes while the service closes too, and what the event did to it is not seen by the event.
      if (sessionId) this.move(id, sessionId, event.hook_event_name);
      if (this.closed || !this.enabled(id) || this.problem(id)) continue;
      const told = state ? { ...event, slots: { composer: state } } : event;
      try {
        for (const hook of this.hooksFor(id, event)) void this.run(id, hook, told);
      } catch (error) {
        this.failed(id, `${event.hook_event_name} 没有运行：${reason(error)}`);
      }
    }
  }
  private state(id: string, sessionId: string) {
    const { composerSlot: slot } = this.entry(id).declared;
    return slot && slotState(slot, this.composerSlots.of(sessionId, id), this.values(id));
  }
  // Moves the plugin's button in a session, as a gesture or an event does. A gesture made on another state than it is
  // in came late.
  move(id: string, sessionId: string, cause: string, from?: string) {
    const { composerSlot: slot } = this.entry(id).declared;
    const state = this.state(id, sessionId);
    if (!slot || !state || (from !== undefined && from !== state)) return;
    const to = slotMove(slot, cause, state);
    if (to) this.composerSlots.set(sessionId, id, to);
  }
  // What a run's end does to the buttons of a session, where the service stopped before it could be told.
  interrupted(sessionId: string) {
    for (const id of this.entries.keys()) this.move(id, sessionId, 'RunEnded');
  }
  private hooksFor(id: string, event: ServiceEvent) {
    const field = matcherFields[event.hook_event_name];
    return (this.hooks(id)[event.hook_event_name] ?? [])
      .filter((group) => matches(group.matcher, field && event[field]))
      .flatMap((group) => group.hooks);
  }
  private root(id: string) {
    return join(this.directory, 'plugins', id);
  }
  private run(id: string, hook: Hook, event: ServiceEvent, mark = '') {
    const root = this.root(id);
    const { before, data, env } = launch(this.where(id));
    const filled = (text: string) =>
      text
        .replaceAll('${CLAUDE_PLUGIN_ROOT}', () => root)
        .replaceAll('${CLAUDE_PLUGIN_DATA}', () => data);
    const words = [hook.command, ...(hook.args ?? [])].map(filled);
    const shell = !hook.args && !before.length;
    const command = hook.args || shell ? words : ['/bin/sh', '-c', ...words];
    const [file, ...args] = [...before, ...command];
    const config = this.values(id);
    const secrets = this.secrets(id, config);
    const started = Date.now();
    const child = spawn(file!, args, {
      cwd: root,
      env,
      shell,
      // A group of its own, so that what the command started ends with it.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    this.running.add(child);
    let printed = '';
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      stop(child);
    }, hook.timeout * 1000);
    for (const stream of [child.stdout, child.stderr])
      stream.setEncoding('utf8').on('data', (text: string) => {
        printed = (printed + text).slice(-OUTPUT_LIMIT);
      });
    const done = new Promise<{ ok: boolean; text: string }>((resolve) => {
      const ended = (result: string) => {
        if (!this.running.delete(child)) return;
        clearTimeout(timer);
        const of = event.session_id ? ` 会话=${event.session_id} 运行=${event.run_id}` : '';
        const ok = result === '成功';
        const output = masked(printed.trim(), secrets);
        const text = `${result} ${Date.now() - started}ms${output && `\n${output.replace(/^/gm, '    ')}`}`;
        if (!this.closed) {
          this.log.write(id, `${mark}${event.hook_event_name}${mark ? '' : of} → ${text}`);
          this.told(id, ok ? undefined : `${event.hook_event_name} ${result}`);
        }
        resolve({ ok, text });
      };
      child.on('error', (error) => ended(`没有启动（${error.message}）`));
      child.on('close', (code, signal) =>
        ended(
          late ? `超时 ${hook.timeout}s，已结束` : code === 0 ? '成功' : `退出 ${code ?? signal}`,
        ),
      );
    });
    // A command that does not read its input may be gone before it is written.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ ...event, config }));
    return done;
  }
  private failed(id: string, message: string) {
    this.log.write(id, message);
    this.told(id, message);
  }
  // Every window hears of a first failure and of the first time it went well after it.
  private told(id: string, failure: string | undefined) {
    const before = this.failures.get(id)?.message;
    if (failure) this.failures.set(id, { at: new Date().toISOString(), message: failure });
    else this.failures.delete(id);
    if (before !== failure) this.changed();
  }
  private printed(id: string, of: string, text: string, secrets: string[]) {
    if (text.trim())
      this.log.write(id, `[${of}]\n${masked(text.trim(), secrets).replace(/^/gm, '    ')}`);
  }
}
