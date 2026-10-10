import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createWebSocketStream } from 'ws';
import type { WebSocket } from 'ws';
import type { ServerMessage, TunnelCredentials } from '@cc-desk-tunnel/protocol';

export type TunnelOptions = {
  // How long an SSH connection waits for the device to open its channel before it is dropped.
  pairMs?: number;
  // Tells whether a command reaches the device through the SSH configuration; `sshProbe` unless a test replaces it.
  probe?: (configPath: string) => Promise<void>;
};
export type SshConnection = { configPath: string };

// SSH connections that may wait for their channel at once, and that may be open at once. Far above what one
// device's commands need; they bound what a stray local process connecting to the port can make the device do.
const MAX_WAITING = 32;
const MAX_CHANNELS = 128;

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

// Runs what the system prompt tells Claude to run: the device's SSH service names its PowerShell in a variable.
export function sshProbe(configPath: string) {
  const script =
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Write-Output 'CC_DESK_TUNNEL_SSH_READY'; exit 0";
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const command = `"%CC_DESK_TUNNEL_PWSH%" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  return new Promise<void>((resolve, reject) => {
    execFile(
      'ssh',
      ['-F', configPath, 'device', command],
      { timeout: 20000, maxBuffer: 65536 },
      (error, stdout) => {
        if (error || !stdout.includes('CC_DESK_TUNNEL_SSH_READY'))
          reject(new Error('Windows SSH / PowerShell probe failed.'));
        else resolve();
      },
    );
  });
}
// Where the commands of one device share an SSH connection, or nothing when they cannot: the `ssh` of Windows,
// which tests run this service with, has no connection sharing, and the path of a Unix socket is limited to
// 108 bytes, of which `ssh` takes 17 for the name it binds under before renaming.
export function sharedConnectionPath(directory: string, platform = process.platform) {
  const path = join(directory, 'mux');
  return platform !== 'win32' && Buffer.byteLength(path) <= 88 ? path : undefined;
}
export function sshConfig(
  directory: string,
  port: number,
  username: string,
  hostPublicKey: string,
  platform = process.platform,
) {
  if (directory.includes('\n') || directory.includes('"'))
    throw new Error('Unsupported data directory');
  const shared = sharedConnectionPath(directory, platform);
  return {
    knownHosts: `[127.0.0.1]:${port} ${hostPublicKey}\n`,
    config: [
      // `device` is the name the system prompt gives; conversations begun before 0.2.11 know it as `windows`.
      'Host device windows',
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      `  User ${username}`,
      `  IdentityFile "${join(directory, 'identity')}"`,
      `  UserKnownHostsFile "${join(directory, 'known_hosts')}"`,
      '  IdentitiesOnly yes',
      '  BatchMode yes',
      '  StrictHostKeyChecking yes',
      // The local port answers at once; this is the time the device has to open the channel behind it and
      // its SSH service to greet, which is a few round trips to the device.
      '  ConnectTimeout 15',
      '  ServerAliveInterval 10',
      '  ServerAliveCountMax 2',
      '  ForwardAgent no',
      '  ClearAllForwardings yes',
      // Signing in costs several round trips to the device, which a command would otherwise pay each time.
      // The first command opens a connection that the following ones run over, and that stays for a while
      // after the last; it ends with the tunnel, whose close cuts it.
      ...(shared
        ? ['  ControlMaster auto', `  ControlPath "${shared}"`, '  ControlPersist 600']
        : []),
      '',
    ].join('\n'),
  };
}

// Joins one SSH connection to the channel connection opened for it. An end on either side ends the other once
// what was already sent has been delivered; an error cuts both.
function splice(socket: Socket, channel: WebSocket) {
  const stream = createWebSocketStream(channel);
  stream.on('error', () => socket.destroy());
  socket.once('close', () => stream.destroy());
  socket.pipe(stream);
  stream.pipe(socket);
}

// The execution channel of one connected device. `ssh` on this machine connects to a loopback port here; for
// each of its connections the device is asked, over the control connection, to open one more connection to
// the service, and the two are joined byte for byte. The SSH protocol is not read: authentication, encryption
// and flow control stay between `ssh` and the device's SSH service.
export class Tunnel {
  directory: string;
  id: string;
  port = 0;
  ssh?: SshConnection;
  controller = new AbortController();
  closePromise?: Promise<void>;
  private secret = randomBytes(32).toString('base64url');
  private pairMs: number;
  private probe: NonNullable<TunnelOptions['probe']>;
  private listener?: Server;
  private waiting = new Map<string, { socket: Socket; timer: NodeJS.Timeout }>();
  private channels = new Map<Socket, WebSocket>();
  // Asks the device to open a channel; false when the control connection can no longer carry the request.
  private request: (channelId: string) => boolean;
  private unexpectedClose: () => void;
  constructor(
    options: TunnelOptions,
    dataDir: string,
    id: string,
    request: (channelId: string) => boolean,
    unexpectedClose: () => void,
  ) {
    this.id = id;
    this.directory = join(dataDir, 'connections', id);
    this.pairMs = options.pairMs ?? 10000;
    this.probe = options.probe ?? sshProbe;
    this.request = request;
    this.unexpectedClose = unexpectedClose;
  }
  async start(): Promise<Extract<ServerMessage, { type: 'tunnel.offer' }>> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    // Nothing is read from an SSH connection until its channel is there to take it.
    const listener = createServer({ pauseOnConnect: true }, (socket) => this.incoming(socket));
    this.listener = listener;
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        listener.off('error', reject);
        resolve();
      });
    });
    listener.on('error', () => {
      if (!this.controller.signal.aborted) this.unexpectedClose();
    });
    if (this.controller.signal.aborted) throw new Error('Tunnel closed');
    this.port = (listener.address() as AddressInfo).port;
    return { type: 'tunnel.offer', connectionId: this.id, secret: this.secret };
  }
  matches(secret: string) {
    const digest = (value: string) => createHash('sha256').update(value).digest();
    return timingSafeEqual(digest(secret), digest(this.secret));
  }
  private incoming(socket: Socket) {
    socket.on('error', () => socket.destroy());
    if (
      this.controller.signal.aborted ||
      this.waiting.size >= MAX_WAITING ||
      this.channels.size >= MAX_CHANNELS
    ) {
      socket.destroy();
      return;
    }
    const channelId = randomUUID();
    const timer = setTimeout(() => socket.destroy(), this.pairMs);
    this.waiting.set(channelId, { socket, timer });
    socket.once('close', () => {
      clearTimeout(timer);
      this.waiting.delete(channelId);
    });
    if (!this.request(channelId)) socket.destroy();
  }
  // Takes the connection the device opened for a waiting SSH connection. False when none waits under that
  // name any more: it gave up, or was already served.
  attach(channelId: string, channel: WebSocket) {
    const entry = this.waiting.get(channelId);
    if (!entry || this.controller.signal.aborted) return false;
    clearTimeout(entry.timer);
    this.waiting.delete(channelId);
    const { socket } = entry;
    this.channels.set(socket, channel);
    socket.once('close', () => this.channels.delete(socket));
    splice(socket, channel);
    return true;
  }
  async accept(credentials: TunnelCredentials) {
    if (this.ssh || credentials.connectionId !== this.id || this.controller.signal.aborted)
      throw new Error('Inactive SSH registration');
    const files = sshConfig(
      this.directory,
      this.port,
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
        await this.probe(configPath);
        if (this.controller.signal.aborted) throw new Error('Tunnel closed');
        this.ssh = { configPath };
        return;
      } catch {
        await delay(300, undefined, { signal: this.controller.signal });
      }
    }
    throw new Error('Windows SSH readiness timed out');
  }
  // Every SSH connection ends with the tunnel: those still waiting and those in use.
  close() {
    if (this.closePromise) return this.closePromise;
    this.controller.abort();
    this.closePromise = (async () => {
      const listener = this.listener;
      const closed = listener?.listening
        ? new Promise<void>((resolve) => listener.close(() => resolve()))
        : undefined;
      for (const { socket } of this.waiting.values()) socket.destroy();
      for (const [socket, channel] of this.channels) {
        socket.destroy();
        channel.terminate();
      }
      await closed;
      this.ssh = undefined;
      rmSync(this.directory, { recursive: true, force: true });
    })();
    return this.closePromise;
  }
}
