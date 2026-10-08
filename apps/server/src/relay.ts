import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { WebSocket, createWebSocketStream } from 'ws';
import { RELAY_BEGIN } from '@cc-desk-tunnel/protocol';
import { WindowsTunnel } from './tunnel.ts';
import type { TunnelOffer } from './tunnel.ts';

// Relay connections the desktop may keep waiting; it keeps a couple so a command needs no new TLS handshake.
const MAX_IDLE = 4;
// An SSH connection that finds no relay connection in this time is dropped, and ssh reports a failed command. It is
// as long as ssh's own ConnectTimeout, so a command issued while the desktop reconnects waits for it.
const WAIT_MS = 30000;

// Reaches the desktop's SSH endpoint without frp: ssh connects to a loopback port here, and each of its TCP
// connections is spliced to one WSS connection the desktop opened to this service and signed in with the
// per-connection secret. Only the control port is used. SSH configuration, probe and cleanup are the frp tunnel's.
export class RelayTunnel extends WindowsTunnel {
  secret = randomBytes(32).toString('base64url');
  private listener?: Server;
  private idle: WebSocket[] = [];
  private waiting: { socket: Socket; timer: ReturnType<typeof setTimeout> }[] = [];
  private active = new Map<Socket, WebSocket>();

  override async start(): Promise<TunnelOffer> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const listener = createServer((socket) => this.connect(socket));
    this.listener = listener;
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        listener.off('error', reject);
        resolve();
      });
    });
    listener.on('error', () => this.unexpectedClose());
    if (this.controller.signal.aborted) throw new Error('Tunnel closed');
    this.remotePort = (listener.address() as AddressInfo).port;
    return { type: 'tunnel.relay', connectionId: this.id, secret: this.secret };
  }
  matches(secret: string) {
    const given = Buffer.from(secret);
    const expected = Buffer.from(this.secret);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
  // Takes a signed-in relay connection; false when no more are wanted.
  attach(socket: WebSocket) {
    if (this.controller.signal.aborted || this.idle.length >= MAX_IDLE) return false;
    this.idle.push(socket);
    socket.once('close', () => {
      this.idle = this.idle.filter((candidate) => candidate !== socket);
    });
    this.drain();
    return true;
  }
  private connect(socket: Socket) {
    socket.pause();
    socket.on('error', () => socket.destroy());
    const entry = { socket, timer: setTimeout(() => socket.destroy(), WAIT_MS) };
    this.waiting.push(entry);
    socket.once('close', () => {
      clearTimeout(entry.timer);
      this.waiting = this.waiting.filter((candidate) => candidate !== entry);
    });
    this.drain();
  }
  private drain() {
    while (this.idle.length && this.waiting.length) {
      const relay = this.idle.shift()!;
      if (relay.readyState !== WebSocket.OPEN) continue;
      const { socket, timer } = this.waiting.shift()!;
      clearTimeout(timer);
      this.splice(relay, socket);
    }
  }
  // Ends propagate both ways, so a finished command closes its relay connection cleanly; errors cut both.
  private splice(relay: WebSocket, socket: Socket) {
    relay.send(RELAY_BEGIN);
    const stream = createWebSocketStream(relay);
    this.active.set(socket, relay);
    stream.on('error', () => socket.destroy());
    socket.on('error', () => stream.destroy());
    socket.once('close', () => {
      this.active.delete(socket);
      stream.destroy();
    });
    socket.pipe(stream);
    stream.pipe(socket);
    socket.resume();
  }
  // When the control connection dropped or came back. Waiting relay connections most likely went with the old
  // network path, so they are let go and the desktop opens new ones; a busy one that no longer answers is cut, which
  // ends its ssh connection instead of leaving the command hanging until the heartbeat notices.
  recheck() {
    for (const relay of this.idle) relay.terminate();
    this.idle = [];
    for (const relay of this.active.values()) {
      if (relay.readyState !== WebSocket.OPEN) continue;
      let answered = false;
      relay.once('pong', () => (answered = true));
      relay.ping();
      setTimeout(() => answered || relay.terminate(), 5000).unref();
    }
  }
  override close() {
    if (!this.closePromise) {
      this.listener?.close();
      for (const relay of this.idle) relay.close();
      this.idle = [];
      for (const { socket } of this.waiting) socket.destroy();
      for (const socket of this.active.keys()) socket.destroy();
    }
    return super.close();
  }
}
