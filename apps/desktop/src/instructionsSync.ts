import { platformOf } from '@cc-desk-tunnel/protocol';
import type { Device } from '@cc-desk-tunnel/protocol';
import type { ConnectedDevice } from './client.ts';
import { joinPath, sftpPath } from './files.ts';
import type { FileEntry, FilePlace, FilesInfo } from './files.ts';

// What Claude Code reads of a project on its own: its instructions (CLAUDE.md and its rules) and what it can be asked
// to use (skills, commands, subagents). On the service it reads them from the session's working directory, not from
// the project's folder on the user's computer; copied there, they take effect with the next message, the CLI starting
// anew for each. The project's settings and MCP servers stay where they are: their hooks and servers would run on the
// service, written for the computer. A CLAUDE.md of a subfolder is left too, as Claude never enters those here.
export const SYNCED_FILES = ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'];
export const SYNCED_FOLDERS = [
  '.claude/rules',
  '.claude/skills',
  '.claude/commands',
  '.claude/agents',
];
// How far and how much is looked at, so that a folder of something else cannot hold the copy up.
const DEPTH = 6;
const MOST = 500;
// Files up to this size are compared by what they hold; larger ones of the same size count as different.
const COMPARED = 2 * 1024 * 1024;

// One side of a copy: where the file panel reaches it, and the folder of the project there.
export type Side = { target: string; root: string; style: FilePlace['style'] };
// What of the desktop's file access a copy uses (see desktop.d.ts).
export type Files = {
  list: (target: string, directory: string) => Promise<FileEntry[]>;
  read: (
    target: string,
    file: string,
    limit?: number,
  ) => Promise<{ bytes: Uint8Array; size: number; truncated: boolean }>;
  mkdir: (target: string, directory: string) => Promise<void>;
  transfer: (
    id: string,
    request: {
      from: { target: string; paths: string[] };
      to: { target: string; dir: string };
      conflict?: 'replace' | 'skip' | 'resume';
    },
  ) => Promise<{ files: number; bytes: number; cancelled?: true }>;
};
// The files to copy, by their path in the project with `/`: not there yet, the same, or there and different.
export type Comparison = { added: string[]; same: string[]; differ: string[] };

const at = (side: Side, relative: string) =>
  relative
    ? relative.split('/').reduce((path, name) => joinPath(side.style, path, name), side.root)
    : side.root;
const folderOf = (relative: string) => relative.split('/').slice(0, -1).join('/');

// A side's folders as they are listed, each once; one that is not there lists as nothing.
function lister(files: Files, side: Side) {
  const read = new Map<string, Promise<FileEntry[] | null>>();
  return (relative: string) => {
    if (!read.has(relative))
      read.set(
        relative,
        files.list(side.target, at(side, relative)).catch(() => null),
      );
    return read.get(relative)!;
  };
}

// What there is to copy from one side, and how each file stands on the other.
export async function compare(files: Files, from: Side, to: Side): Promise<Comparison> {
  const source = lister(files, from);
  const target = lister(files, to);
  const found: { path: string; size: number }[] = [];
  const entry = async (relative: string) =>
    (await source(folderOf(relative)))?.find((item) => item.name === relative.split('/').at(-1));
  for (const path of SYNCED_FILES) {
    const item = await entry(path);
    if (item?.kind === 'file') found.push({ path, size: item.size });
  }
  async function walk(relative: string, depth: number) {
    if (depth > DEPTH || found.length >= MOST) return;
    for (const item of (await source(relative)) ?? []) {
      const path = `${relative}/${item.name}`;
      if (item.kind === 'file') found.push({ path, size: item.size });
      else if (item.kind === 'directory') await walk(path, depth + 1);
      if (found.length >= MOST) return;
    }
  }
  for (const folder of SYNCED_FOLDERS) if (await entry(folder)) await walk(folder, 1);
  const result: Comparison = { added: [], same: [], differ: [] };
  for (const { path, size } of found) {
    const there = (await target(folderOf(path)))?.find(
      (item) => item.name === path.split('/').at(-1),
    );
    if (!there) result.added.push(path);
    else if (there.kind !== 'file' || there.size !== size || size > COMPARED)
      result.differ.push(path);
    else {
      const [mine, theirs] = await Promise.all([
        files.read(from.target, at(from, path), COMPARED),
        files.read(to.target, at(to, path), COMPARED),
      ]);
      const equal =
        mine.bytes.length === theirs.bytes.length &&
        mine.bytes.every((byte, index) => byte === theirs.bytes[index]);
      result[equal ? 'same' : 'differ'].push(path);
    }
  }
  return result;
}

// Copies the files given, folder by folder, making the folders that are missing; `replace` for files already there.
export async function copy(files: Files, from: Side, to: Side, paths: string[], replace: boolean) {
  const groups = new Map<string, string[]>();
  for (const path of paths)
    groups.set(folderOf(path), [...(groups.get(folderOf(path)) ?? []), path]);
  let copied = 0;
  for (const [folder, members] of groups) {
    let made = '';
    for (const name of folder ? folder.split('/') : []) {
      made = made ? `${made}/${name}` : name;
      await files.mkdir(to.target, at(to, made)).catch(() => {});
    }
    const done = await files.transfer(`sync-${crypto.randomUUID()}`, {
      from: { target: from.target, paths: members.map((path) => at(from, path)) },
      to: { target: to.target, dir: at(to, folder) },
      conflict: replace ? 'replace' : 'skip',
    });
    copied += done.files;
  }
  return copied;
}

// The two sides for a folder of a computer and the directory the service works in for it: the computer's through this
// window's own files where it is this computer, over its SFTP otherwise, while it is connected. None where the service
// offers no files, or the computer is away.
export function sidesOf(
  place: { device: Device; path: string; root: string },
  here: Device | null,
  devices: ConnectedDevice[],
  files: FilesInfo | null,
): { computer: Side; server: Side } | null {
  if (!files?.server) return null;
  const server: Side = {
    target: 'server',
    root: `${files.dataDir}/native/${place.root}`,
    style: 'posix',
  };
  if (place.device.id === here?.id)
    return {
      computer: {
        target: 'local',
        root: place.path,
        style: platformOf(here) === 'win32' ? 'windows' : 'posix',
      },
      server,
    };
  if (!devices.some((device) => device.id === place.device.id && device.ready && !device.server))
    return null;
  return {
    computer: {
      target: place.device.id,
      root: sftpPath(place.path, platformOf(place.device)),
      style: 'posix',
    },
    server,
  };
}
