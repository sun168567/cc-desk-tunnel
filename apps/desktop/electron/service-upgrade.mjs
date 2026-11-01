import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { PROTOCOL_HISTORY } from '@cc-desk-tunnel/protocol';
import { certificateMatches, connectService } from './proxy-bridge.mjs';

// Has a service older than this client, which refuses it at sign-in, upgrade itself the way its own clients
// do: sign in with the protocol version of its release, ask it to check for the newest release and install
// it, and follow its progress until it restarts. Resolves to the version installed.
export function upgradeService({ url, fingerprint, token, deviceName, service }, options = {}) {
  const protocolVersion = Object.entries(PROTOCOL_HISTORY).findLast(
    ([release]) => release.localeCompare(service, undefined, { numeric: true }) <= 0,
  )?.[1];
  if (!protocolVersion)
    return Promise.reject(
      new Error(
        `服务端 ${service} 太旧，请在服务器上重新运行安装命令升级（见项目 README 的“快速开始”）。`,
      ),
    );
  const address = new URL(url);
  const remote =
    options.open?.() ??
    new WebSocket(address, {
      createConnection: (_options, created) => {
        connectService(address, { fingerprint }, options.resolveProxy).then(
          (socket) => created(null, socket),
          created,
        );
      },
    });
  const send = (message) => remote.send(JSON.stringify({ requestId: randomUUID(), ...message }));
  return new Promise((resolve, reject) => {
    const end = (error, version) => {
      remote.close();
      if (error) reject(new Error(error));
      else resolve(version);
    };
    remote.on('open', () => {
      if (
        fingerprint &&
        !certificateMatches(remote._socket.getPeerCertificate().fingerprint256, fingerprint)
      )
        end('服务证书指纹不匹配；未发送服务凭据。');
      else remote.send(JSON.stringify({ type: 'auth', protocolVersion, token, deviceName }));
    });
    // Read as plain JSON: the frames are those of an older release.
    remote.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.type === 'connection.error' || (message.type === 'response' && !message.ok))
        end(message.message ?? '服务端拒绝了升级。');
      // An upgrade already under way is only followed.
      else if (message.type === 'ready' && message.update?.state !== 'installing')
        send({ type: 'service.update.check' });
      else if (message.type === 'service.update') {
        options.onUpdate?.(message);
        if (message.state === 'available')
          send({ type: 'service.update.install', version: message.latest });
        else if (message.state === 'restarting') end(null, message.latest);
        else if (message.state === 'failed') end(message.detail ?? '服务端升级失败。');
        else if (message.state === 'manual')
          end(
            `服务端 ${message.latest} 需要更新镜像，请在服务器上执行 sudo cc-desk-tunnel upgrade；没有这个命令的旧部署重新运行安装命令即可。`,
          );
        else if (message.state === 'idle') end('服务端没有找到更新的正式版本。');
      }
    });
    remote.on('close', () => end('与服务端的连接断开了；稍后重新连接，查看它是否已经升级。'));
    remote.on('error', (error) => end(`连不上服务端：${error.message}`));
  });
}
