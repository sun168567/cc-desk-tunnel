import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

// The environment of a plugin's processes. What it keeps in the one of CLAUDE_PLUGIN_DATA stays when the plugin is updated.
export function launch(root: string) {
  const data = join(root, '..', '..', 'plugin-data', basename(root));
  mkdirSync(data, { recursive: true, mode: 0o700 });
  return { data, env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data } };
}

// Ends a plugin's process and what it started: it was started detached, as a group of its own.
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
