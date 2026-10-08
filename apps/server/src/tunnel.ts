import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ServerMessage, TunnelCredentials } from '@cc-desk-tunnel/protocol';

export type TunnelOptions = {
  executable: string;
  publicHost: string;
  port: number;
  certificatePath: string;
  keyPath: string;
  serverName: string;
  bindHost?: string;
};
export type SshConnection = { configPath: string; powershellPath: string };

// The SSH configuration a session's system prompt names. Its path is the session's for good; each run points
// it at the connection it runs over. A connection's own directory is new on every reconnect, and a system
// prompt that named it would change with it — the model's prompt cache would then match nothing of the
// conversation, and all of it would be written to the cache again.
export function sessionSshPath(dataDir: string, sessionId: string) {
  return join(dataDir, 'session-ssh', `${sessionId}.conf`);
}
export function sessionSsh(dataDir: string, sessionId: string, ssh: SshConnection): SshConnection {
  const configPath = sessionSshPath(dataDir, sessionId);
  mkdirSync(join(dataDir, 'session-ssh'), { recursive: true, mode: 0o700 });
  const next = `${configPath}.${randomBytes(6).toString('hex')}`;
  writeFileSync(next, `Include ${JSON.stringify(ssh.configPath)}\n`, { mode: 0o600 });
  renameSync(next, configPath);
  return { ...ssh, configPath };
}

export async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No free port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function reachable(port: number) {
  return new Promise<boolean>((resolve) => {
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
export function sshProbe(configPath: string, powershellPath: string) {
  const script =
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Write-Output 'CC_DESK_TUNNEL_SSH_READY'; exit 0";
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const command = `"${powershellPath.replaceAll('"', '')}" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  return new Promise<void>((resolve, reject) => {
    execFile(
      'ssh',
      ['-F', configPath, 'windows', command],
      { timeout: 12000, maxBuffer: 65536 },
      (error, stdout) => {
        if (error || !stdout.includes('CC_DESK_TUNNEL_SSH_READY'))
          reject(new Error('Windows SSH / PowerShell probe failed.'));
        else resolve();
      },
    );
  });
}
export function sshConfig(
  directory: string,
  port: number,
  username: string,
  hostPublicKey: string,
) {
  if (directory.includes('\n') || directory.includes('"'))
    throw new Error('Unsupported data directory');
  return {
    knownHosts: `[127.0.0.1]:${port} ${hostPublicKey}\n`,
    config: [
      'Host windows',
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      `  User ${username}`,
      `  IdentityFile "${join(directory, 'identity')}"`,
      `  UserKnownHostsFile "${join(directory, 'known_hosts')}"`,
      '  IdentitiesOnly yes',
      '  BatchMode yes',
      '  StrictHostKeyChecking yes',
      '  ConnectTimeout 5',
      '  ServerAliveInterval 10',
      '  ServerAliveCountMax 2',
      '  ForwardAgent no',
      '  ClearAllForwardings yes',
      '',
    ].join('\n'),
  };
}
export class WindowsTunnel {
  directory: string;
  options: TunnelOptions;
  id: string;
  process?: ChildProcess;
  remotePort = 0;
  ssh?: SshConnection;
  controller = new AbortController();
  closePromise?: Promise<void>;
  unexpectedClose: () => void;
  constructor(options: TunnelOptions, dataDir: string, id: string, unexpectedClose: () => void) {
    this.options = options;
    this.id = id;
    this.directory = join(dataDir, 'connections', id);
    this.unexpectedClose = unexpectedClose;
  }
  async start(): Promise<Extract<ServerMessage, { type: 'tunnel.configure' }>> {
    const { options } = this;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.remotePort = await availablePort();
    if (this.controller.signal.aborted) throw new Error('Tunnel closed');
    const token = randomBytes(32).toString('base64url');
    const configPath = join(this.directory, 'frps.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        bindAddr: options.bindHost ?? '0.0.0.0',
        bindPort: options.port,
        proxyBindAddr: '127.0.0.1',
        auth: { method: 'token', token },
        allowPorts: [{ single: this.remotePort }],
        maxPortsPerClient: 1,
        transport: {
          tls: { force: true, certFile: options.certificatePath, keyFile: options.keyPath },
        },
        log: { to: 'console', level: 'error', disablePrintColor: true },
      }),
      { mode: 0o600 },
    );
    const child = spawn(options.executable, ['-c', configPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.process = child;
    let startupError = false;
    child.on('error', () => {
      startupError = true;
      this.unexpectedClose();
    });
    child.stderr?.resume();
    child.once('close', () => {
      if (!this.controller.signal.aborted) this.unexpectedClose();
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (startupError || child.exitCode !== null || this.controller.signal.aborted)
        throw new Error('frps startup failed');
      if (await reachable(options.port))
        return {
          type: 'tunnel.configure',
          connectionId: this.id,
          serverAddr: options.publicHost,
          serverPort: options.port,
          remotePort: this.remotePort,
          token,
          certificate: readFileSync(options.certificatePath, 'utf8'),
          serverName: options.serverName,
        };
      await delay(100, undefined, { signal: this.controller.signal });
    }
    throw new Error('frps startup timed out');
  }
  async accept(credentials: TunnelCredentials) {
    if (this.ssh || credentials.connectionId !== this.id || this.controller.signal.aborted)
      throw new Error('Inactive SSH registration');
    const files = sshConfig(
      this.directory,
      this.remotePort,
      credentials.username,
      credentials.hostPublicKey,
    );
    const configPath = join(this.directory, 'ssh_config');
    writeFileSync(join(this.directory, 'identity'), credentials.privateKey, { mode: 0o600 });
    writeFileSync(join(this.directory, 'known_hosts'), files.knownHosts, { mode: 0o600 });
    writeFileSync(configPath, files.config, { mode: 0o600 });
    for (let attempt = 0; attempt < 20; attempt++) {
      if (this.controller.signal.aborted) throw new Error('Tunnel closed');
      try {
        await sshProbe(configPath, credentials.powershellPath);
        if (this.controller.signal.aborted) throw new Error('Tunnel closed');
        this.ssh = { configPath, powershellPath: credentials.powershellPath };
        return;
      } catch {
        await delay(300, undefined, { signal: this.controller.signal });
      }
    }
    throw new Error('Windows SSH readiness timed out');
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.controller.abort();
    this.closePromise = (async () => {
      const child = this.process;
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        await exited;
        clearTimeout(timer);
      }
      this.ssh = undefined;
      rmSync(this.directory, { recursive: true, force: true });
    })();
    return this.closePromise;
  }
}
