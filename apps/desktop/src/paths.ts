// Windows paths compare case-insensitively and may arrive with either separator.
export const pathKey = (path: string) =>
  path.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
export const folderName = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .at(-1) || path;
export const isInside = (path: string, root: string) =>
  !!root && pathKey(path).startsWith(`${root.toLowerCase()}\\`);
// Dotted numeric versions, e.g. 0.10.1 is newer than 0.9.0.
export function isNewer(candidate: string, current: string) {
  const [a, b] = [candidate, current].map((version) => version.split('.').map(Number));
  for (let index = 0; index < 3; index++)
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  return false;
}
export const withProject = (projects: string[], path: string) =>
  projects.some((item) => item.toLowerCase() === path.toLowerCase())
    ? projects
    : [...projects, path];
