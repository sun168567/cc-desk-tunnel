import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { phrase } from '@cc-desk-tunnel/i18n';
import type { Phrase, Words } from '@cc-desk-tunnel/i18n';
import { pluginIdSchema, pluginOptionSchema } from '@cc-desk-tunnel/protocol';
import type { Plugin, PluginOption, PluginRun, PluginValue } from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';
import { eventExample } from './event-examples.ts';
import { readPluginConfig, writePluginConfig } from './plugin-config.ts';
import type { PluginConfig } from './plugin-config.ts';
import { hooksFileSchema, matches } from './plugin-hooks.ts';
import type { Hook } from './plugin-hooks.ts';
import { masked, PluginLog } from './plugin-log.ts';
import { launch, stop } from './plugin-process.ts';
import { matcherFields } from './service-events.ts';
import type { ServiceEvent } from './service-events.ts';

// The part of a Claude Code plugin's .claude-plugin/plugin.json that a plugin of the service uses. The rest is ignored,
// as Claude Code ignores what it does not know; the file itself may be left out.
const manifestSchema = z.object({
  name: z.string().max(64).optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
  version: z.string().max(60).optional(),
  description: z.string().max(1000).optional(),
  author: z
    .object({ name: z.string().min(1).max(120), url: z.string().max(500).optional() })
    .optional(),
  homepage: z.string().max(500).optional(),
  repository: z.string().max(500).optional(),
  userConfig: z
    .record(
      z
        .string()
        .regex(/^[A-Za-z_]\w*$/)
        .max(64),
      pluginOptionSchema,
    )
    .optional(),
});
type Manifest = z.infer<typeof manifestSchema>;
type Hooks = z.infer<typeof hooksFileSchema>['hooks'];
type Options = Record<string, PluginOption>;
// A plugin as its files were last read: what it declares, or which file could not be read and why.
type Entry = { manifest: Manifest; hooks: Hooks } | { broken: { file: string; reason: Words } };

// How much of what a command printed is kept, how long changes in the directory are gathered, how many commands run at
// once and how many more may wait, and how long a trial lets one run.
const OUTPUT_LIMIT = 8192;
const SETTLE_MS = 300;
const RUNNING = 8;
const WAITING = 64;
const TRIAL_SECONDS = 60;

const reason = (error: unknown) =>
  error instanceof z.ZodError
    ? z.prettifyError(error)
    : error instanceof Error
      ? error.message
      : String(error);

// Why a value does not do for its option, if it does not. An empty string is no value, which any string may be.
export function invalid(option: PluginOption, value: PluginValue): Phrase | undefined {
  const { title } = option;
  if (typeof value !== option.type || (typeof value === 'number' && !Number.isFinite(value)))
    return {
      string: phrase('service:plugins.option.string', { title }),
      number: phrase('service:plugins.option.number', { title }),
      boolean: phrase('service:plugins.option.boolean', { title }),
    }[option.type];
  if (typeof value === 'string' && value && option.options && !option.options.includes(value))
    return phrase('service:plugins.option.choice', { title });
  if (typeof value === 'number' && option.min !== undefined && value < option.min)
    return phrase('service:plugins.option.min', { title, min: option.min });
  if (typeof value === 'number' && option.max !== undefined && value > option.max)
    return phrase('service:plugins.option.max', { title, max: option.max });
  return undefined;
}
// What is wrong with how an option is declared, beyond its form.
function misdeclared(option: PluginOption): Phrase | undefined {
  if (option.options && option.type !== 'string')
    return phrase('service:plugins.option.choiceOfString', { title: option.title });
  return option.default === undefined ? undefined : invalid(option, option.default);
}

// The plugins in <data>/plugins (see docs/plugins.md): each a directory laid out as a Claude Code plugin, whose
// hooks/hooks.json names the commands the service's events start. The directory is watched, so that a change there
// holds a moment later. A plugin's code runs only in the processes its commands start, never in the service.
export class Plugins {
  private directory: string;
  private changed: () => void;
  private log: PluginLog;
  private entries = new Map<string, Entry>();
  private configs = new Map<string, PluginConfig>();
  // How each plugin last failed, until a run of it goes well.
  private failures = new Map<string, Pick<PluginRun, 'at' | 'result'>>();
  private running = new Set<ChildProcess>();
  private busy = 0;
  private waiting: (() => void)[] = [];
  private watcher?: FSWatcher;
  private settle?: NodeJS.Timeout;
  private closed = false;
  constructor(directory: string, changed: () => void = () => {}) {
    this.directory = directory;
    this.changed = changed;
    this.log = new PluginLog(directory);
  }
  private get root() {
    return join(this.directory, 'plugins');
  }
  start() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try {
      this.watcher = watch(this.root, { recursive: true }, () => {
        clearTimeout(this.settle);
        this.settle = setTimeout(() => this.read(), SETTLE_MS);
      });
      this.watcher.on('error', (error) =>
        console.error(`Plugins are not watched: ${error.message}`),
      );
    } catch (error) {
      // Where the system has no watch to spare, the plugins are read when the service starts.
      console.error(`Plugins are not watched: ${reason(error)}`);
    }
    this.read();
  }
  close() {
    this.closed = true;
    this.watcher?.close();
    clearTimeout(this.settle);
    this.waiting = [];
    for (const child of this.running) stop(child);
  }
  // Whether an event reaches anyone: while none does, none is made.
  any() {
    return [...this.entries].some(
      ([id, entry]) => !('broken' in entry) && this.configOf(id).enabled,
    );
  }
  // Reads every plugin anew: there are few, and what changed may be any of their files.
  private read() {
    if (this.closed) return;
    let ids: string[] = [];
    try {
      ids = readdirSync(this.root, { withFileTypes: true })
        .filter((item) => item.isDirectory() && pluginIdSchema.safeParse(item.name).success)
        .map((item) => item.name)
        .sort();
    } catch (error) {
      console.error(`Plugins were not read: ${reason(error)}`);
    }
    this.entries = new Map(ids.map((id) => [id, this.load(id)]));
    this.configs = new Map(ids.map((id) => [id, readPluginConfig(this.directory, id)]));
    this.changed();
  }
  private load(id: string): Entry {
    const root = join(this.root, id);
    let file = '.claude-plugin/plugin.json';
    try {
      const path = join(root, file);
      const manifest = existsSync(path)
        ? manifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
        : {};
      for (const option of Object.values(manifest.userConfig ?? {})) {
        const wrong = misdeclared(option);
        if (wrong) return { broken: { file, reason: wrong } };
      }
      file = 'hooks/hooks.json';
      const hooks = hooksFileSchema.parse(JSON.parse(readFileSync(join(root, file), 'utf8'))).hooks;
      return { manifest, hooks };
    } catch (error) {
      console.error(`Plugin ${id}: ${file}: ${reason(error)}`);
      return { broken: { file, reason: reason(error) } };
    }
  }
  private entry(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new DomainError('plugin_unknown', phrase('service:plugins.unknown'));
    return entry;
  }
  private configOf(id: string) {
    return this.configs.get(id) ?? readPluginConfig(this.directory, id);
  }
  private save(id: string, config: PluginConfig) {
    writePluginConfig(this.directory, id, config);
    this.configs.set(id, config);
    this.changed();
  }
  // What the plugin's commands are given: each option's value, or its default.
  private valuesOf(options: Options, config: PluginConfig) {
    const values: Record<string, PluginValue> = {};
    for (const [key, option] of Object.entries(options)) {
      const value = config.values[key] ?? option.default;
      if (value !== undefined) values[key] = value;
    }
    return values;
  }
  // The titles of the required options that have no value, while which the plugin does not run.
  private unset(options: Options, config: PluginConfig) {
    const values = this.valuesOf(options, config);
    return Object.entries(options)
      .filter(([key, { required }]) => required && (values[key] ?? '') === '')
      .map(([, { title }]) => title);
  }
  list(): Plugin[] {
    return [...this.entries].map(([id, entry]): Plugin => {
      const config = this.configOf(id);
      const failure = this.failures.get(id);
      const known = { id, enabled: config.enabled, ...(failure && { failure }) };
      if ('broken' in entry)
        return {
          ...known,
          title: id,
          problem: phrase('service:plugins.broken', entry.broken),
          events: [],
          options: {},
          values: {},
          secrets: [],
        };
      const { manifest, hooks } = entry;
      const options = manifest.userConfig ?? {};
      const values: Record<string, PluginValue> = {};
      const secrets: string[] = [];
      for (const [key, option] of Object.entries(options)) {
        const value = config.values[key];
        if (value === undefined) continue;
        if (option.sensitive) secrets.push(key);
        else values[key] = value;
      }
      const unset = this.unset(options, config);
      return {
        ...known,
        title: manifest.displayName ?? manifest.name ?? id,
        description: manifest.description,
        version: manifest.version,
        author: manifest.author,
        homepage: manifest.homepage,
        repository: manifest.repository,
        ...(unset.length && { problem: phrase('service:plugins.unset', { titles: unset }) }),
        events: Object.keys(hooks),
        options,
        values,
        secrets,
      };
    });
  }
  enable(id: string, enabled: boolean) {
    this.entry(id);
    this.save(id, { ...this.configOf(id), enabled });
  }
  // Keeps each value that does for its option: null clears it, and an empty one of a sensitive option keeps it.
  configure(id: string, changes: Record<string, PluginValue | null>) {
    const entry = this.entry(id);
    const options: Options = 'broken' in entry ? {} : (entry.manifest.userConfig ?? {});
    const config = this.configOf(id);
    const values = { ...config.values };
    for (const [key, value] of Object.entries(changes)) {
      const option = options[key];
      if (!option)
        throw new DomainError(
          'plugin_option_unknown',
          phrase('service:plugins.option.unknown', { key }),
        );
      if (value === null) delete values[key];
      else if (!(option.sensitive && value === '')) {
        const wrong = invalid(option, value);
        if (wrong) throw new DomainError('plugin_value_invalid', wrong);
        values[key] = value;
      }
    }
    this.save(id, { ...config, values });
  }
  logOf(id: string, clear = false) {
    this.entry(id);
    if (clear) {
      this.log.clear(id);
      if (this.failures.delete(id)) this.changed();
    }
    return this.log.read(id);
  }
  dispatch(event: ServiceEvent) {
    if (this.closed) return;
    const field = matcherFields[event.hook_event_name];
    for (const [id, entry] of this.entries) {
      if ('broken' in entry) continue;
      const config = this.configOf(id);
      if (!config.enabled || this.unset(entry.manifest.userConfig ?? {}, config).length) continue;
      for (const group of entry.hooks[event.hook_event_name] ?? []) {
        let matched = false;
        try {
          matched = matches(group.matcher, field && event[field]);
        } catch (error) {
          console.error(`Plugin ${id}: matcher ${group.matcher}: ${reason(error)}`);
        }
        if (matched)
          for (const hook of group.hooks) void this.queue(() => this.run(id, hook, event));
      }
    }
  }
  // Runs the plugin's commands for an event on an example of it, whatever their matchers, and whether or not the
  // plugin is enabled: the user asked for it.
  async attempt(id: string, name: string) {
    const entry = this.entry(id);
    if ('broken' in entry)
      throw new DomainError('plugin_broken', phrase('service:plugins.broken', entry.broken));
    const example = eventExample(name);
    if (!example) throw new DomainError('plugin_event_unknown', phrase('service:plugins.noEvent'));
    const hooks = (entry.hooks[name] ?? []).flatMap((group) => group.hooks);
    if (!hooks.length)
      throw new DomainError('plugin_event_unhandled', phrase('service:plugins.noCommands'));
    const unset = this.unset(entry.manifest.userConfig ?? {}, this.configOf(id));
    if (unset.length)
      throw new DomainError('plugin_unset', phrase('service:plugins.unset', { titles: unset }));
    const runs = await Promise.all(
      hooks.map((hook) => this.queue(() => this.run(id, hook, example, true))),
    );
    return runs.filter((run) => run !== undefined);
  }
  // A command runs when fewer than RUNNING do; until then it waits, and when too many wait it is dropped.
  private queue(task: () => Promise<PluginRun>): Promise<PluginRun | undefined> {
    if (this.busy < RUNNING) return this.go(task);
    if (this.waiting.length >= WAITING) {
      console.error('Plugins: too many commands waiting, one is dropped');
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => this.waiting.push(() => resolve(this.go(task))));
  }
  private async go(task: () => Promise<PluginRun>) {
    this.busy++;
    try {
      return await task();
    } finally {
      this.busy--;
      if (!this.closed) this.waiting.shift()?.();
    }
  }
  private run(id: string, hook: Hook, event: ServiceEvent, trial = false) {
    const root = join(this.root, id);
    const entry = this.entries.get(id);
    const options = entry && !('broken' in entry) ? (entry.manifest.userConfig ?? {}) : {};
    const values = this.valuesOf(options, this.configOf(id));
    const secrets = Object.entries(options)
      .filter(([key, { sensitive }]) => sensitive && typeof values[key] === 'string')
      .map(([key]) => values[key] as string);
    const { data, env: base } = launch(root);
    const env: NodeJS.ProcessEnv = { ...base };
    // Each option's value goes in the environment, as Claude Code gives a plugin's hooks theirs, and may be written in
    // the arguments as ${user_config.KEY}: an argument is not read again by a shell.
    for (const [key, value] of Object.entries(values))
      env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`] = String(value);
    const filled = (text: string) =>
      text
        .replaceAll('${CLAUDE_PLUGIN_ROOT}', () => root)
        .replaceAll('${CLAUDE_PLUGIN_DATA}', () => data);
    const argument = (text: string) =>
      filled(text).replace(/\$\{user_config\.(\w+)\}/g, (_, key: string) =>
        values[key] === undefined ? '' : String(values[key]),
      );
    const seconds = trial ? Math.min(hook.timeout, TRIAL_SECONDS) : hook.timeout;
    const started = Date.now();
    return new Promise<PluginRun>((resolve) => {
      let printed = '';
      let late = false;
      let done = false;
      let child: ChildProcess | undefined;
      let timer: NodeJS.Timeout | undefined;
      const finish = (result: PluginRun['result'], exitCode?: number | null, note?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (child) this.running.delete(child);
        const output = masked([printed.trim(), note].filter(Boolean).join('\n'), secrets);
        const run: PluginRun = {
          at: new Date(started).toISOString(),
          event: event.hook_event_name,
          ...(typeof event.session_id === 'string' && { sessionId: event.session_id }),
          ...(trial && { trial: true as const }),
          result,
          ...(typeof exitCode === 'number' && { exitCode }),
          ms: Date.now() - started,
          output: output.slice(-OUTPUT_LIMIT),
        };
        if (!this.closed) this.ran(id, run);
        resolve(run);
      };
      try {
        child = spawn(filled(hook.command), hook.args?.map(argument) ?? [], {
          cwd: root,
          env,
          shell: !hook.args,
          // A group of its own, so that what the command started ends with it.
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
      } catch (error) {
        return finish('unstarted', undefined, reason(error));
      }
      this.running.add(child);
      timer = setTimeout(() => {
        late = true;
        stop(child!);
      }, seconds * 1000);
      for (const stream of [child.stdout, child.stderr])
        stream?.setEncoding('utf8').on('data', (text: string) => {
          printed = (printed + text).slice(-OUTPUT_LIMIT);
        });
      child.on('error', (error) => finish('unstarted', undefined, error.message));
      child.on('close', (code) => finish(late ? 'timeout' : code === 0 ? 'ok' : 'failed', code));
      // A command that does not read its input may be gone before it is written.
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify(event));
    });
  }
  // A run is logged, and the windows told when the plugin begins or stops failing.
  private ran(id: string, run: PluginRun) {
    this.log.write(id, run);
    const failed = this.failures.has(id);
    if (run.result === 'ok') this.failures.delete(id);
    else this.failures.set(id, { at: run.at, result: run.result });
    if (failed || run.result !== 'ok') this.changed();
  }
}
