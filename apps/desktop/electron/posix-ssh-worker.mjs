import { timingSafeEqual } from 'node:crypto';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { createServer } from 'node:net';
import { constants } from 'node:fs';
import ssh2 from 'ssh2';
import { ProcessSupervisor } from './process-supervisor.mjs';
import { captureShellEnvironment } from './shell-environment.mjs';
import { connectionKeys } from './ssh-keys.mjs';
import { repairChannelOutput } from './ssh-channel-output.mjs';

const { Server, utils } = ssh2;

const supervisor = new ProcessSupervisor();
const controller = new AbortController();
const sockets = new Map();
let server;
let listener;
let closing;
let active = 0;

async function close() {
  if (closing) return closing;
  closing = (async () => {
    controller.abort();
    for (const socket of sockets.values()) socket.destroy();
    const stopped = listener
      ? new Promise((resolve) => listener.close(resolve))
      : Promise.resolve();
    await supervisor.close();
    await stopped;
  })();
  return closing;
}

async function shutdown() {
  await close();
  if (process.connected) process.disconnect();
}
process.once('disconnect', shutdown);
for (const name of ['SIGTERM', 'SIGINT']) process.once(name, shutdown);
process.on('message', (message) => {
  if (message.type === 'close') void shutdown();
  if (message.type === 'start')
    void start(message).catch(async (error) => {
      if (process.connected) process.send({ type: 'failed', message: error.message });
      await shutdown();
    });
});

// Where the systems keep the SFTP server that comes with their OpenSSH: macOS, Debian and Ubuntu, Fedora, Arch.
const SFTP_SERVERS = [
  '/usr/libexec/sftp-server',
  '/usr/lib/openssh/sftp-server',
  '/usr/libexec/openssh/sftp-server',
  '/usr/lib/ssh/sftp-server',
];
async function systemSftp(given) {
  for (const path of given ? [given] : SFTP_SERVERS)
    if (
      await access(path, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return path;
  throw new Error(
    '找不到系统的 sftp-server。\nmacOS 自带它；Linux 上请安装 OpenSSH 的 SFTP 服务端（Debian / Ubuntu 的 openssh-sftp-server）。',
  );
}

async function start({
  connectionId,
  shell,
  timeoutMs,
  sftpPath: givenSftp,
  env,
  environment: given,
  cwd,
  keepaliveInterval,
}) {
  const directory = cwd ?? homedir();
  const sftpPath = await systemSftp(givenSftp);
  const environment = {
    ...(await captureShellEnvironment(shell, supervisor, {
      signal: controller.signal,
      timeoutMs,
      env,
      cwd: directory,
    })),
    ...given,
    // The service has Claude run scripts by this variable, as it does by CC_DESK_TUNNEL_PWSH on Windows.
    CC_DESK_TUNNEL_SHELL: shell,
  };
  if (controller.signal.aborted) throw new Error('Tunnel cancelled');
  const keys = await connectionKeys(supervisor, controller.signal);
  const allowed = utils.parseKey(keys.loginPublic);
  const publicBytes = allowed.getPublicSSH();
  const username = 'device';
  server = new Server({
    hostKeys: [keys.hostPrivate],
    ident: 'CCDeskTunnel',
    keepaliveInterval: keepaliveInterval ?? 10000,
    keepaliveCountMax: 2,
  });
  listener = createServer((socket) => {
    if (closing || sockets.size >= 128) return socket.destroy();
    const key = `${socket.remoteAddress}:${socket.remotePort}`;
    sockets.set(key, socket);
    // Track a socket even before it sends an SSH header. Otherwise an idle TCP
    // connection could indefinitely prevent the listener's shutdown callback.
    socket.setTimeout(10000, () => socket.destroy());
    socket.once('close', () => sockets.delete(key));
    socket.on('error', () => {});
    server.injectSocket(socket);
  });
  server.on('connection', (client, info) => {
    const socket = sockets.get(`${info.ip}:${info.port}`);
    if (!socket) return client.end();
    socket.setTimeout(0);
    if (closing) return socket.destroy();
    const children = new Set();
    let attempts = 0;
    const authTimer = setTimeout(() => socket.destroy(), 10000);
    const cleanup = () => {
      clearTimeout(authTimer);
      for (const child of children) void child.stopGroup();
    };
    client.on('error', () => {
      cleanup();
      socket.destroy();
    });
    client.once('close', cleanup);
    client.on('authentication', (context) => {
      if (++attempts > 8) return socket.destroy();
      if (
        context.username !== username ||
        context.method !== 'publickey' ||
        context.key.algo !== allowed.type ||
        context.key.data.length !== publicBytes.length ||
        !timingSafeEqual(context.key.data, publicBytes) ||
        (context.signature &&
          allowed.verify(context.blob, context.signature, context.hashAlgo) !== true)
      )
        return context.reject(['publickey']);
      // ssh2 only treats a signed request as successful authentication. An unsigned
      // accepted probe sends PK_OK and still requires proof of the private key.
      context.accept();
    });
    client.once('ready', () => clearTimeout(authTimer));
    client.on('request', (_accept, reject) => reject?.());
    client.on('tcpip', (_accept, reject) => reject());
    client.on('openssh.streamlocal', (_accept, reject) => reject());
    client.on('session', (accept, reject) => {
      if (closing || active >= 128 || children.size >= 32) return reject();
      const session = accept();
      session.on('exec', (acceptCommand, _rejectCommand, { command }) => {
        const args =
          basename(shell) === 'bash'
            ? ['--noprofile', '--norc', '-c', command]
            : ['-f', '-c', command];
        attach(acceptCommand(), shell, args);
      });
      // Intentionally omit ssh2's `sftp` event: `subsystem` then provides a raw SSH
      // channel, which can stream unchanged into the operating system's SFTP server.
      session.on('subsystem', (acceptSubsystem, rejectSubsystem, { name }) => {
        if (name !== 'sftp') return rejectSubsystem?.();
        attach(acceptSubsystem(), sftpPath, []);
      });
      // ssh2 rejects shell, PTY, env, X11 and agent requests without listeners.
      function attach(channel, file, args) {
        if (!channel) return;
        if (closing || active >= 128 || children.size >= 32) return channel.destroy();
        repairChannelOutput(channel);
        const child = supervisor.spawn(file, args, {
          cwd: directory,
          env: environment,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        children.add(child);
        active++;
        channel.on('error', () => void child.stopGroup());
        channel.stderr.on('error', () => void child.stopGroup());
        channel.once('close', () => void child.stopGroup());
        child.stdin.on('error', () => {});
        channel.pipe(child.stdin);
        child.stdout.pipe(channel, { end: false });
        child.stderr.pipe(channel.stderr, { end: false });
        child.once('error', () => {
          channel.exit(127);
          channel.end();
        });
        child.once('close', (code, signal) => {
          children.delete(child);
          active--;
          // stderr and stdout may be backpressured independently. Finish stderr
          // first, then send exit and finish stdout only after queued stderr drains.
          channel.stderr.end(() => {
            if (signal) channel.exit(signal.replace(/^SIG/, ''), false, '');
            else channel.exit(code ?? 127);
            channel.end();
          });
        });
      }
    });
  });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  listener.on('error', () => {
    if (process.connected) process.send({ type: 'failed', message: '本机 SSH 执行服务已停止。' });
    void shutdown();
  });
  if (controller.signal.aborted) throw new Error('Tunnel cancelled');
  process.send({
    type: 'ready',
    port: listener.address().port,
    credentials: {
      type: 'tunnel.credentials',
      connectionId,
      username,
      privateKey: keys.loginPrivate,
      hostPublicKey: keys.hostPublic.trim().split(' ').slice(0, 2).join(' '),
      // The user's own shell, zsh or bash (see `resolvePosixShell`).
      shells: [basename(shell)],
    },
  });
}
