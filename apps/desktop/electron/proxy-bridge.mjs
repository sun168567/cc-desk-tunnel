import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { createServer, request } from 'node:http';
import { isIP } from 'node:net';
import { connect } from 'node:tls';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { serverMessageSchema, MAX_FRAME_BYTES, ResumeLog } from '@cc-desk-tunnel/protocol';
import { startLinuxTunnel } from './linux-tunnel.mjs';
import { opened } from './relay.mjs';
import { startWindowsTunnel } from './windows-tunnel.mjs';
import { httpProxy, openSocket } from './system-proxy.mjs';

export function certificateMatches(observed, trusted) {
  if (typeof trusted !== 'string' || typeof observed !== 'string') return false;
  const pin = trusted.replaceAll(':', '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(pin) && observed.replaceAll(':', '').toLowerCase() === pin;
}
export function controlTlsOptions(config) {
  if (!config.fingerprint) return { rejectUnauthorized: true };
  if (!certificateMatches(config.fingerprint, config.fingerprint))
    throw new Error('请输入可信安装信息中的 SHA256 证书指纹，或留空使用 CA 验证。');
  return { rejectUnauthorized: false };
}
// Starts TLS with the service, through the system's HTTP proxy when the Windows settings name one for it. The proxy
// only relays bytes: the certificate is still the service's own and is judged as on a direct connection.
async function connectService(address, config, resolveProxy) {
  const port = Number(address.port || 443);
  const proxy = httpProxy(await resolveProxy?.(`https://${address.hostname}:${port}`));
  return connect({
    socket: await openSocket(proxy, address.hostname, port),
    servername: isIP(address.hostname) ? undefined : address.hostname,
    ...controlTlsOptions(config),
  });
}
// An HTTPS GET carrying the service token. A pinned certificate is checked once the connection stands and before
// the request, and with it the token, is written to it.
export async function authorizedGet(address, config, path, token, resolveProxy) {
  const socket = await connectService(address, config, resolveProxy);
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', () => {
      if (
        config.fingerprint &&
        !certificateMatches(socket.getPeerCertificate().fingerprint256, config.fingerprint)
      ) {
        socket.destroy();
        reject(new Error('服务证书指纹不匹配；未发送服务凭据。'));
      } else resolve();
    });
    socket.once('error', reject);
  });
  return new Promise((resolve, reject) => {
    const download = request(
      {
        host: address.hostname,
        path,
        createConnection: () => socket,
        headers: { Host: address.host, Authorization: `Bearer ${token}` },
      },
      resolve,
    );
    download.on('error', reject);
    download.end();
  });
}
export async function openProxyBridge(
  config,
  binaries,
  onClosed = () => {},
  allowedOrigins = ['null', 'file://', undefined],
) {
  const address = new URL(config.url);
  if (
    address.protocol !== 'wss:' ||
    address.username ||
    address.password ||
    address.search ||
    address.hash
  )
    throw new Error('原生模式需要不含凭据的 WSS 地址。');
  // A malformed pin is refused here, before anything listens or connects.
  controlTlsOptions(config);
  const nonce = randomBytes(32).toString('hex');
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  let pair;
  // Kept for the installer download, which uses the same secret and certificate check as the connection.
  let token = '';
  let release;
  let closed = false;
  let closing;
  server.on('upgrade', (request, socket, head) => {
    if (
      closed ||
      pair ||
      request.url !== `/bridge/${nonce}` ||
      !allowedOrigins.includes(request.headers.origin)
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });
  // A WebSocket to the service. CA verification completes at TLS handshake; explicit pins are checked by the caller
  // once it is open, before anything is sent.
  const serviceSocket = (options) =>
    new WebSocket(address, {
      ...options,
      // Node's HTTP client also takes the connection through this callback once it is ready.
      createConnection: (_options, created) => {
        connectService(address, config, binaries.resolveProxy).then(
          (socket) => created(null, socket),
          created,
        );
      },
    });
  const pinned = (socket) =>
    !config.fingerprint ||
    certificateMatches(socket._socket.getPeerCertificate().fingerprint256, config.fingerprint);
  // A relay connection for the Linux tunnel, open and with a verified certificate.
  async function openRelay() {
    const socket = await opened(serviceSocket({ maxPayload: MAX_FRAME_BYTES }));
    if (pinned(socket)) return socket;
    socket.terminate();
    throw new Error('服务证书指纹不匹配；未发送服务凭据。');
  }
  // Linux reaches its SSH endpoint over the service's WSS relay; Windows keeps frp. Only the relay can wait for its
  // desktop, so only Linux keeps its connection through a network drop: the bridge reconnects by itself and the
  // service hands back the runs, terminal and tunnel, replaying the frames each side missed. The client of the
  // bridge sees a pause and a `connection.state` notice, not a new connection.
  const relay = process.platform === 'linux';
  const failure = (error) =>
    error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
      ? '会话历史超过 WebSocket 接收上限。'
      : /\b429\b/.test(error.message)
        ? '登录失败次数过多，服务端已暂时拒绝本机，请稍后再试。'
        : '代理连接失败，请检查服务地址和网络。';
  wss.on('connection', (local) => {
    pair = {
      local,
      remote: null,
      controller: new AbortController(),
      tunnel: null,
      preparing: null,
    };
    const current = pair;
    const queue = [];
    let verified = false;
    let nativeReady;
    let configurationReceived = false;
    // Resumption: the sign-in to repeat, what the service granted, and the frame log. Frames sent after `auth` are
    // kept until acknowledged; service frames after `ready` are counted.
    let auth;
    let granted = null;
    let log = null;
    let counting = false;
    let reconnecting = false;
    const timer = setTimeout(() => fail('本机 SSH 连接准备超时。'), 45000);
    function fail(message) {
      if (local.readyState === WebSocket.OPEN)
        local.send(JSON.stringify({ type: 'connection.error', code: 'tunnel_failed', message }));
      clearTimeout(timer);
      void close(true);
    }
    const toLocal = (message) => {
      if (local.readyState === WebSocket.OPEN) local.send(JSON.stringify(message));
    };
    const live = () => verified && current.remote.readyState === WebSocket.OPEN;
    // A frame for the service. While reconnecting it is only kept, and goes out with the replay.
    function forward(text, keep = true) {
      if (keep) log?.record(text);
      if (reconnecting) return;
      if (live()) current.remote.send(text);
      else queue.push(text);
    }
    local.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString('utf8'));
        if (message.type?.startsWith('tunnel.')) throw new Error('Renderer tunnel message');
        if (message.type === 'auth') {
          message.tunnel = true;
          message.tunnelTransport = relay ? 'relay' : 'frp';
          message.resumable = relay;
          message.deviceName = process.platform === 'linux' ? 'Linux desktop' : 'Windows desktop';
          token = String(message.token);
          auth = message;
          if (relay)
            log = new ResumeLog((received) => {
              if (live()) current.remote.send(JSON.stringify({ type: 'resume.ack', received }));
            });
          forward(JSON.stringify(message), false);
          return;
        }
        forward(JSON.stringify(message));
      } catch {
        fail('客户端消息格式错误。');
      }
    });
    function receive(raw) {
      let message;
      try {
        message = serverMessageSchema.parse(JSON.parse(raw.toString('utf8')));
      } catch {
        fail('服务协议不兼容。');
        return;
      }
      if (message.type === 'resume.ack') {
        log?.confirm(message.received);
        return;
      }
      if (counting) log?.receive();
      // A service of another version refuses the connection but may still offer the installer for its own.
      if (message.type === 'connection.error' && message.client) release = message.client;
      if (message.type === 'ready') {
        counting = true;
        if (message.resume) granted = { ...message.resume, connectionId: message.connectionId };
        // A service that does not resume needs no log.
        else log = null;
        delete message.resume;
        raw = JSON.stringify(message);
      }
      if (message.type === (relay ? 'tunnel.relay' : 'tunnel.configure')) {
        if (
          configurationReceived ||
          !nativeReady ||
          nativeReady.connectionId !== message.connectionId
        ) {
          fail('隧道连接标识不匹配。');
          return;
        }
        configurationReceived = true;
        current.preparing = (relay ? startLinuxTunnel : startWindowsTunnel)(
          message,
          relay ? { schedulesPath: binaries.schedulesPath, openRelay } : binaries,
          current.controller.signal,
          fail,
        )
          .then((tunnel) => {
            current.tunnel = tunnel;
            if (!closed) forward(JSON.stringify(tunnel.credentials));
          })
          .catch((error) => fail(error.message));
      } else if (message.type === 'tunnel.configure' || message.type === 'tunnel.relay') {
        // The other transport's offer, which this platform did not ask for; it never reaches the renderer.
        fail('隧道方式不匹配。');
      } else if (message.type === 'ready' && message.adapter === 'claude-code') {
        nativeReady = message;
        release = message.client;
      } else if (message.type === 'tunnel.ready') {
        if (!configurationReceived || message.connectionId !== nativeReady?.connectionId) {
          fail('隧道就绪标识不匹配。');
          return;
        }
        clearTimeout(timer);
        toLocal(nativeReady);
      } else if (local.readyState === WebSocket.OPEN) {
        if (message.type === 'ready') clearTimeout(timer);
        local.send(raw.toString('utf8'));
      }
    }
    // Takes a service connection into use. A resumable one is watched: one silent for 35 s is cut, which starts
    // a reconnect (the service pings every 15 s).
    function use(remote) {
      current.remote = remote;
      remote.on('message', (raw) => {
        if (remote === current.remote) receive(raw);
      });
      remote.on('close', (code) => {
        if (remote !== current.remote || closed) return;
        // The service's own refusals (4xxx) and a deliberate close end the connection; anything else is the network.
        if (granted && code < 4000 && code !== 1000) void reconnect();
        else {
          clearTimeout(timer);
          void close(true);
        }
      });
      remote.on('error', (error) => {
        if (!granted) fail(failure(error));
      });
      if (!relay) return;
      let seen = Date.now();
      const alive = () => (seen = Date.now());
      for (const event of ['message', 'ping', 'pong']) remote.on(event, alive);
      const heartbeat = setInterval(() => {
        if (Date.now() - seen > 35000) remote.terminate();
        else if (remote.readyState === WebSocket.OPEN) remote.ping();
      }, 10000);
      remote.once('close', () => clearInterval(heartbeat));
    }
    const first = serviceSocket();
    use(first);
    first.on('open', () => {
      if (!pinned(first)) {
        fail('服务证书指纹不匹配；未发送服务凭据。');
        return;
      }
      verified = true;
      for (const message of queue) first.send(message);
      queue.length = 0;
    });
    async function reconnect() {
      reconnecting = true;
      verified = false;
      toLocal({ type: 'connection.state', state: 'reconnecting' });
      const deadline = Date.now() + granted.graceMs;
      for (let attempt = 0; !closed; attempt++) {
        if (attempt)
          await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 5000)));
        if (closed) return;
        if (Date.now() > deadline) {
          fail(
            `网络中断超过 ${Math.round(granted.graceMs / 60000)} 分钟，原来的运行已结束，请重新连接。`,
          );
          return;
        }
        if (await resume()) return;
      }
    }
    // One attempt to take the connection back; true when it is back or given up for good.
    function resume() {
      return new Promise((resolve) => {
        const remote = serviceSocket();
        let settled = false;
        const done = (final) => {
          if (settled) return;
          settled = true;
          clearTimeout(limit);
          resolve(final);
        };
        const refuse = (message) => {
          remote.terminate();
          fail(message);
          done(true);
        };
        const limit = setTimeout(() => {
          remote.terminate();
          done(false);
        }, 15000);
        remote.on('error', () => {});
        remote.once('close', () => done(false));
        remote.once('open', () => {
          if (closed) {
            remote.terminate();
            return done(true);
          }
          if (!pinned(remote)) return refuse('服务证书指纹不匹配；未发送服务凭据。');
          const { connectionId, key } = granted;
          remote.send(
            JSON.stringify({ ...auth, resume: { connectionId, key, received: log.received } }),
          );
        });
        remote.once('message', (raw) => {
          let message;
          try {
            message = serverMessageSchema.parse(JSON.parse(raw.toString('utf8')));
          } catch {
            return refuse('服务协议不兼容。');
          }
          if (message.type !== 'resumed')
            return refuse(
              message.type === 'connection.error' ? message.message : '服务协议不兼容。',
            );
          const frames = log.since(message.received);
          if (!frames) return refuse('续接失败：本机消息记录不完整，请重新连接。');
          if (closed) {
            remote.terminate();
            return done(true);
          }
          log.confirm(message.received);
          reconnecting = false;
          verified = true;
          use(remote);
          for (const frame of frames) remote.send(frame);
          current.tunnel?.reset?.();
          toLocal({ type: 'connection.state', state: 'connected' });
          done(true);
        });
      });
    }
    local.on('close', () => {
      clearTimeout(timer);
      log?.stop();
      void close(true);
    });
    local.on('error', (error) => fail(failure(error)));
  });
  async function close(notify = false) {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      pair?.controller.abort();
      pair?.local.close();
      // A deliberate close tells the service not to keep the connection for a return.
      const remote = pair?.remote;
      if (remote?.readyState === WebSocket.OPEN) {
        remote.close(1000);
        setTimeout(() => remote.terminate(), 1000).unref();
      } else remote?.terminate();
      await pair?.preparing;
      await pair?.tunnel?.close();
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      if (notify) onClosed();
    })();
    return closing;
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  // Fetches the installer the service announced and accepts it only if its hash matches. Works after the
  // connection closed, as it does when the service refused this client's version.
  async function downloadInstaller(directory) {
    if (!release || !token) throw new Error('服务端没有提供客户端安装包。');
    const expected = release;
    const target = join(directory, `CC-Desk-Tunnel-Setup-${expected.version}-x64.exe`);
    const response = await authorizedGet(
      address,
      config,
      '/client/installer',
      token,
      binaries.resolveProxy,
    );
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error(`安装包下载失败（${response.statusCode}）。`);
    }
    const hash = createHash('sha256');
    response.on('data', (chunk) => hash.update(chunk));
    await pipeline(response, createWriteStream(target));
    if (hash.digest('hex') !== expected.sha256) throw new Error('安装包校验失败，已放弃升级。');
    return target;
  }
  return {
    url: `ws://127.0.0.1:${server.address().port}/bridge/${nonce}`,
    close,
    downloadInstaller,
  };
}
