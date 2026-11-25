import { basename, dirname } from 'node:path';

// electron-builder skips a source root's node_modules. Copy ccdt from its parent so its SSH dependencies stay in.
export function ccdtResource(directory) {
  return { from: dirname(directory), to: '.', filter: [`${basename(directory)}/**/*`] };
}
