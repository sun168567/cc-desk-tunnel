import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createWebSocketStream } from 'ws';
import type { WebSocket } from 'ws';
import type { DevicePlatform, ServerMessage, TunnelCredentials } from '@cc-desk-tunnel/protocol';

export type TunnelOptions = {
  // How long an SSH connection waits for the device to open its channel before it is dropped.
  pairMs?: number;
  // Tells whether a command reaches the device through the SSH configuration; `sshProbe` unless a test replaces it.
  probe?: (configPath: string) => Promise<void>;
  // How long a command started while its device is away waits for the device to come back.
  holdMs?: number;
};
export type SshConnection = { configPath: string };

// SSH connections that may wait for their channel at once, and that may be open at once. Far above what one
// device's commands need; they bound what a stray local process connecting to the port can make the device do.
const MAX_WAITING = 32;
const MAX_CHANNELS = 128;
// How long a channel whose SSH connection ended has to deliver the rest and close.
const CLOSING_MS = 10_000;

// The SSH configuration a session's system prompt names. Its path is the session's for good; each run points
// it at the door of the device it runs on. A system prompt that named something of a connection would change
// with every reconnect — the model's prompt cache would then match nothing of the conversation, and all of it
// would be written to the cache again.
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

// What the device runs for the host `device-script`: a PowerShell script read whole from standard input. The
// script never goes through a command line — cmd.exe stops at 8191 characters and has quoting rules of its own
// — so it is plain text of any length, UTF-8 in and out; errors come back as plain text and its exit code is
// kept. PowerShell's own `-Command -` and `-File -` take standard input a line at a time, as if typed, and
// lose a block that spans lines; hence reading it all first. The device's SSH service names its PowerShell in
// a variable. The command holds no quote characters inside the ones around it, so cmd.exe passes it whole.
// This way of sending scripts came with #31 (chokhung588-cell), which had the model write the command out.
const SCRIPT_FROM_STDIN =
  '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Console]::InputEncoding;' +
  '$PSStyle.OutputRendering=[Management.Automation.OutputRendering]::PlainText;$s=[Console]::In.ReadToEnd();' +
  '$global:LASTEXITCODE=$null;& ([scriptblock]::Create($s));if($null -ne $LASTEXITCODE){exit $LASTEXITCODE};exit [int](-not $?)';
export const SCRIPT_COMMAND = `"%CC_DESK_TUNNEL_PWSH%" -NoLogo -NoProfile -NonInteractive -Command "${SCRIPT_FROM_STDIN}"`;
// The same on a device with a POSIX shell: the user's own, which the device's SSH service names in a variable
// as well, reads the script from standard input and leaves with the status of its last command.
const POSIX_SCRIPT_COMMAND = 'exec "$CC_DESK_TUNNEL_SHELL" -s';
export const scriptCommand = (device: DevicePlatform) =>
  device === 'win32' ? SCRIPT_COMMAND : POSIX_SCRIPT_COMMAND;

// Runs a script the way the system prompt tells Claude to.
export function sshProbe(configPath: string) {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      'ssh',
      ['-F', configPath, 'device-script'],
      { timeout: 20000, maxBuffer: 65536 },
      (error, stdout) => {
        if (error || !stdout.includes('CC_DESK_TUNNEL_SSH_READY'))
          reject(new Error('Device SSH probe failed.'));
        else resolve();
      },
    );
    child.stdin?.on('error', () => {});
    // `echo` is a command of PowerShell and of the POSIX shells alike.
    child.stdin?.end('echo CC_DESK_TUNNEL_SSH_READY\n');
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
  // Longer where a connection may first wait for the device to come back: see `Door`.
  connectSeconds = 15,
  // The system of the device, which decides what its scripts are run by.
  device: DevicePlatform = 'win32',
) {
  if (directory.includes('\n') || directory.includes('"'))
    throw new Error('Unsupported data directory');
  const shared = sharedConnectionPath(directory, platform);
  return {
    knownHosts: `[127.0.0.1]:${port} ${hostPublicKey}\n`,
    config: [
      // The same computer under a name that takes a script instead of a command. `ssh` reads % in this
      // option as its own, so the device's variable is written with two.
      'Host device-script',
      `  RemoteCommand ${scriptCommand(device).replaceAll('%', '%%')}`,
      '  RequestTTY no',
      // `device` is the name the system prompt gives; conversations begun before 0.2.11 know it as `windows`.
      'Host device windows device-script',
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
      `  ConnectTimeout ${connectSeconds}`,
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
  // What ssh sent before it went goes on first; a channel that does not answer its end is cut after a while.
  socket.once('close', () => {
    stream.end();
    const cut = setTimeout(() => stream.destroy(), CLOSING_MS);
    stream.once('close', () => clearTimeout(cut));
  });
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
  // What the device registered with, once its SSH service answered through this tunnel.
  credentials?: TunnelCredentials;
  platform: DevicePlatform = 'win32';
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
    const listener = createServer({ pauseOnConnect: true }, (socket) => this.carry(socket));
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
  // Takes one SSH connection, paused, and asks the device for the channel to join it to.
  carry(socket: Socket) {
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
  async accept(credentials: TunnelCredentials, platform: DevicePlatform = 'win32') {
    if (this.ssh || credentials.connectionId !== this.id || this.controller.signal.aborted)
      throw new Error('Inactive SSH registration');
    this.platform = platform;
    const files = sshConfig(
      this.directory,
      this.port,
      credentials.username,
      credentials.hostPublicKey,
      process.platform,
      15,
      platform,
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
        this.credentials = credentials;
        return;
      } catch {
        await delay(300, undefined, { signal: this.controller.signal });
      }
    }
    throw new Error('Device SSH readiness timed out');
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

// Where the commands of one device go, whichever of its connections is there to carry them. A connection's
// tunnel has its own port and keys, new each time; the door keeps one port and one configuration for the
// device and hands every SSH connection to the tunnel in use. A session's SSH configuration points here, so
// a reconnect changes nothing a running CLI or its prompt names: the keys in this directory are replaced and
// the next command uses them.
//
// While the device is away the door still answers. An SSH connection made then is held, unread, until a
// tunnel is there or `holdMs` has passed: a command Claude starts during a short outage is late, not failed.
// One that was running when the connection broke is lost with it — SSH cannot be taken up again.
export class Door {
  directory: string;
  ssh?: SshConnection;
  private port = 0;
  private holdMs: number;
  private listener?: Server;
  private tunnel?: Tunnel;
  private held = new Map<Socket, NodeJS.Timeout>();
  private closed = false;
  constructor(options: TunnelOptions, dataDir: string, device: string) {
    this.directory = join(dataDir, 'devices', device);
    this.holdMs = options.holdMs ?? 60000;
  }
  async start() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const listener = createServer({ pauseOnConnect: true }, (socket) => this.incoming(socket));
    this.listener = listener;
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        listener.off('error', reject);
        resolve();
      });
    });
    listener.on('error', () => {});
    this.port = (listener.address() as AddressInfo).port;
  }
  private incoming(socket: Socket) {
    if (this.closed) socket.destroy();
    else if (this.tunnel) this.tunnel.carry(socket);
    else if (this.held.size >= MAX_WAITING) socket.destroy();
    else {
      socket.on('error', () => socket.destroy());
      this.held.set(
        socket,
        setTimeout(() => socket.destroy(), this.holdMs),
      );
      socket.once('close', () => {
        clearTimeout(this.held.get(socket));
        this.held.delete(socket);
      });
    }
  }
  // The tunnel that carries the device's commands from now on, or none while the device is away. Its keys
  // replace the ones here; SSH connections that were waiting go to it.
  use(tunnel: Tunnel | undefined) {
    if (this.closed || tunnel === this.tunnel) return;
    this.tunnel = tunnel;
    if (!tunnel?.credentials) return;
    const { username, hostPublicKey, privateKey } = tunnel.credentials;
    const files = sshConfig(
      this.directory,
      this.port,
      username,
      hostPublicKey,
      process.platform,
      Math.ceil(this.holdMs / 1000) + 15,
      tunnel.platform,
    );
    const write = (name: string, text: string) => {
      const next = join(this.directory, `${name}.${randomBytes(6).toString('hex')}`);
      writeFileSync(next, text, { mode: 0o600 });
      renameSync(next, join(this.directory, name));
    };
    write('identity', privateKey);
    write('known_hosts', files.knownHosts);
    write('ssh_config', files.config);
    this.ssh = { configPath: join(this.directory, 'ssh_config') };
    for (const [socket, timer] of this.held) {
      clearTimeout(timer);
      this.held.delete(socket);
      tunnel.carry(socket);
    }
  }
  uses(tunnel: Tunnel | undefined) {
    return this.tunnel === tunnel;
  }
  // Whether a command reaches the device now, rather than waiting for it to come back.
  get ready() {
    return !!this.tunnel?.ssh;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.tunnel = undefined;
    const listener = this.listener;
    const closed = listener?.listening
      ? new Promise<void>((resolve) => listener.close(() => resolve()))
      : undefined;
    for (const socket of this.held.keys()) socket.destroy();
    await closed;
    rmSync(this.directory, { recursive: true, force: true });
  }
}
