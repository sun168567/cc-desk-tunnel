import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// A session opened in ccdt, the terminal client, from the desktop client: ccdt is a program of its own, spoken to
// through its command line alone. It is signed in to the service this window is connected to, with the token the
// window holds, then opens the session in a terminal window of the system's.

// Where ccdt is: on the PATH, else where its install script puts it, as a client started before ccdt was installed
// has the PATH from before.
export function locate(
  { platform = process.platform, env = process.env, home = homedir() } = {},
  exists = existsSync,
) {
  const windows = platform === 'win32';
  const installed = windows
    ? join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'ccdt')
    : join(home, '.local', 'bin');
  return [...(env.PATH ?? env.Path ?? '').split(windows ? ';' : delimiter), installed]
    .filter(Boolean)
    .map((directory) => join(directory, windows ? 'ccdt.cmd' : 'ccdt'))
    .find((file) => exists(file));
}

// What goes on a command line here is a path, a session ID and an address: quoted for the shell that reads it. An
// address with a character that would still mean something to it is refused before (see `openSession`).
const quoted = (text) => `"${text}"`;
const shellQuoted = (text) => `'${text.replaceAll("'", `'\\''`)}'`;
// A .cmd runs through cmd.exe, which takes the command line as written.
function windowsCommand(env, line) {
  return {
    file: env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

// ccdt run without a window, its output read: `input` goes to its standard input.
function run(ccdt, args, system, input) {
  const {
    file,
    args: list,
    options,
  } = system.platform === 'win32'
    ? windowsCommand(system.env, [ccdt, ...args].map(quoted).join(' '))
    : { file: ccdt, args, options: {} };
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      list,
      { ...options, env: system.env, windowsHide: true, timeout: 60_000, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const said = stderr.trim().split('\n').at(-1);
        reject(new Error(said ? `ccdt：${said}` : `ccdt 没有运行成功：${error.message}`));
      },
    );
    // ccdt may end before it reads, as `--version` does, which closes the pipe: how it ended tells the outcome.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// A terminal window of the system's running ccdt with `args` in `cwd`. Should ccdt end with an error, the window
// waits for a key, for what it said to be read.
export function terminalCommand({ platform, env }, ccdt, args, cwd, exists = existsSync) {
  if (platform === 'win32')
    return windowsCommand(env, `${[ccdt, ...args].map(quoted).join(' ')} || pause`);
  const script = `cd ${shellQuoted(cwd)} && ${[ccdt, ...args].map(shellQuoted).join(' ')} || read -r _`;
  // A .command file is Terminal's to run, which asks for no permission as telling Terminal what to do would. It
  // holds no token, and is gone once read.
  if (platform === 'darwin') {
    const path = join(tmpdir(), `ccdt-open-${randomUUID()}.command`);
    return {
      file: 'open',
      args: ['-a', 'Terminal', path],
      options: {},
      script: { path, text: `#!/bin/sh\nrm -f "$0"\n${script}\n` },
    };
  }
  // Linux has no one terminal: the one the system names its default, else the common ones.
  const terminals = [
    ['x-terminal-emulator', '-e'],
    ['gnome-terminal', '--'],
    ['konsole', '-e'],
    ['xfce4-terminal', '-x'],
    ['xterm', '-e'],
  ];
  for (const [name, flag] of terminals) {
    const file = (env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, name))
      .find((path) => exists(path));
    if (file) return { file, args: [flag, 'sh', '-c', script], options: {} };
  }
  throw new Error('没有找到可以打开的终端程序：请在终端里运行 ccdt open。');
}

function launch({ file, args, options, script }, system, cwd) {
  if (script) writeFileSync(script.path, script.text, { mode: 0o700 });
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      ...options,
      cwd,
      env: system.env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', (error) => reject(new Error(`打开终端失败：${error.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `missing` when ccdt is not installed, `outdated` when it is not of this client's release, which is the service's;
// the window then says how to install it. Anything else that goes wrong is thrown, in words for the user.
export async function openSession(
  { url, fingerprint, token, sessionId, projectPath },
  { version, platform = process.platform, env = process.env, home = homedir() },
) {
  if (
    !uuid.test(sessionId) ||
    !/^wss?:\/\/[^\s"'%^&|<>`$\\]+$/.test(url) ||
    !/^[0-9A-Fa-f:]*$/.test(fingerprint ?? '')
  )
    throw new Error('这个连接的地址不能交给 ccdt。');
  const system = { platform, env, home };
  const ccdt = locate(system);
  if (!ccdt) return { status: 'missing' };
  const installed = (await run(ccdt, ['--version'], system)).trim().replace(/^ccdt\s+/, '');
  if (installed !== version) return { status: 'outdated', installed };
  await run(
    ccdt,
    ['login', url, ...(fingerprint ? ['--fingerprint', fingerprint] : []), '--token-stdin'],
    system,
    token,
  );
  const cwd = projectPath && existsSync(projectPath) ? projectPath : home;
  await launch(
    terminalCommand(system, ccdt, ['open', sessionId, '--server', url], cwd),
    system,
    cwd,
  );
  return { status: 'opened' };
}
