import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { MAX_FRAME_BYTES, PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';

// A protocol connection through the local bridge: authenticates, waits for `ready`, then offers request/response
// commands and the terminal frames. Resolves with the connection once the service and the tunnel are ready. Through
// the background daemon (`token` null) there is nothing to sign in: the daemon sends `ready` at once.
export function openConnection(url, token, { timeoutMs = 60000 } = {}) {
  const socket = new WebSocket(url, { maxPayload: MAX_FRAME_BYTES });
  const pending = new Map();
  const listeners = new Set();
  const stateListeners = new Set();
  const messageListeners = new Set();
  let ready = null;
  let failure = null;
  let resolveClosed;
  const closed = new Promise((resolve) => (resolveClosed = resolve));
  const connection = {
    get ready() {
      return ready;
    },
    closed,
    request(command) {
      if (socket.readyState !== WebSocket.OPEN)
        return Promise.reject(new Error(failure ?? '连接已断开。'));
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        socket.send(JSON.stringify({ ...command, requestId }));
      });
    },
    control(message) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
    onTerminal(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Every service frame but responses: session and terminal list changes among them.
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    // 'reconnecting' while the bridge takes the service connection back after a network drop, then 'connected'.
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    close() {
      socket.close();
    },
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      failure = '连接服务超时。';
      socket.terminate();
    }, timeoutMs);
    socket.on(
      'open',
      () =>
        token === null ||
        socket.send(
          JSON.stringify({
            type: 'auth',
            protocolVersion: PROTOCOL_VERSION,
            token,
            deviceName: 'Linux terminal',
          }),
        ),
    );
    socket.on('message', (raw) => {
      let message;
      try {
        message = serverMessageSchema.parse(JSON.parse(raw.toString('utf8')));
      } catch {
        failure = '服务协议不兼容。';
        socket.close();
        return;
      }
      if (message.type === 'ready') {
        clearTimeout(timer);
        ready = message;
        resolve(connection);
      } else if (message.type === 'connection.error') {
        failure =
          message.code === 'version_mismatch'
            ? `服务端（${message.service ?? '未知版本'}）与本客户端协议不一致，请一起升级。`
            : message.message;
      } else if (message.type === 'response') {
        const request = pending.get(message.requestId);
        if (!request) return;
        pending.delete(message.requestId);
        if (message.ok) request.resolve(message);
        else request.reject(new Error(message.message ?? message.code ?? '请求失败。'));
        return;
      }
      for (const listener of messageListeners) listener(message);
      if (message.type === 'connection.state') {
        for (const listener of stateListeners) listener(message.state);
      } else if (message.type.startsWith('terminal.')) {
        for (const listener of listeners) listener(message);
      }
    });
    socket.on('error', (error) => {
      failure ??= error.message;
    });
    socket.on('close', () => {
      clearTimeout(timer);
      const error = new Error(failure ?? '连接已断开。');
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      if (!ready) reject(error);
      resolveClosed(failure);
    });
  });
}
