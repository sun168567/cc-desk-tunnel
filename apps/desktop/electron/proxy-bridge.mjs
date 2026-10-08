import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { createServer, request } from 'node:http';
import { isIP } from 'node:net';
import { connect } from 'node:tls';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { serverMessageSchema, MAX_FRAME_BYTES } from '@cc-desk-tunnel/protocol';
import { startWindowsTunnel } from './windows-tunnel.mjs';
import { httpProxy, openSocket } from './system-proxy.mjs';
import { controlFailure } from './connect-errors.mjs';

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
// `route`, when given, is told the proxy that was used, for the words of a failure.
async function connectService(address, config, resolveProxy, route) {
  const port = Number(address.port || 443);
  const proxy = httpProxy(await resolveProxy?.(`https://${address.hostname}:${port}`));
  if (route) route.proxy = proxy;
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
  wss.on('connection', (local) => {
    // CA verification completes at TLS handshake; explicit pins are checked before sending credentials.
    const route = { proxy: null };
    const remote = new WebSocket(address, {
      // Node's HTTP client also takes the connection through this callback once it is ready.
      createConnection: (_options, created) => {
        connectService(address, config, binaries.resolveProxy, route).then(
          (socket) => created(null, socket),
          created,
        );
      },
    });
    pair = { local, remote, controller: new AbortController(), tunnel: null, preparing: null };
    const current = pair;
    const queue = [];
    let verified = false;
    let nativeReady;
    let configurationReceived = false;
    const timer = setTimeout(
      () =>
        fail(
          configurationReceived
            ? '执行通道在 45 秒内没有就绪。\n服务凭据已通过，本机的隧道组件也已启动，但服务端经隧道连不回本机：请检查服务器防火墙 / 云安全组是否放行了隧道端口，以及安全软件是否拦截了内置的 frpc.exe 或 sshd.exe。'
            : '服务端在 45 秒内没有完成应答。\n请检查网络是否稳定，或稍后重试；反复出现时查看服务端日志。',
        ),
      45000,
    );
    function fail(message) {
      if (local.readyState === WebSocket.OPEN)
        local.send(JSON.stringify({ type: 'connection.error', code: 'tunnel_failed', message }));
      clearTimeout(timer);
      void close(true);
    }
    remote.on('open', () => {
      if (
        config.fingerprint &&
        !certificateMatches(remote._socket.getPeerCertificate().fingerprint256, config.fingerprint)
      ) {
        fail(
          '服务证书指纹不匹配；未发送服务凭据。\n请核对“服务证书指纹”是否与安装时给出的一致；服务端更换过证书后需要填新的指纹。若两者都没变，说明连到的不是你的服务器。',
        );
        return;
      }
      verified = true;
      for (const message of queue) remote.send(message);
      queue.length = 0;
    });
    local.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString('utf8'));
        if (message.type?.startsWith('tunnel.')) throw new Error('Renderer tunnel message');
        if (message.type === 'auth') {
          message.tunnel = true;
          token = String(message.token);
        }
        if (verified && remote.readyState === WebSocket.OPEN) remote.send(JSON.stringify(message));
        else queue.push(JSON.stringify(message));
      } catch {
        fail('客户端消息格式错误。');
      }
    });
    remote.on('message', (raw) => {
      let message;
      try {
        message = serverMessageSchema.parse(JSON.parse(raw.toString('utf8')));
      } catch {
        fail('服务端的消息无法识别。\n客户端与服务端的版本可能不一致，请把两者升级到同一版本。');
        return;
      }
      // A service of another version refuses the connection but may still offer the installer for its own.
      if (message.type === 'connection.error' && message.client) release = message.client;
      if (message.type === 'tunnel.configure') {
        if (
          configurationReceived ||
          !nativeReady ||
          nativeReady.connectionId !== message.connectionId
        ) {
          fail('隧道连接标识不匹配。');
          return;
        }
        configurationReceived = true;
        current.preparing = startWindowsTunnel(message, binaries, current.controller.signal, fail)
          .then((tunnel) => {
            current.tunnel = tunnel;
            if (!closed && remote.readyState === WebSocket.OPEN)
              remote.send(JSON.stringify(tunnel.credentials));
          })
          .catch((error) => fail(error.message));
      } else if (message.type === 'ready' && message.adapter === 'claude-code') {
        nativeReady = message;
        release = message.client;
      } else if (message.type === 'tunnel.ready') {
        if (!configurationReceived || message.connectionId !== nativeReady?.connectionId) {
          fail('隧道就绪标识不匹配。');
          return;
        }
        clearTimeout(timer);
        if (local.readyState === WebSocket.OPEN) local.send(JSON.stringify(nativeReady));
      } else if (local.readyState === WebSocket.OPEN) {
        if (message.type === 'ready') clearTimeout(timer);
        local.send(raw.toString('utf8'));
      }
    });
    for (const socket of [local, remote]) {
      socket.on('close', () => {
        clearTimeout(timer);
        void close(true);
      });
      socket.on('error', (error) =>
        fail(
          controlFailure(
            error,
            `${address.hostname}:${address.port || 443}`,
            socket === remote ? route.proxy : null,
          ),
        ),
      );
    }
  });
  async function close(notify = false) {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      pair?.controller.abort();
      pair?.local.close();
      pair?.remote.terminate();
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
