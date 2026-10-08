import { connect } from 'node:net';
import { WebSocket, createWebSocketStream } from 'ws';
import { RELAY_BEGIN } from '@cc-desk-tunnel/protocol';

const SPARE = 2;
const MAX_BACKOFF_MS = 5000;

// The desktop side of the service's relay: keeps a few signed-in WSS connections waiting, and when the service
// hands one an SSH connection, splices it to the local SSH endpoint and opens a replacement. `openSocket` returns an
// open connection whose certificate has already been checked, so the secret goes nowhere else.
//
// Failed connections are retried with backoff for as long as the tunnel lives: during a network drop the control
// connection is being resumed too, and the tunnel must still be there when it is back. Only a refused secret, which
// means the service no longer knows this tunnel, ends it.
export function startRelay({ connectionId, secret }, port, openSocket, onFailure) {
  const waiting = new Set();
  // Waiting connections let go by `reset`; their close is not a failure.
  const discarded = new WeakSet();
  let opening = 0;
  let closed = false;
  let failures = 0;
  let retryTimer;
  const fail = (message) => {
    if (closed) return;
    close();
    onFailure(message);
  };
  function topUp() {
    if (closed || retryTimer) return;
    while (waiting.size + opening < SPARE) void open();
  }
  function retry() {
    if (closed || retryTimer) return;
    failures++;
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined;
        topUp();
      },
      Math.min(250 * 2 ** failures, MAX_BACKOFF_MS),
    );
  }
  async function open() {
    opening++;
    let socket;
    try {
      socket = await openSocket();
    } catch {
      return retry();
    } finally {
      opening--;
    }
    if (closed) return socket.terminate();
    failures = 0;
    waiting.add(socket);
    let begun = false;
    socket.on('error', () => socket.terminate());
    socket.once('close', (code) => {
      waiting.delete(socket);
      if (begun || closed || discarded.has(socket)) return;
      if (code === 4001) fail('执行通道中继认证失败。');
      else if (code !== 4008) retry();
    });
    socket.once('message', (data, isBinary) => {
      if (isBinary || data.toString('utf8') !== RELAY_BEGIN) return socket.terminate();
      begun = true;
      waiting.delete(socket);
      topUp();
      // The stream takes over the socket's messages from here, in the same tick, so no bytes are missed.
      const stream = createWebSocketStream(socket);
      const local = connect(port, '127.0.0.1');
      stream.on('error', () => local.destroy());
      local.on('error', () => stream.destroy());
      local.once('close', () => stream.destroy());
      stream.pipe(local);
      local.pipe(stream);
    });
    socket.send(JSON.stringify({ type: 'tunnel.attach', connectionId, secret }));
  }
  function close() {
    closed = true;
    clearTimeout(retryTimer);
    for (const socket of waiting) socket.terminate();
    waiting.clear();
  }
  topUp();
  return {
    close,
    // After the control connection came back: the waiting connections most likely went with the old network path
    // (the service lets go of its ends too), so fresh ones are opened at once.
    reset() {
      if (closed) return;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      failures = 0;
      for (const socket of waiting) {
        discarded.add(socket);
        socket.terminate();
      }
      waiting.clear();
      topUp();
    },
  };
}

// Waits for a relay WebSocket to open; rejects if it closes or fails first.
export function opened(socket) {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) return resolve(socket);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('Relay connection closed')));
  });
}
