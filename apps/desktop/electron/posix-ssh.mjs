import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePosixShell } from './shell-environment.mjs';

// Starts the SSH service of this connection on macOS and Linux: an SSH server inside a process of this
// program, on a loopback port, with a host key and a login key made for this connection alone. It runs
// commands with the user's shell and gives SFTP to the system's own server; nothing is installed and the
// system's Remote Login stays as it is. Takes and returns what `startWindowsSsh` does.
//
// Running the listener in an IPC-owned process also makes abrupt Electron exits
// observable. The worker stops all process groups before it disconnects and exits.
export async function startPosixSsh(connectionId, options, signal, onFailure, readyMs = 10000) {
  if (signal.aborted) throw new Error('Tunnel cancelled');
  const shell = await resolvePosixShell({ shellPath: options.shellPath, signal });
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Tunnel cancelled'));
    const worker = fork(fileURLToPath(new URL('posix-ssh-worker.mjs', import.meta.url)), [], {
      execPath: process.execPath,
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let closed = false;
    let ready = false;
    let closePromise;
    const exited = new Promise((done) => worker.once('close', done));
    const close = () => {
      if (closePromise) return closePromise;
      closed = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      closePromise = (async () => {
        if (worker.connected) worker.send({ type: 'close' }, () => {});
        else if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGTERM');
        // It stops its commands within a second or two; one that does not answer is ended, so that disconnecting
        // or quitting never waits on it for good.
        const stuck = setTimeout(() => worker.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(stuck);
      })();
      return closePromise;
    };
    const fail = (message) => {
      if (closed) return;
      const stopped = close();
      if (ready) onFailure(message);
      else void stopped.then(() => reject(new Error(message)));
    };
    const cancel = () => {
      const stopped = close();
      if (!ready) void stopped.then(() => reject(new Error('Tunnel cancelled')));
    };
    // The worker gives the login shell `readyMs` to report its environment and says so itself; this is for a
    // worker that says nothing at all, with time left for the keys and the rest of its start.
    const timer = setTimeout(
      () => fail('本机执行服务初始化超时，请检查登录 shell 启动脚本。'),
      readyMs + 5000,
    );
    signal.addEventListener('abort', cancel, { once: true });
    worker.once('error', () => fail('无法启动本机 SSH 执行服务。'));
    worker.once('exit', (code, signal) =>
      fail(
        `本机 SSH 执行服务已停止（${signal ? `信号 ${signal}` : `退出码 ${code}`}），请重新连接。`,
      ),
    );
    worker.on('message', (message) => {
      if (closed) return;
      if (message.type === 'failed') return fail(message.message);
      if (message.type !== 'ready' || ready) return;
      ready = true;
      clearTimeout(timer);
      resolve({ port: message.port, credentials: message.credentials, close });
    });
    worker.send(
      {
        type: 'start',
        connectionId,
        shell,
        timeoutMs: readyMs,
        sftpPath: options.sftpPath,
        env: options.env,
        // What every command of the service is given, the way the Windows host gives it: see `environment`
        // in main.cjs.
        environment: options.environment,
        cwd: options.cwd,
        keepaliveInterval: options.keepaliveInterval,
      },
      (error) => {
        if (error) fail('无法初始化本机 SSH 执行服务。');
      },
    );
  });
}
