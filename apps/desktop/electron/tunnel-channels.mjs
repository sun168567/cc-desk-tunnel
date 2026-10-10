import { connect } from 'node:net';
import { createWebSocketStream } from 'ws';
import { TUNNEL_CLOSE } from '@cc-desk-tunnel/protocol';

// The device's side of the execution channel. For each SSH connection the service announces, one connection
// is opened to the service, signed in with the tunnel's secret and joined byte for byte to the local SSH
// service on `port`. Nothing is kept open in between: a channel lives exactly as long as its SSH connection.
//
// `dial` resolves to an open WebSocket to the service whose certificate has already been judged, so the
// secret goes nowhere else; an error it marks `fatal` (the certificate is not the service's) ends the whole
// connection through `onFailure`. Any other failure to connect is tried again for `retryMs`, which is as long
// as the service keeps the SSH connection waiting: the service allows an address only a few connections that
// have not signed in yet, and several commands starting together may briefly exceed that.
//
// A path that stops delivering leaves a channel looking open from here for good, and the SSH session behind
// it running. Each channel is therefore asked for a sign of life every `heartbeatMs` and given up after two
// in a row without an answer, as the control connection is by the service.
export function openChannels(
  { connectionId, secret },
  port,
  dial,
  onFailure,
  retryMs = 10000,
  heartbeatMs = 15000,
) {
  const open = new Set();
  let closed = false;
  const state = { lastError: undefined };
  function fail(message) {
    if (closed) return;
    close();
    onFailure(message);
  }
  async function connectChannel() {
    for (let attempt = 0, started = Date.now(); ; attempt++) {
      try {
        return await dial();
      } catch (error) {
        state.lastError = error;
        if (error?.fatal || closed || Date.now() - started > retryMs) throw error;
        // Spread out, so that channels refused together do not all come back together.
        const wait = Math.min(100 * 2 ** attempt, 1000) * (0.5 + Math.random());
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  async function attach(channelId) {
    if (closed) return;
    let channel;
    try {
      channel = await connectChannel();
    } catch (error) {
      if (error?.fatal) fail(error.message);
      return;
    }
    if (closed) {
      channel.terminate();
      return;
    }
    state.lastError = undefined;
    channel.send(JSON.stringify({ type: 'tunnel.attach', connectionId, channelId, secret }));
    // The stream takes over the connection's frames from here, in the same tick, so no bytes are missed.
    const stream = createWebSocketStream(channel);
    const local = connect(port, '127.0.0.1');
    const entry = { channel, local };
    open.add(entry);
    let unanswered = 0;
    channel.on('pong', () => (unanswered = 0));
    const heartbeat = setInterval(() => {
      if (unanswered >= 2) return channel.terminate();
      unanswered++;
      channel.ping();
    }, heartbeatMs);
    channel.once('close', (code) => {
      clearInterval(heartbeat);
      open.delete(entry);
      if (code === TUNNEL_CLOSE.refused)
        fail('执行通道的认证没有通过。\n请重新连接；反复出现时确认服务地址没有指向另一套部署。');
    });
    stream.on('error', () => local.destroy());
    local.on('error', () => stream.destroy());
    local.once('close', () => stream.destroy());
    stream.pipe(local);
    local.pipe(stream);
  }
  function close() {
    closed = true;
    for (const { channel, local } of open) {
      local.destroy();
      channel.terminate();
    }
    open.clear();
  }
  return {
    // The service has an SSH connection waiting under this name.
    open: (channelId) => void attach(channelId),
    close,
    // Why the last channel could not be opened, while none has been since; explains a channel that never got ready.
    get lastError() {
      return state.lastError;
    },
    get size() {
      return open.size;
    },
  };
}
