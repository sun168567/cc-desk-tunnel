// POSIX paths are case-sensitive; Windows drive and UNC paths are not.
const windowsPath = (path: string) => /^[a-zA-Z]:[\\/]|^\\\\/.test(path);
export const pathKey = (path: string) =>
  windowsPath(path)
    ? path.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
    : path.replace(/\/+$/, '') || '/';
export const folderName = (path: string) =>
  (windowsPath(path)
    ? path
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .at(-1)
    : path.replace(/\/+$/, '').split('/').at(-1)) || path;
export const isInside = (path: string, root: string) =>
  !!root &&
  pathKey(path).startsWith(
    pathKey(root) + (pathKey(root) === '/' ? '' : windowsPath(root) ? '\\' : '/'),
  );
// Dotted numeric versions, e.g. 0.10.1 is newer than 0.9.0.
export function isNewer(candidate: string, current: string) {
  const [a, b] = [candidate, current].map((version) => version.split('.').map(Number));
  for (let index = 0; index < 3; index++)
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  return false;
}
export const withProject = (projects: string[], path: string) =>
  projects.some((item) => pathKey(item) === pathKey(path)) ? projects : [...projects, path];
