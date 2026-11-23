import { isWindowsPath, pathKey } from '@cc-desk-tunnel/protocol';

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
export function ago(time: number) {
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 小时`;
  if (minutes < 60 * 24 * 30) return `${Math.floor(minutes / 60 / 24)} 天`;
  return new Date(time).toLocaleDateString('zh-CN');
}
