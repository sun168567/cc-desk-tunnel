import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where a plugin's code runs: in its own directory, and with nothing else in reach when confined.
export type Where = { root: string; confined: boolean };

const RUN = fileURLToPath(new URL('plugin-run.py', import.meta.url));
// What a confined plugin's programs run from: the system and Node. The last of the system's is often a link to
// elsewhere.
const READABLE = [
  ...['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt', '/etc/resolv.conf'],
  process.execPath,
];
const DEVICES = ['/dev/null', '/dev/zero', '/dev/full', '/dev/random', '/dev/urandom'];
const VARIABLES = /^(PATH|LANG|LC_\w+|TZ|(https?|all|no)_proxy|NODE_EXTRA_CA_CERTS)$/i;

// Whether this system can confine a plugin (see plugin-run.py).
export const confinable = () =>
  new Promise<boolean>((done) => {
    if (process.platform !== 'linux') return done(false);
    execFile('python3', ['-I', RUN, '--probe'], { timeout: 10_000 }, (error) => done(!error));
  });

// What goes before a command of the plugin's to run it there, and its environment. What it keeps in the one of
// CLAUDE_PLUGIN_DATA stays when the plugin is updated.
export function launch({ root, confined }: Where) {
  const data = join(root, '..', '..', 'plugin-data', basename(root));
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const own = { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data };
  if (!confined) return { before: [], data, env: { ...process.env, ...own } };
  const reach = [...READABLE, root, '--write', ...DEVICES, data, '--'];
  const passed = Object.entries(process.env).filter(([name]) => VARIABLES.test(name));
  return {
    before: ['python3', '-I', RUN, ...reach],
    data,
    env: { ...Object.fromEntries(passed), HOME: data, TMPDIR: data, ...own },
  };
}

// Ends a plugin's process and what it started: it was started detached, as a group of its own. A confined one's
// launcher is asked first, as it ends what left the group too.
export function stop(child: ChildProcess) {
  if (process.platform === 'win32' || !child.pid) return void child.kill();
  const end = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      // Already gone.
    }
  };
  end('SIGTERM');
  setTimeout(() => end('SIGKILL'), 1000).unref();
}
