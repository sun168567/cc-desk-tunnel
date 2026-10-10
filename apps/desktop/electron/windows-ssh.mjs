import { spawn, execFile } from 'node:child_process';
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { connect, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { componentFailure, missingComponent } from './connect-errors.mjs';

function execute(file, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8', timeout }, (error, stdout) => {
      if (error)
        reject(
          new Error(
            error.code === 'ENOENT'
              ? missingComponent('PowerShell（pwsh.exe）')
              : '本机 SSH 服务的准备步骤失败。\n内置的 PowerShell 或 OpenSSH 可能被安全软件拦截，或临时目录不可写；请检查安全软件的保护记录后重新连接，仍然失败时重新安装本应用。',
          ),
        );
      else resolve(stdout);
    });
  });
}
async function waitForHost(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('close', resolve));
  const timer = setTimeout(() => {
    execFile(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true },
      () => {},
    );
  }, 10000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function probe(port) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.setTimeout(300);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}
// Starts the SSH service of this connection: the bundled OpenSSH on a loopback port, with a host key and a
// login key made for this connection alone. `readyMs` is how long it may take to start listening.
export async function startWindowsSsh(connectionId, binaries, signal, onFailure, readyMs = 10000) {
  if (process.platform !== 'win32') throw new Error('Windows OpenSSH requires Windows.');
  const directory = await mkdtemp(join(tmpdir(), 'cc-desk-tunnel-ssh-'));
  const powershell = binaries.powershell ?? 'pwsh.exe';
  const scriptPath = (name) =>
    binaries.scriptDirectory
      ? join(binaries.scriptDirectory, name)
      : fileURLToPath(new URL(name, import.meta.url));
  const children = [];
  let closed = false;
  let closePromise;
  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      if (children.length) await writeFile(join(directory, 'stop'), '').catch(() => {});
      await Promise.all(children.map(waitForHost));
      await rm(directory, { recursive: true, force: true });
    })();
    return closePromise;
  }
  const check = () => {
    if (signal.aborted || closed) throw new Error('Tunnel cancelled');
  };
  function launch(file, args) {
    check();
    // The host and its components print why they stop; the end of that is kept to explain a failure.
    // What the host is given here reaches every command of the SSH service it starts.
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...binaries.environment },
    });
    const started = Date.now();
    let output = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        output = (output + chunk.toString('utf8')).slice(-8192);
      });
    children.push(child);
    child.once('error', () => {
      if (!closed) onFailure(missingComponent('PowerShell（pwsh.exe）'));
    });
    child.once('close', () => {
      if (!closed) onFailure(componentFailure(output, Date.now() - started < 30000));
    });
    return child;
  }
  try {
    check();
    await access(join(binaries.openssh, 'sshd.exe')).catch(() => {
      throw new Error(missingComponent('sshd.exe'));
    });
    const port = await availablePort();
    const metadata = JSON.parse(
      await execute(
        powershell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          scriptPath('prepare-ssh.ps1'),
          '-Runtime',
          directory,
          '-OpenSshDirectory',
          binaries.openssh,
          '-Port',
          String(port),
        ],
        Math.max(30000, readyMs),
      ),
    );
    check();
    launch(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      scriptPath('component-host.ps1'),
      '-Runtime',
      directory,
      '-OpenSshDirectory',
      binaries.openssh,
      '-OwnerProcessId',
      String(process.pid),
    ]);
    let ready = false;
    for (const started = Date.now(); Date.now() - started < readyMs;) {
      check();
      if (await probe(port)) {
        ready = true;
        break;
      }
      await delay(100);
    }
    if (!ready)
      throw new Error(
        `本机的 SSH 服务在 ${readyMs / 1000} 秒内没有就绪。\n请重新连接；反复出现时检查安全软件是否拦截了内置的 sshd.exe。这台电脑启动较慢时，可在“设置 → 常规”里调大等待时间。`,
      );
    return {
      port,
      credentials: {
        type: 'tunnel.credentials',
        connectionId,
        username: metadata.username,
        privateKey: metadata.privateKey,
        hostPublicKey: metadata.hostPublicKey,
      },
      async close() {
        await close();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
