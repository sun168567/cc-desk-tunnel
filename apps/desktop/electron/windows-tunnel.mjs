import { spawn, execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { connect, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

function execute(file, args) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, encoding: 'utf8', timeout: 30000 },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              'Windows SSH preparation failed. Check bundled OpenSSH, PowerShell 7 and directory permissions.',
            ),
          );
        else resolve(stdout);
      },
    );
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
export async function startWindowsTunnel(configuration, binaries, signal, onFailure) {
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
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    children.push(child);
    child.once('error', () => {
      if (!closed) onFailure('组件启动失败，请检查安装与杀毒软件状态。');
    });
    child.once('close', () => {
      if (!closed) onFailure('Windows 隧道组件已退出，请重新连接。');
    });
    return child;
  }
  try {
    check();
    const port = await availablePort();
    const metadata = JSON.parse(
      await execute(powershell, [
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
      ]),
    );
    check();
    const caPath = join(directory, 'server.crt');
    await writeFile(caPath, configuration.certificate, 'utf8');
    const configPath = join(directory, 'frpc.json');
    await writeFile(
      configPath,
      JSON.stringify({
        serverAddr: configuration.serverAddr,
        serverPort: configuration.serverPort,
        loginFailExit: true,
        auth: { method: 'token', token: configuration.token },
        transport: {
          tls: { enable: true, trustedCaFile: caPath, serverName: configuration.serverName },
        },
        proxies: [
          {
            name: configuration.connectionId,
            type: 'tcp',
            localIP: '127.0.0.1',
            localPort: port,
            remotePort: configuration.remotePort,
          },
        ],
        log: { to: 'console', level: 'error', disablePrintColor: true },
      }),
      'utf8',
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
      '-FrpcPath',
      binaries.frpc,
    ]);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      check();
      if (await probe(port)) {
        ready = true;
        break;
      }
      await delay(100);
    }
    if (!ready) throw new Error('Windows OpenSSH startup timed out');
    return {
      credentials: {
        type: 'tunnel.credentials',
        connectionId: configuration.connectionId,
        username: metadata.username,
        powershellPath: metadata.powershellPath,
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
