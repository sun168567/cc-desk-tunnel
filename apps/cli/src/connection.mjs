import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
// The desktop client's connection: the same certificate checks, execution channel and SSH server for Claude's
// commands. It relays a local WebSocket to the service, as it does for the desktop page.
import { openProxyBridge } from '../../desktop/electron/proxy-bridge.mjs';
import { components } from './runtime.mjs';

// The proxy for an address, as the desktop client gets it from the system, from the usual variables here. Only
// HTTP CONNECT proxies are used; loopback and `no_proxy` addresses connect directly.
export function proxyFor(url, env = process.env) {
  const { hostname: host } = new URL(url);
  const bypass = (env.no_proxy ?? env.NO_PROXY ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/^\*?\./, ''))
    .filter(Boolean);
  if (
    ['localhost', '127.0.0.1', '[::1]'].includes(host) ||
    bypass.some((entry) => entry === '*' || host === entry || host.endsWith(`.${entry}`))
  )
    return 'DIRECT';
  const proxy = env.https_proxy ?? env.HTTPS_PROXY ?? env.all_proxy ?? env.ALL_PROXY;
  if (!proxy) return 'DIRECT';
  try {
    const address = new URL(proxy);
    return address.protocol === 'http:'
      ? `PROXY ${address.hostname}:${address.port || 80}`
      : 'DIRECT';
  } catch {
    return 'DIRECT';
  }
}

// One signed-in connection to the service, as this computer. `closed` resolves when it ends, whichever side ended
// it; `lost` tells a fault on the way from an end asked for.
export class Service extends EventEmitter {
  static async connect({ url, fingerprint, token, deviceId, waits, log = () => {} }) {
    const service = new Service();
    service.bridge = await openProxyBridge(
      { url, fingerprint, waits },
      {
        ...components(),
        environment: {},
        log,
        resolveProxy: async (target) => proxyFor(target),
      },
      () => service.end(true),
    );
    await service.open(token, deviceId);
    return service;
  }
  constructor() {
    super();
    this.sessions = new Map();
    this.devices = [];
    this.waiting = new Map();
    this.ended = false;
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve));
  }
  open(token, deviceId) {
    this.deviceId = deviceId;
    const socket = (this.socket = new WebSocket(this.bridge.url));
    return new Promise((resolve, reject) => {
      socket.once('open', () => {
        socket.send(
          JSON.stringify({
            type: 'auth',
            protocolVersion: PROTOCOL_VERSION,
            token,
            deviceName: hostname(),
          }),
        );
        socket.send(JSON.stringify({ type: 'device', id: deviceId }));
      });
      socket.on('message', (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString('utf8'));
        } catch {
          return;
        }
        if (message.type === 'ready') {
          for (const session of message.sessions) this.sessions.set(session.id, session);
          this.connectionId = message.connectionId;
          this.version = message.version;
          this.update = message.update;
          resolve();
        } else if (message.type === 'connection.error') {
          this.error = message;
          reject(
            Object.assign(new Error(message.message), {
              code: message.code,
              service: message.service,
            }),
          );
        } else if (message.type === 'session.updated')
          this.sessions.set(message.session.id, message.session);
        else if (message.type === 'session.deleted') this.sessions.delete(message.sessionId);
        else if (message.type === 'devices') this.devices = message.devices;
        else if (message.type === 'service.update') {
          const { type: _type, ...update } = message;
          this.update = update;
        }
        const waiting = message.requestId && this.waiting.get(message.requestId);
        if (waiting) {
          this.waiting.delete(message.requestId);
          if (message.type === 'response' && !message.ok)
            waiting.reject(Object.assign(new Error(message.message), { code: message.code }));
          else waiting.resolve(message);
        }
        this.emit('message', message);
      });
      socket.on('close', () => {
        reject(new Error(this.error?.message ?? '连接已关闭。'));
        this.end(true);
      });
      socket.on('error', () => {});
    });
  }
  // What the service answers to a command: its `response`, or the message it answers with instead.
  request(command) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      if (this.ended) return reject(new Error('连接已关闭。'));
      this.waiting.set(requestId, { resolve, reject });
      this.socket.send(JSON.stringify({ ...command, requestId }));
    });
  }
  send(message) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  // This computer's execution channel is up: Claude's commands can reach it.
  async channel(timeoutMs = 60000) {
    const ready = () => this.devices.some((device) => device.id === this.deviceId && device.ready);
    if (ready()) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('message', check);
        reject(new Error('本机的执行通道没有就绪。'));
      }, timeoutMs);
      const check = () => {
        if (!ready() && !this.ended) return;
        clearTimeout(timer);
        this.off('message', check);
        if (this.ended) reject(new Error('连接已关闭。'));
        else resolve();
      };
      this.on('message', check);
    });
  }
  // ccdt never tells the service it is leaving (`leave`). When ccdt is this computer's last connection, a leave ends
  // all the service keeps of this computer's while it is away, such as a desktop run waiting for the desktop client
  // to reconnect, or the terminal of another ccdt window that lost its connection. The terminal ccdt shows is ended
  // by asking for it (`terminal.close`); anything else is kept for the usual while, as after a fault on the way.
  end(lost) {
    if (this.ended) return;
    this.ended = true;
    this.lost = lost;
    for (const { reject } of this.waiting.values()) reject(new Error('连接已关闭。'));
    this.waiting.clear();
    this.socket?.terminate();
    void Promise.resolve(this.bridge?.close(true)).finally(() => this.resolveClosed());
    this.emit('end', lost);
  }
  async close() {
    if (!this.ended && this.socket?.readyState === WebSocket.OPEN) {
      const socket = this.socket;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        socket.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.close();
      });
    }
    this.end(false);
    await this.closed;
  }
}
