import { isWindowsPath, pathKey } from '@cc-desk-tunnel/protocol';
import { localeOf } from './i18n.ts';
import type { T } from './i18n.ts';

export { pathKey };
export const folderName = (path: string) =>
  path
    .split(isWindowsPath(path) ? /[\\/]/ : '/')
    .filter(Boolean)
    .at(-1) || path;
// What a project is called: the name the user gave it, or its folder's.
export const projectName = (project: { name?: string; path: string }) =>
  project.name || folderName(project.path);
// Whether a path lies under one of the folders.
export const isInside = (path: string, roots: string[]) =>
  roots.some((root) =>
    pathKey(path).startsWith(`${pathKey(root)}${isWindowsPath(root) ? '\\' : '/'}`),
  );
// Dotted numeric versions, e.g. 0.10.1 is newer than 0.9.0.
export function isNewer(candidate: string, current: string) {
  const [a, b] = [candidate, current].map((version) => version.split('.').map(Number));
  for (let index = 0; index < 3; index++)
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  return false;
}
// How long ago, in the fewest words that still tell recent from old.
export function ago(t: T, time: number) {
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return t('common:ago.now');
  if (minutes < 60) return t('common:ago.minutes', { n: minutes });
  if (minutes < 60 * 24) return t('common:ago.hours', { n: Math.floor(minutes / 60) });
  if (minutes < 60 * 24 * 30) return t('common:ago.days', { n: Math.floor(minutes / 60 / 24) });
  return new Date(time).toLocaleDateString(localeOf(t));
}
