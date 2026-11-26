import { basename, isAbsolute, join } from 'node:path';
import { access, chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import { failure } from './failure.cjs';

export const quotePosix = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export async function resolvePosixShell(options = {}) {
  if (options.signal?.aborted) throw new Error('Tunnel cancelled');
  let accountShell;
  try {
    accountShell = userInfo().shell;
  } catch {
    /* The platform fallback remains available. */
  }
  const supported = (value) =>
    typeof value === 'string' &&
    isAbsolute(value) &&
    !/[\0\r\n]/.test(value) &&
    /^(?:zsh|bash)$/.test(basename(value));
  // Commands are written for a POSIX shell. A login shell of another kind, fish for one, is passed over for
  // the system's own; what its startup files add to the environment is then not there.
  const path =
    options.shellPath ??
    [process.env.SHELL, accountShell].find(supported) ??
    (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  if (!supported(path)) throw failure('desktop:shell.unsupported');
  const resolved = await realpath(path).catch(() => {
    throw failure('desktop:shell.missing');
  });
  await access(resolved, constants.X_OK).catch(() => {
    throw failure('desktop:shell.notExecutable');
  });
  if (options.signal?.aborted) throw new Error('Tunnel cancelled');
  // Shell invocation names select their startup and execution semantics. Keep
  // the validated bash/zsh path even when its target has a versioned basename.
  return path;
}

// A private Unix socket carries only environment JSON. Login shells and Electron
// can close inherited auxiliary descriptors; a socket opened by the helper after
// initialization works for both. Profile output stays on separate stdout/stderr.
export async function captureShellEnvironment(
  shell,
  supervisor,
  { signal, timeoutMs = 10000, maxBytes = 1024 * 1024, env = process.env, cwd } = {},
) {
  if (signal?.aborted) throw new Error('Tunnel cancelled');
  // macOS limits Unix socket paths to 104 bytes. User-configured TMPDIR can be
  // longer; a private directory under /tmp keeps the endpoint within that limit.
  const root =
    Buffer.byteLength(join(tmpdir(), 'cc-env-123456', 'env.sock')) < 100 ? tmpdir() : '/tmp';
  const directory = await mkdtemp(join(root, 'cc-env-'));
  const socketPath = join(directory, 'env.sock');
  const nonce = randomBytes(24).toString('hex');
  const sockets = new Set();
  let receive;
  const server = createServer((socket) => {
    if (sockets.size) return socket.destroy();
    sockets.add(socket);
    socket.on('error', () => {});
    receive?.(socket);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    if (signal?.aborted) throw new Error('Tunnel cancelled');
    return await new Promise((resolve, reject) => {
      const baseEnvironment = { ...env };
      delete baseEnvironment.ELECTRON_RUN_AS_NODE;
      // The path and the nonce are arguments of a fixed program, not text written into it.
      const script = `const [p,n]=process.argv.slice(-2);const s=require('node:net').createConnection(p);s.on('error',()=>process.exit(1));s.once('connect',()=>s.end(JSON.stringify({nonce:n,environment:process.env})));`;
      const command = `exec /usr/bin/env ELECTRON_RUN_AS_NODE=1 ${quotePosix(process.execPath)} -e ${quotePosix(script)} ${quotePosix(socketPath)} ${quotePosix(nonce)}`;
      const child = supervisor.spawn(shell, ['-lic', command], {
        env: baseEnvironment,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let settled = false;
      let childClosed = false;
      let received = false;
      let bytes = 0;
      let noise = 0;
      const output = [];
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (error) void child.stopGroup();
        error ? reject(error) : resolve(value);
      };
      const cancel = () => finish(new Error('Tunnel cancelled'));
      const timer = setTimeout(() => finish(failure('desktop:shell.timeout')), timeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      receive = (socket) => {
        socket.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) return finish(failure('desktop:shell.environmentTooLarge'));
          output.push(chunk);
        });
        socket.once('end', () => {
          received = true;
          complete();
        });
      };
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk) => {
          noise += chunk.length;
          if (noise > maxBytes) finish(failure('desktop:shell.outputTooLarge'));
        });
      child.once('error', (error) =>
        finish(
          error.code
            ? failure('desktop:shell.cannotStart', { code: error.code })
            : failure('desktop:shell.cannotStartUnknown'),
        ),
      );
      child.once('close', (code, signal) => {
        childClosed = true;
        if (code !== 0)
          return finish(
            signal
              ? failure('desktop:shell.signalled', { signal })
              : failure('desktop:shell.exited', { code }),
          );
        complete();
      });
      function complete() {
        if (settled || !received || !childClosed) return;
        try {
          const captured = JSON.parse(Buffer.concat(output).toString('utf8'));
          if (captured.nonce !== nonce) throw new Error();
          const environment = captured.environment;
          if (!environment || Array.isArray(environment) || typeof environment !== 'object')
            throw new Error();
          for (const [key, value] of Object.entries(environment))
            if (typeof value !== 'string' || /[\0=]/.test(key) || value.includes('\0'))
              throw new Error();
          delete environment.ELECTRON_RUN_AS_NODE;
          // Prevent per-command noninteractive startup hooks from repeating login profiles.
          delete environment.BASH_ENV;
          delete environment.ENV;
          finish(undefined, environment);
        } catch {
          finish(failure('desktop:shell.noEnvironment'));
        }
      }
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}
