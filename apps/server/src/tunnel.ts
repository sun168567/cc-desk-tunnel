import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { delimiter, join } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createWebSocketStream } from 'ws';
import type { WebSocket } from 'ws';
import type {
  DevicePlatform,
  DeviceShell,
  ServerMessage,
  TunnelCredentials,
} from '@cc-desk-tunnel/protocol';
import { phrase, type Words } from '@cc-desk-tunnel/i18n';
import { systemShell } from './device-terms.ts';
import { textOf } from './errors.ts';

export type TunnelOptions = {
  // How long an SSH connection waits for the device to open its channel before it is dropped.
  pairMs?: number;
  // Tells whether a command reaches the device through the SSH configuration; `sshProbe` unless a test replaces it.
  probe?: (configPath: string, host: string) => Promise<void>;
  // How long a command started while its device is away waits for the device to come back.
  holdMs?: number;
};
// `bin`, for a session, holds the `ssh`, `scp` and `sftp` its CLI finds first on its PATH.
export type SshConnection = { configPath: string; bin?: string };

// SSH connections that may wait for their channel at once, and that may be open at once. Far above what one
// device's commands need; they bound what a stray local process connecting to the port can make the device do.
const MAX_WAITING = 32;
const MAX_CHANNELS = 128;
// How long a channel whose SSH connection ended has to deliver the rest and close.
const CLOSING_MS = 10_000;

// How a session's CLI reaches its device: `ssh`, `scp` and `sftp` first on its PATH that read an SSH configuration of
// the session's, so that Claude writes `ssh device-pwsh` as it would for any host it has an alias for, and nothing in
// its prompt names a file here. Each run points the configuration at the door of the device it runs on, and the door
// keeps it through reconnects. Every other host is reached as plain `ssh` would: a configuration given to `ssh`
// replaces the user's and the system's own, so they are read here for those hosts.
export function sessionSshPath(dataDir: string, sessionId: string) {
  return join(dataDir, 'session-ssh', sessionId);
}
//
// The user's other computers online are there too, by the host names `devices` lists (see `writeDevices`): the
// script names the session's own computer among them. A session the service owns has no computer of its own, `ssh`
// none, and reaches the user's computers all the same.
export function sessionSsh(
  dataDir: string,
  sessionId: string,
  ssh: SshConnection | undefined,
  device?: string,
): SshConnection {
  const directory = sessionSshPath(dataDir, sessionId);
  const bin = join(directory, 'bin');
  const configPath = join(directory, 'config');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  // Where a session's configuration was until 0.3.12.
  rmSync(`${directory}.conf`, { force: true });
  const write = (path: string, text: string, mode: number) => {
    const next = `${path}.${randomBytes(6).toString('hex')}`;
    writeFileSync(next, text, { mode });
    renameSync(next, path);
  };
  write(
    configPath,
    `${ssh ? `Include ${JSON.stringify(ssh.configPath)}\n` : ''}Include ${JSON.stringify(join(dataDir, 'devices', 'hosts'))}\nHost * !device !device-*\n  Include ~/.ssh/config /etc/ssh/ssh_config\n`,
    0o600,
  );
  write(
    join(bin, 'devices'),
    devicesScript(join(dataDir, 'devices', 'list'), ssh ? device : undefined),
    0o700,
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const name of ['ssh', 'scp', 'sftp'])
    write(
      join(bin, name),
      `#!/bin/sh\nexec ${quote(program(name))} -F ${quote(configPath)} "$@"\n`,
      0o700,
    );
  return { configPath, bin };
}
// Lists the user's computers online for the session's CLI, from the list `writeDevices` keeps.
function devicesScript(list: string, device = '') {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const program = [
    'BEGIN { FS = "\\t" }',
    '{ n++; mark = $1 == me ? ", this session\'s own computer, also reached as device" : ""',
    '  state = $4 == "ready" ? "" : ", reconnecting: a command waits up to a minute for it"',
    '  print $2 " \\"" $3 "\\"" mark state "\\n  hosts: " $5 }',
    'END { if (!n) print "None of the user\'s computers is online." }',
  ].join('\n');
  return `#!/bin/sh\n# The user's computers online now and the host names that reach each, used as device's are.\ncat ${quote(list)} 2>/dev/null | awk -v me=${quote(device)} ${quote(program)}\n`;
}

// The host names of the user's computers online: `device-<its name>`, and that with each of its shells after it, as
// `device` has. Where its name gives nothing to make one of, or it would be taken already, by `device` and its
// shells' or by another computer's, the start of the computer's ID tells it apart.
const SHELL_NAMES = ['pwsh', 'bash', 'zsh'];
export function deviceHosts(devices: { id: string; name: string }[]) {
  const taken = new Set(['device', ...SHELL_NAMES.map((shell) => `device-${shell}`)]);
  const all = (name: string) => [name, ...SHELL_NAMES.map((shell) => `${name}-${shell}`)];
  const hosts = new Map<string, string>();
  for (const device of [...devices].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const slug = device.name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 24)
      .replace(/^-+|-+$/g, '');
    const tail = device.id.replaceAll('-', '').slice(0, 6);
    let name = `device-${slug || tail}`;
    if (
      all(name).some((host) => taken.has(host)) ||
      SHELL_NAMES.some((shell) => name.endsWith(`-${shell}`))
    )
      name = `device-${slug ? `${slug}-` : ''}${tail}`;
    for (const host of all(name)) taken.add(host);
    hosts.set(device.id, name);
  }
  return hosts;
}
export type OnlineDevice = {
  id: string;
  name: string;
  platform: DevicePlatform;
  ready: boolean;
  door: Door;
};
// What every session's `ssh` and `devices` read of the user's computers online: `hosts`, the configuration that
// reaches each by its door under the names of `deviceHosts`, and `list`, a line for each. Rewritten whenever one
// comes, goes or changes, so that neither a session's configuration nor its prompt changes with them.
export function writeDevices(dataDir: string, devices: OnlineDevice[]) {
  const directory = join(dataDir, 'devices');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const names = deviceHosts(devices);
  const config: string[] = [];
  const list: string[] = [];
  const system = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
  for (const device of devices) {
    const name = names.get(device.id)!;
    const hosts = device.door.hosts(name);
    if (!hosts) continue;
    config.push(hosts.config);
    list.push(
      [
        device.id,
        system[device.platform],
        device.name.replace(/[\t\r\n"]+/g, ' '),
        device.ready ? 'ready' : 'away',
        [name, ...hosts.shells.map((shell) => `${name}-${shell}`)].join(' '),
      ].join('\t'),
    );
  }
  const write = (file: string, text: string) => {
    const next = join(directory, `${file}.${randomBytes(6).toString('hex')}`);
    writeFileSync(next, text, { mode: 0o600 });
    renameSync(next, join(directory, file));
  };
  write('hosts', config.join(''));
  write('list', list.map((line) => `${line}\n`).join(''));
}

// The program on this service's PATH, which a session's own come before.
export function program(name: string) {
  for (const directory of (process.env.PATH ?? '').split(delimiter))
    if (directory && existsSync(join(directory, name))) return join(directory, name);
  return join('/usr/bin', name);
}

// What the device runs for the host `device-pwsh`: a PowerShell script read whole from standard input. The
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
const PWSH_COMMAND = `"%CC_DESK_TUNNEL_PWSH%" -NoLogo -NoProfile -NonInteractive -Command "${SCRIPT_FROM_STDIN}"`;
// For `device-bash`: Git Bash reads its standard input as a script by itself and leaves with the status of its last
// command. The console the commands of the SSH service share, one without a window, is first switched to UTF-8, as
// setting [Console]::OutputEncoding does in PowerShell: Windows programs a script runs, cmd.exe and ping among them,
// write in its code page, which is otherwise the system's, GBK on a Chinese Windows. The device names its Git Bash in
// a variable as it does its PowerShell.
const BASH_COMMAND = 'chcp.com 65001 >nul & "%CC_DESK_TUNNEL_BASH%" -s';
// The same on a device with a POSIX shell: the user's own, which the device's SSH service names in a variable
// as well.
const POSIX_COMMAND = 'exec "$CC_DESK_TUNNEL_SHELL" -s';
export const shellCommand = (device: DevicePlatform, shell: DeviceShell) =>
  device !== 'win32' ? POSIX_COMMAND : shell === 'bash' ? BASH_COMMAND : PWSH_COMMAND;
// The shells a device's SSH service says it has that its system can have: Git Bash and PowerShell on Windows, the
// user's own shell elsewhere. The one Windows always has comes first.
export function shellsOf(device: DevicePlatform, said: DeviceShell[]) {
  const shells = [...new Set(said)].filter((shell) =>
    device === 'win32' ? shell !== 'zsh' : shell !== 'pwsh',
  );
  if (device === 'win32') return ['pwsh' as const, ...shells.filter((shell) => shell === 'bash')];
  return shells.length ? shells.slice(0, 1) : [systemShell(device)];
}

// What the device or `ssh` said when a probe failed, in a few hundred characters: the shell's own error, a
// refused sign-in or a connection that broke. A Windows device writes in the code page of its system, which on a
// Chinese one is GBK; text that is not UTF-8 is read as that.
export function probeOutput(output: Buffer) {
  let text = output.toString('utf8');
  if (text.includes('\uFFFD')) text = new TextDecoder('gb18030').decode(output);
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(' ')
    .slice(0, 300);
}
// A probe that got no ready answer; the message is what the device or `ssh` said instead.
// What the device answered, or what it did not: outside text as it is, else words of the service.
export class ProbeFailure extends Error {
  words: Words;
  constructor(words: Words) {
    super(textOf(words));
    this.words = words;
  }
}
// Runs a script the way the system prompt tells Claude to, in the shell of `host`. A failure says what went wrong.
export function sshProbe(configPath: string, host: string) {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      'ssh',
      ['-F', configPath, host],
      { timeout: 20000, maxBuffer: 65536, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (!error && stdout.toString('utf8').includes('CC_DESK_TUNNEL_SSH_READY'))
          return resolve();
        const said = probeOutput(Buffer.concat([stderr, stdout]));
        reject(
          new ProbeFailure(
            error?.killed
              ? phrase('service:probe.noAnswer')
              : said ||
                  (error
                    ? phrase('service:probe.noOutputCode', { code: String(error.code) })
                    : phrase('service:probe.noOutput')),
          ),
        );
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
  // The system of the device and its shells, which decide what its scripts are run by.
  device: DevicePlatform = 'win32',
  shells: DeviceShell[] = [systemShell(device)],
  // The host name of the device, its shells' being this with theirs after it.
  name = 'device',
) {
  if (directory.includes('\n') || directory.includes('"'))
    throw new Error('Unsupported data directory');
  const shared = sharedConnectionPath(directory, platform);
  return {
    knownHosts: `[127.0.0.1]:${port} ${hostPublicKey}\n`,
    config: [
      // The same computer under a name for each of its shells, which takes a script in that shell instead of a
      // command. `ssh` reads % in this option as its own, so the device's variables are written with two.
      ...shells.flatMap((shell) => [
        `Host ${name}-${shell}`,
        `  RemoteCommand ${shellCommand(device, shell).replaceAll('%', '%%')}`,
        '  RequestTTY no',
      ]),
      `Host ${name} ${shells.map((shell) => `${name}-${shell}`).join(' ')}`,
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      `  User ${JSON.stringify(username)}`,
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
  shells: DeviceShell[] = ['pwsh'];
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
    this.shells = shellsOf(platform, credentials.shells);
    const files = sshConfig(
      this.directory,
      this.port,
      credentials.username,
      credentials.hostPublicKey,
      process.platform,
      15,
      platform,
      this.shells,
    );
    const configPath = join(this.directory, 'ssh_config');
    writeFileSync(join(this.directory, 'identity'), credentials.privateKey, { mode: 0o600 });
    writeFileSync(join(this.directory, 'known_hosts'), files.knownHosts, { mode: 0o600 });
    writeFileSync(configPath, files.config, { mode: 0o600 });
    let failure: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (this.controller.signal.aborted) throw new Error('Tunnel closed');
      try {
        await this.probe(configPath, `device-${this.shells[0]}`);
        if (this.controller.signal.aborted) throw new Error('Tunnel closed');
        this.ssh = { configPath };
        this.credentials = credentials;
        return;
      } catch (error) {
        failure = error;
        await delay(300, undefined, { signal: this.controller.signal });
      }
    }
    // The last answer, which the device would give again.
    throw failure instanceof Error ? failure : new Error('Device SSH readiness timed out');
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
  // What the configuration was last written with, for `hosts`.
  private reach?: {
    username: string;
    hostPublicKey: string;
    platform: DevicePlatform;
    shells: DeviceShell[];
  };
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
    this.reach = { username, hostPublicKey, platform: tunnel.platform, shells: tunnel.shells };
    const files = sshConfig(
      this.directory,
      this.port,
      username,
      hostPublicKey,
      process.platform,
      Math.ceil(this.holdMs / 1000) + 15,
      tunnel.platform,
      tunnel.shells,
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
  // The configuration that reaches the device by this door under another host name, for the sessions of the
  // user's other computers; none before it was first ready.
  hosts(name: string) {
    if (!this.reach || this.closed) return undefined;
    const { username, hostPublicKey, platform, shells } = this.reach;
    const files = sshConfig(
      this.directory,
      this.port,
      username,
      hostPublicKey,
      process.platform,
      Math.ceil(this.holdMs / 1000) + 15,
      platform,
      shells,
      name,
    );
    return { config: files.config, shells };
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
