import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { pluginManifestSchema, pluginIdSchema } from '@cc-desk-tunnel/protocol';
import type { Plugin, PluginManifest } from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';
import { readPluginConfig, writePluginConfig } from './plugin-config.ts';
import type { PluginConfig } from './plugin-config.ts';
import { hooksFileSchema, matches } from './plugin-hooks.ts';
import type { Hook } from './plugin-hooks.ts';
import { PluginLog } from './plugin-log.ts';
import { launch, stop } from './plugin-process.ts';
import { matcherFields } from './service-events.ts';
import type { ServiceEvent } from './service-events.ts';

// What is known of a plugin, read anew whenever its directory changes.
type Entry = {
  manifest: Partial<PluginManifest>;
  broken?: string;
};

// How much of what a command printed is kept, and how long changes in the directory are gathered.
const OUTPUT_LIMIT = 8192;
const SETTLE_MS = 300;

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The plugins in <data>/plugins, each a directory with a hooks/hooks.json (see docs/plugins.md): hands them the
// service's events. The directory is watched, so a change there holds a moment later. A plugin's code runs in processes
// of its own, and how they went goes to its log.
export class Plugins {
  private directory: string;
  private changed: () => void;
  private log: PluginLog;
  private entries = new Map<string, Entry>();
  // Apart from what is read anew, which may be while a plugin runs.
  private configs = new Map<string, PluginConfig>();
  private failures = new Map<string, { at: string; message: string }>();
  private running = new Set<ChildProcess>();
  private watcher?: FSWatcher;
  private settle?: NodeJS.Timeout;
  private stale = new Set<string>();
  private loading: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(directory: string, changed: () => void = () => {}) {
    this.directory = directory;
    this.changed = changed;
    this.log = new PluginLog(directory);
  }
  async start() {
    const plugins = join(this.directory, 'plugins');
    mkdirSync(plugins, { recursive: true, mode: 0o700 });
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
      const { enabled } = this.config(id);
      return {
        id,
        title: entry.manifest.displayName,
        description: entry.manifest.description,
        version: entry.manifest.version,
        author: entry.manifest.author,
        homepage: entry.manifest.homepage,
        repository: entry.manifest.repository,
        enabled,
        problem: enabled ? entry.broken : undefined,
        failure: this.failures.get(id),
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
        entries.set(id, known && !stale.has(id) ? known : this.load(id));
      }
      if (this.closed) return;
      this.entries = entries;
      this.changed();
    };
    this.loading = this.loading
      .then(read)
      .catch((error) => console.error(`Plugins were not read: ${reason(error)}`));
    return this.loading;
  }
  private load(id: string): Entry {
    const root = join(this.directory, 'plugins', id);
    const entry: Entry = { manifest: {} };
    try {
      const manifest = join(root, '.claude-plugin', 'plugin.json');
      if (existsSync(manifest))
        entry.manifest = pluginManifestSchema
          .partial()
          .parse(JSON.parse(readFileSync(manifest, 'utf8')));
      this.hooks(id);
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
  private entry(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new DomainError('not_found', '插件不存在。');
    return entry;
  }
  private write(id: string, config: PluginConfig) {
    writePluginConfig(this.directory, id, config);
    this.configs.set(id, config);
    this.changed();
  }

  async enable(id: string, enabled: boolean) {
    this.entry(id);
    this.write(id, { enabled });
    this.stale.add(id);
    await this.refresh();
    this.log.write(id, enabled ? '启用' : '停用');
  }
  dispatch(event: ServiceEvent) {
    for (const id of this.entries.keys()) {
      if (this.closed || !this.config(id).enabled || this.entry(id).broken) continue;
      try {
        for (const hook of this.hooksFor(id, event)) this.run(id, hook, event);
      } catch (error) {
        this.failed(id, `${event.hook_event_name} 没有运行：${reason(error)}`);
      }
    }
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
  private run(id: string, hook: Hook, event: ServiceEvent) {
    const root = this.root(id);
    const { data, env } = launch(root);
    const filled = (text: string) =>
      text
        .replaceAll('${CLAUDE_PLUGIN_ROOT}', () => root)
        .replaceAll('${CLAUDE_PLUGIN_DATA}', () => data);
    const started = Date.now();
    const child = spawn(filled(hook.command), hook.args?.map(filled) ?? [], {
      cwd: root,
      env,
      shell: !hook.args,
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
    const ended = (result: string) => {
      if (!this.running.delete(child)) return;
      clearTimeout(timer);
      if (this.closed) return;
      const of = event.session_id ? ` 会话=${event.session_id} 运行=${event.run_id}` : '';
      const output = printed.trim();
      const text = `${result} ${Date.now() - started}ms${output && `\n${output.replace(/^/gm, '    ')}`}`;
      this.log.write(id, `${event.hook_event_name}${of} → ${text}`);
      this.told(id, result === '成功' ? undefined : `${event.hook_event_name} ${result}`);
    };
    child.on('error', (error) => ended(`没有启动（${error.message}）`));
    child.on('close', (code, signal) =>
      ended(
        late ? `超时 ${hook.timeout}s，已结束` : code === 0 ? '成功' : `退出 ${code ?? signal}`,
      ),
    );
    // A command that does not read its input may be gone before it is written.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(event));
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
}
