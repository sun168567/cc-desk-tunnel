import { platformOf } from '@cc-desk-tunnel/protocol';
import type { Device, Session } from '@cc-desk-tunnel/protocol';
import type { ConnectedDevice } from './client.ts';

// What the file panel shows and where (see FilePanel.tsx): an entry of a directory as the desktop's main process
// lists it (electron/files.mjs), and the places it can look, each with the path style its paths are written in.
export type FileEntry = {
  name: string;
  kind: 'file' | 'directory' | 'link' | 'other';
  size: number;
  mtime: number;
  // What a link points to, when that could be told.
  target?: 'file' | 'directory' | null;
};
export type FilePlace = {
  // `local`, `server`, or a computer's ID: what the main process takes as the target.
  id: string;
  label: string;
  kind: 'local' | 'server' | 'device';
  // Windows paths here are written as Windows writes them; over SFTP a Windows computer's are `/C:/...`.
  style: 'windows' | 'posix';
};
// What the service offers the file panel; `server` is false where its image has no SFTP server.
export type FilesInfo = { server: boolean; dataDir: string; home: string; protected: boolean };

export const isDirectory = (entry: FileEntry) =>
  entry.kind === 'directory' || (entry.kind === 'link' && entry.target === 'directory');

const separator = (style: FilePlace['style']) => (style === 'windows' ? '\\' : '/');
export function joinPath(style: FilePlace['style'], directory: string, name: string) {
  const mark = separator(style);
  return directory.endsWith(mark) || (style === 'posix' && directory.endsWith('/'))
    ? directory + name
    : directory + mark + name;
}
// The directory a path is in; a root is its own.
export function parentOf(style: FilePlace['style'], path: string) {
  if (style === 'windows') {
    const trimmed = path.replace(/\\+$/, '');
    if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + '\\';
    const at = trimmed.lastIndexOf('\\');
    return at < 0
      ? path
      : at === 2 && trimmed[1] === ':'
        ? trimmed.slice(0, 3)
        : trimmed.slice(0, at);
  }
  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed) return '/';
  const at = trimmed.lastIndexOf('/');
  const up = at <= 0 ? '/' : trimmed.slice(0, at);
  // A Windows computer's drive over SFTP, `/C:`, is a root too.
  return /^\/[A-Za-z]:$/.test(trimmed) ? trimmed + '/' : /^\/[A-Za-z]:$/.test(up) ? up + '/' : up;
}
export const baseName = (style: FilePlace['style'], path: string) =>
  path
    .replace(style === 'windows' ? /\\+$/ : /\/+$/, '')
    .split(separator(style))
    .pop() || path;
// The steps of a path, each with the path up to it, for the bar above the tree.
export function crumbs(style: FilePlace['style'], path: string) {
  const steps: { label: string; path: string }[] = [];
  for (let current = path; ;) {
    const up = parentOf(style, current);
    steps.unshift({
      label: up === current ? current.replace(/[\\/]+$/, '') || '/' : baseName(style, current),
      path: current,
    });
    if (up === current) break;
    current = up;
  }
  return steps;
}
export const within = (style: FilePlace['style'], path: string, directory: string) => {
  const fold = (value: string) => (style === 'windows' ? value.toLowerCase() : value);
  const base = fold(directory).replace(/[\\/]+$/, '');
  const inner = fold(path);
  return inner === base || inner.startsWith(base + separator(style));
};

// A Windows path as a Windows computer's OpenSSH names it over SFTP.
export const sftpPath = (path: string, platform: string) =>
  platform === 'win32' ? '/' + path.replaceAll('\\', '/') : path;

// The places the panel can look from this window: this computer, the service where it offers its files, and the
// user's other computers that are connected and reachable.
export function filePlaces(
  here: Device | null,
  devices: ConnectedDevice[],
  files: FilesInfo | null,
): FilePlace[] {
  const local = platformOf(here) === 'win32' ? 'windows' : 'posix';
  return [
    { id: 'local', label: '本机', kind: 'local', style: local },
    // Shown without an SFTP server too, where the panel says what the service lacks.
    ...(files
      ? [{ id: 'server', label: '服务端', kind: 'server' as const, style: 'posix' as const }]
      : []),
    // Other computers are reached through the service, which offers files at all only with `files`.
    ...devices
      .filter((device) => files && device.ready && !device.server && device.id !== here?.id)
      .map((device) => ({
        id: device.id,
        label: device.name,
        kind: 'device' as const,
        style: 'posix' as const,
      })),
  ];
}
// Where the panel opens for a session in a place: its project folder on the computer it is on, and on the service
// the directory Claude works in for it. Elsewhere, wherever the place starts (null).
export function sessionFolder(
  session: Session | undefined,
  place: FilePlace,
  here: Device | null,
  onThis: boolean,
  files: FilesInfo | null,
  serverDevice: string | undefined,
): string | null {
  if (!session) return null;
  if (place.kind === 'server') {
    if (session.device?.id === serverDevice) return session.projectPath;
    return files ? `${files.dataDir}/native/${session.nativeRoot ?? session.id}` : null;
  }
  if (place.kind === 'local') return onThis ? session.projectPath : null;
  if (session.device?.id !== place.id) return null;
  return sftpPath(session.projectPath, platformOf(session.device));
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
export function formatTime(ms: number) {
  const date = new Date(ms);
  const now = new Date();
  const two = (value: number) => String(value).padStart(2, '0');
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return time;
  const day = `${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${time}`
    : `${date.getFullYear()}-${day}`;
}

const images = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i;
const markdown = /\.(md|markdown|mdx)$/i;
const mime: Record<string, string> = {
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  ico: 'image/x-icon',
};
export const imageType = (name: string) => {
  const ext = name.split('.').pop()!.toLowerCase();
  return images.test(name) ? (mime[ext] ?? `image/${ext}`) : null;
};
export type Preview =
  { kind: 'image'; url: string } | { kind: 'markdown' | 'text'; text: string } | { kind: 'binary' };
// How a file is shown: a picture by its name; text when its bytes are UTF-8 without NULs; anything else not.
export function previewOf(name: string, bytes: Uint8Array): Preview {
  const type = imageType(name);
  if (type)
    return { kind: 'image', url: URL.createObjectURL(new Blob([bytes as BlobPart], { type })) };
  if (bytes.subarray(0, 8000).includes(0)) return { kind: 'binary' };
  const decode = (part: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(part);
  let text: string;
  try {
    text = decode(bytes);
  } catch {
    // A file read part way may end in the middle of a character.
    try {
      text = decode(bytes.subarray(0, Math.max(0, bytes.length - 3)));
    } catch {
      return { kind: 'binary' };
    }
  }
  return { kind: markdown.test(name) ? 'markdown' : 'text', text };
}
