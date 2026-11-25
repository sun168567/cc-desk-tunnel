import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { pluginManifestSchema } from '@cc-desk-tunnel/protocol';
import type { PluginManifest } from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';
import { hooksFileSchema } from './plugin-hooks.ts';
import { isNewer, serviceVersion } from './updates.ts';

const UNPACKED_LIMIT = 20 * 1024 * 1024;
const FILES_LIMIT = 500;
const refuse = (message: string) => new DomainError('plugin_archive', message);

// A plugin made for a later service is told so, rather than run without what it needs.
export function checkVersion({ minVersion }: Partial<PluginManifest>) {
  if (minVersion && isNewer(minVersion, serviceVersion()))
    throw refuse(`需要 ${minVersion} 或更新的服务端，现在是 ${serviceVersion()}。`);
}

// A plugin's archive, read without running any of it: what it says it is, what it would run, and its files.
export type PluginArchive = {
  manifest: PluginManifest;
  events: string[];
  commands: string[];
  files: Map<string, Uint8Array>;
};

function unpack(data: Uint8Array) {
  let size = 0;
  let count = 0;
  try {
    const files = unzipSync(data, {
      filter: ({ name, originalSize }) => {
        // What systems leave in an archive of their own.
        if (/(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/.test(name) || /[\\/]$/.test(name))
          return false;
        size += originalSize;
        if (++count > FILES_LIMIT) throw refuse(`文件超过 ${FILES_LIMIT} 个。`);
        if (size > UNPACKED_LIMIT) throw refuse('解开后超过 20 MB。');
        return true;
      },
    });
    // Windows PowerShell 5.1 packs paths with backslashes.
    return Object.fromEntries(
      Object.entries(files).map(([name, file]) => [name.replaceAll('\\', '/'), file]),
    );
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw refuse('不是有效的 zip 压缩包。');
  }
}
function parsed<T>(file: Uint8Array | undefined, path: string, parse: (value: unknown) => T): T {
  if (!file) throw refuse(`压缩包里没有 ${path}。`);
  try {
    return parse(JSON.parse(strFromU8(file)));
  } catch (error) {
    const issue = (error as { issues?: { path: PropertyKey[]; message: string }[] }).issues?.[0];
    throw refuse(
      `${path} 有误：${issue ? `${issue.path.join('.')} ${issue.message}` : '不是 JSON'}`,
    );
  }
}

export function readArchive(data: Uint8Array): PluginArchive {
  const unpacked = unpack(data);
  const names = Object.keys(unpacked);
  // Packed as its files or as the folder that holds them.
  const top = names[0]?.split('/')[0];
  const folder =
    top && !unpacked['hooks/hooks.json'] && names.every((name) => name.startsWith(`${top}/`))
      ? `${top}/`
      : '';
  const files = new Map<string, Uint8Array>();
  for (const name of names) {
    const path = name.slice(folder.length);
    if (
      !path ||
      /[:\0]/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw refuse(`文件路径不合规：${name}`);
    files.set(path, unpacked[name]!);
  }
  const manifest = parsed(
    files.get('.claude-plugin/plugin.json'),
    '.claude-plugin/plugin.json',
    (value) => pluginManifestSchema.parse(value),
  );
  checkVersion(manifest);
  const { hooks } = parsed(files.get('hooks/hooks.json'), 'hooks/hooks.json', (value) =>
    hooksFileSchema.parse(value),
  );
  const commands = Object.values(hooks)
    .flat()
    .flatMap((group) => group.hooks)
    .map((hook) => [hook.command, ...(hook.args ?? [])].join(' '));
  return { manifest, events: Object.keys(hooks), commands: [...new Set(commands)], files };
}

// Puts the archive in place of the plugin of its id, whose settings, data and log are kept elsewhere and stay.
export function installArchive(directory: string, { manifest, files }: PluginArchive) {
  const aside = join(directory, 'plugins-new');
  const fresh = join(aside, randomUUID());
  const old = join(aside, randomUUID());
  const place = join(directory, 'plugins', manifest.id);
  try {
    for (const [path, data] of files) {
      const file = join(fresh, path);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const script = data[0] === 0x23 && data[1] === 0x21;
      writeFileSync(file, data, { mode: script ? 0o700 : 0o600 });
    }
    if (existsSync(place)) renameSync(place, old);
    try {
      renameSync(fresh, place);
    } catch (error) {
      if (existsSync(old)) renameSync(old, place);
      throw error;
    }
  } finally {
    rmSync(aside, { recursive: true, force: true });
  }
}
