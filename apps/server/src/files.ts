import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import type { ServerChannel } from 'ssh2';
import { serverAlgorithms } from './ssh2-hardening.ts';
import { FILES_TARGET_ENV } from '@cc-desk-tunnel/protocol';

// The file panel's way to the files of the service and of the user's online computers: SFTP, spoken by the
// client's SSH library and by OpenSSH's own SFTP server, over one more connection to the service. That
// connection carries an SSH connection whose other end is here, inside this process: it only takes the SFTP
// subsystem, and hands each one to an SFTP server of the computer the client named (`FILES_TARGET_ENV`). The
// SFTP protocol is not read here; the connection was signed in like an execution channel, so SSH asks for no
// more (`none`), and the client does not check the key below, which is new each time the service starts.
//
// The service's own SFTP server runs as the service's user. Where the kernel has Landlock it runs confined, so
// that it cannot open the service's secrets (see landlock-run.py and `protectedPaths`); `protected` tells the
// client whether that is so. A computer's SFTP server is reached over its execution channel.
export type FilesOptions = {
  // The SFTP server program and its arguments; by default OpenSSH's, where the system has it; null for none.
  sftpServer?: string[] | null;
  // Whether to confine the service's SFTP server with Landlock where the kernel has it; on unless a test says.
  landlock?: boolean;
  // The directory of the CLI's own configuration and credentials; `~/.claude` unless CLAUDE_CONFIG_DIR says.
  configDir?: string;
};
// `server`: the service's own files can be shown, an SFTP server being installed (an image from before 0.3.17
// has none; other computers' files are reached all the same).
export type FilesState = { server: boolean; protected: boolean; dataDir: string; home: string };

const SYSTEM_SFTP_SERVERS = [
  '/usr/lib/openssh/sftp-server',
  '/usr/libexec/openssh/sftp-server',
  '/usr/libexec/sftp-server',
  '/usr/lib/ssh/sftp-server',
  // Git for Windows' build, where the service runs from source on Windows for development; it names paths
  // the MSYS way (`/c/...`).
  ...(process.platform === 'win32' ? ['C:/Program Files/Git/usr/lib/ssh/sftp-server.exe'] : []),
];
// A path as the SFTP server names it.
export const sftpPath = (path: string) =>
  process.platform === 'win32'
    ? path
        .replace(/^([A-Za-z]):/, (_, drive: string) => '/' + drive.toLowerCase())
        .replaceAll('\\', '/')
    : path;
const LAUNCHER = fileURLToPath(new URL('landlock-run.py', import.meta.url));
// What a client may have open at once over one connection, and how many such connections it may have.
const MAX_SUBSYSTEMS = 16;
// The entries of the data directory the file panel reaches; every other one is the service's own.
const OPEN_IN_DATA = new Set(['native', 'home', 'workspace']);

export class FileService {
  state?: FilesState;
  private dataDir: string;
  private options: FilesOptions;
  private hostKey = ssh2.utils.generateKeyPairSync('ed25519').private;
  private serverConfig = { hostKeys: [this.hostKey], algorithms: serverAlgorithms };
  private sftpServer?: string[];
  private landlock = false;
  // Every SFTP server started for a client, which ends with its connection or with the service.
  private children = new Set<ReturnType<typeof spawn>>();
  constructor(dataDir: string, options: FilesOptions = {}) {
    this.dataDir = resolve(dataDir);
    this.options = options;
  }
  // Finds the SFTP server and whether Landlock can confine it. Without an SFTP server the panel has no files
  // of the service to show, only those of other computers.
  async start() {
    this.sftpServer =
      this.options.sftpServer === null
        ? undefined
        : (this.options.sftpServer ??
          (() => {
            const found = SYSTEM_SFTP_SERVERS.find((path) => existsSync(path));
            return found ? [found] : undefined;
          })());
    this.landlock =
      !!this.sftpServer &&
      process.platform === 'linux' &&
      this.options.landlock !== false &&
      (await new Promise<boolean>((done) =>
        execFile('python3', [LAUNCHER, '--probe'], { timeout: 10_000 }, (error) => done(!error)),
      ));
    this.state = {
      server: !!this.sftpServer,
      protected: this.landlock,
      dataDir: sftpPath(this.dataDir),
      home: sftpPath(homedir()),
    };
  }
  // What the service's SFTP server is kept from: the CLI's credentials and settings (a setup token lives in
  // them), its account file, SSH keys in the home directory, everything of the data directory other than the
  // working directories and the home directory, and /proc, which shows every process's environment.
  protectedPaths() {
    const configDir = this.options.configDir ?? join(homedir(), '.claude');
    let data: string[] = [];
    try {
      data = readdirSync(this.dataDir).filter((name) => !OPEN_IN_DATA.has(name));
    } catch {}
    return [
      join(configDir, '.credentials.json'),
      join(configDir, 'settings.json'),
      join(homedir(), '.claude.json'),
      join(homedir(), '.ssh'),
      ...data.map((name) => join(this.dataDir, name)),
      '/proc',
    ];
  }
  // The command that serves SFTP for the service itself.
  ownServer() {
    if (!this.sftpServer) return undefined;
    return this.landlock
      ? ['python3', LAUNCHER, ...this.protectedPaths(), '--', ...this.sftpServer]
      : this.sftpServer;
  }
  // Serves one client connection. `route` gives the command serving SFTP for a target the client names, or
  // nothing when the target is not there.
  serve(stream: Duplex, route: (target: string) => string[] | undefined) {
    const children = new Set<ReturnType<typeof spawn>>();
    const all = this.children;
    stream.once('close', () => {
      for (const child of children) child.kill();
    });
    const server = new ssh2.Server(this.serverConfig, (client) => {
      client.on('error', () => stream.destroy());
      client.once('close', () => {
        for (const child of children) child.kill();
      });
      client.on('authentication', (context) =>
        context.method === 'none' ? context.accept() : context.reject(['none']),
      );
      client.on('request', (_accept, reject) => reject?.());
      client.on('tcpip', (_accept, reject) => reject());
      client.on('openssh.streamlocal', (_accept, reject) => reject());
      client.on('session', (accept) => {
        const session = accept();
        let target = 'server';
        session.on('env', (acceptEnv, rejectEnv, { key, val }) => {
          if (key !== FILES_TARGET_ENV) return rejectEnv?.();
          target = val;
          acceptEnv?.();
        });
        // Without an `sftp` listener ssh2 offers the subsystem as a plain channel, which goes unchanged to the
        // SFTP server. Shells, commands and the rest are refused for want of listeners.
        session.on('subsystem', (acceptSubsystem, rejectSubsystem, { name }) => {
          const command = name === 'sftp' && children.size < MAX_SUBSYSTEMS && route(target);
          if (!command) return rejectSubsystem?.();
          attach(acceptSubsystem(), command);
        });
      });
      function attach(channel: ServerChannel, [file, ...args]: string[]) {
        const child = spawn(file!, args, {
          stdio: ['pipe', 'pipe', 'ignore'],
          cwd: homedir(),
          // Git's MSYS build finds its runtime library in Git's usr/bin, which only Git's own shell has on its path.
          env:
            process.platform === 'win32'
              ? {
                  ...process.env,
                  PATH:
                    join(dirname(dirname(dirname(file!))), 'bin') + delimiter + process.env.PATH,
                }
              : process.env,
        });
        children.add(child);
        all.add(child);
        channel.on('error', () => child.kill());
        channel.once('close', () => child.kill());
        child.stdin.on('error', () => {});
        channel.pipe(child.stdin);
        child.stdout.pipe(channel);
        child.once('error', () => {
          channel.exit(127);
          channel.end();
        });
        child.once('close', (code) => {
          children.delete(child);
          all.delete(child);
          channel.exit(code ?? 127);
          channel.end();
        });
      }
    });
    server.injectSocket(stream as unknown as import('node:net').Socket);
  }
  close() {
    for (const child of this.children) child.kill();
  }
}
