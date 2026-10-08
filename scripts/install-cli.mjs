import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Puts `ccdt` on the user's PATH as a small launcher bound to this checkout and to the Node that ran this script,
// so it works from shells that do not load a Node version manager. Nothing outside ~/.local/bin is changed.
if (process.platform !== 'linux') throw new Error('The terminal client is for Linux.');
const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
const entry = fileURLToPath(new URL('../apps/cli/bin/ccdt.mjs', import.meta.url));
const directory = process.env.CCDT_BIN_DIR ?? join(homedir(), '.local/bin');
const target = join(directory, 'ccdt');
await mkdir(directory, { recursive: true });
await writeFile(target, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`);
await chmod(target, 0o755);
console.log(`Installed ${target}`);
if (!(process.env.PATH ?? '').split(':').includes(directory))
  console.log(`${directory} is not on PATH; add it to your shell profile.`);
