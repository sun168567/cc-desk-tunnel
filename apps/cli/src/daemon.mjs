import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';
import { openProxyBridge } from '../../desktop/electron/proxy-bridge.mjs';
import { newlyWaiting, notify } from './notify.mjs';

// The background service keeps this device's connection, and with it the agents, while no terminal shows them.
// Terminals reach it over a Unix socket only the user can open, and speak the service's own protocol to it.
export const daemonSocket = (env = process.env) =>
  join(env.XDG_RUNTIME_DIR || tmpdir(), 'ccdt.sock');

// Shares one service connection among the terminals connected to the daemon. Each request's frames go back to the
// terminal that sent it, a terminal's output to the one that opened it last, everything else to all. A terminal that
// goes away leaves the agents it showed running.
export class Hub {
  constructor(send) {
    this.send = send;
    this.views = new Set();
    // Request ID → the view that asked, or null for the daemon's own requests.
    this.requests = new Map();
    this.opening = new Map();
    // Terminal ID → { view, sessionId } showing it.
    this.owners = new Map();
    this.ready = null;
    this.sessions = new Map();
  }
  start(ready) {
    this.ready = ready;
    this.sessions = new Map(ready.sessions.map((session) => [session.id, session]));
  }
  // A view starts from `ready` with the sessions as they are now.
  add(view) {
    this.views.add(view);
    view.send(JSON.stringify({ ...this.ready, sessions: [...this.sessions.values()] }));
  }
  fromView(view, text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return view.close();
    }
    // The daemon signed in already.
    if (message?.type === 'auth') return;
    if (typeof message.requestId === 'string') this.requests.set(message.requestId, view);
    if (message.type === 'terminal.open') this.opening.set(message.sessionId, view);
    this.send(text);
  }
  fromService(text, message) {
    if (message.type === 'session.updated') this.sessions.set(message.session.id, message.session);
    if (message.type === 'session.deleted') this.sessions.delete(message.sessionId);
    let targets = this.views;
    if (typeof message.requestId === 'string' && this.requests.has(message.requestId)) {
      const view = this.requests.get(message.requestId);
      if (message.type === 'response') this.requests.delete(message.requestId);
      targets = view ? [view] : [];
    } else if (message.type === 'terminal.opened') {
      const view = this.opening.get(message.sessionId);
      this.opening.delete(message.sessionId);
      if (view) this.owners.set(message.terminalId, { view, sessionId: message.sessionId });
      targets = view ? [view] : [];
    } else if (message.type === 'terminal.data' || message.type === 'terminal.closed') {
      const owner = this.owners.get(message.terminalId);
      if (message.type === 'terminal.closed') this.owners.delete(message.terminalId);
      targets = owner ? [owner.view] : [];
    }
    for (const view of targets) if (this.views.has(view)) view.send(text);
  }
  remove(view) {
    this.views.delete(view);
    for (const [requestId, asker] of this.requests)
      if (asker === view) this.requests.set(requestId, null);
    for (const [sessionId, opener] of this.opening)
      if (opener === view) this.opening.delete(sessionId);
    for (const [terminalId, { view: shower, sessionId }] of this.owners) {
      if (shower !== view) continue;
      this.owners.delete(terminalId);
      const requestId = randomUUID();
      this.requests.set(requestId, null);
      this.send(JSON.stringify({ type: 'terminal.detach', requestId, sessionId, terminalId }));
    }
  }
}

// Runs the daemon until its service connection ends; resolves with the reason. `stop()` on the returned handle
// ends it deliberately, which ends the agents.
export async function startDaemon(
  { url, fingerprint, token, socketPath = daemonSocket(), resolveProxy },
  log = (text) => console.error(text),
) {
  await clearStaleSocket(socketPath);
  const bridge = await openProxyBridge({ url, fingerprint }, { resolveProxy });
  const upstream = new WebSocket(bridge.url);
  const hub = new Hub((text) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
  });
  let failure = null;
  let statuses = new Map();
  const ended = new Promise((resolve) => upstream.once('close', () => resolve(failure)));
  upstream.on('error', (error) => (failure ??= error.message));
  try {
    await new Promise((resolve, reject) => {
      upstream.once('open', () =>
        upstream.send(
          JSON.stringify({
            type: 'auth',
            protocolVersion: PROTOCOL_VERSION,
            token,
            deviceName: 'Linux daemon',
          }),
        ),
      );
      upstream.on('message', (raw) => {
        const text = raw.toString('utf8');
        let message;
        try {
          message = serverMessageSchema.parse(JSON.parse(text));
        } catch {
          failure = '服务协议不兼容。';
          return upstream.close();
        }
        if (message.type === 'connection.error') failure = message.message;
        if (message.type === 'connection.state')
          log(message.state === 'reconnecting' ? '网络中断，正在重连。' : '已重新连接。');
        if (!hub.ready) {
          if (message.type !== 'ready') return;
          if (message.adapter !== 'claude-code') {
            failure = '服务运行在离线模拟模式，没有原生终端。';
            return upstream.close();
          }
          hub.start(message);
          return resolve();
        }
        hub.fromService(text, message);
        // The daemon notifies, so an agent waiting is noticed with no terminal open.
        if (message.type === 'terminals.state') {
          for (const terminal of newlyWaiting(statuses, message.terminals))
            notify(
              `${hub.sessions.get(terminal.sessionId)?.title ?? 'agent'} 等你`,
              '运行 ccdt 进入处理。',
            );
          statuses = new Map(message.terminals.map((terminal) => [terminal.sessionId, terminal]));
        }
      });
      ended.then((reason) => reject(new Error(reason ?? '连接服务失败。')));
    });
  } catch (error) {
    await bridge.close();
    throw error;
  }

  const server = createServer();
  const views = new WebSocketServer({ server });
  views.on('connection', (socket) => {
    const view = {
      send: (text) => socket.readyState === WebSocket.OPEN && socket.send(text),
      close: () => socket.close(),
    };
    hub.add(view);
    socket.on('message', (raw) => hub.fromView(view, raw.toString('utf8')));
    socket.on('close', () => hub.remove(view));
    socket.on('error', () => socket.terminate());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  log(`已连接 ${new URL(url).host}，在 ${socketPath} 等待 ccdt。`);
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      for (const socket of views.clients) socket.terminate();
      await new Promise((resolve) => views.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      await rm(socketPath, { force: true });
      await bridge.close();
    })());
  ended.then(() => stop());
  return { ended, stop, hub };
}

// A socket file left by a daemon that did not end cleanly; one that still answers belongs to a running daemon.
async function clearStaleSocket(path) {
  const alive = await new Promise((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
  if (alive) throw new Error(`ccdt 后台服务已在运行（${path}）。`);
  await rm(path, { force: true });
}

// Whether a daemon answers on the socket.
export const daemonRunning = (path = daemonSocket()) =>
  new Promise((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

const UNIT = 'ccdt.service';
const unitPath = (env = process.env) =>
  join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user', UNIT);
// A value for a unit file: quoted, with systemd's specifier character escaped.
const quote = (text) =>
  `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
// The user unit runs this same ccdt (the packaged Electron in Node mode, or Node with this script) in the
// foreground; systemd restarts it after a failure, such as a keyring still locked at login.
//
// Commands Claude runs on this computer inherit the daemon's environment, and systemd's PATH lacks what the login
// shell adds (~/.local/bin and the like), so the PATH of the shell that installs it is kept. Proxy variables are
// not: they may hold credentials, and the unit file is readable.
export function unitFile({
  execPath = process.execPath,
  script = process.argv[1],
  env = process.env,
} = {}) {
  return [
    '[Unit]',
    'Description=ccdt: CC Desk Tunnel agents in the background',
    'After=network-online.target',
    '',
    '[Service]',
    ...(env.PATH ? [`Environment=${quote(`PATH=${env.PATH}`)}`] : []),
    ...(env.ELECTRON_RUN_AS_NODE ? ['Environment=ELECTRON_RUN_AS_NODE=1'] : []),
    `ExecStart=${quote(execPath)} ${quote(script)} daemon run`,
    'Restart=on-failure',
    'RestartSec=10',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
const systemctl = (...args) => promisify(execFile)('systemctl', ['--user', ...args]);
export async function installDaemon() {
  const path = unitPath();
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, unitFile());
  await systemctl('daemon-reload');
  await systemctl('enable', UNIT);
  // A daemon already running takes the new unit only when started again.
  await systemctl('restart', UNIT);
  return path;
}
export async function uninstallDaemon() {
  await systemctl('disable', '--now', UNIT).catch(() => {});
  await rm(unitPath(), { force: true });
  await systemctl('daemon-reload');
}
export const stopDaemon = () => systemctl('stop', UNIT);
export async function daemonStatus() {
  const { stdout } = await systemctl('is-active', UNIT).catch((error) => error);
  return String(stdout ?? '').trim() || 'inactive';
}
