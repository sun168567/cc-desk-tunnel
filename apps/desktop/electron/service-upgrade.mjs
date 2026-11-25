import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { PROTOCOL_HISTORY, PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { certificateMatches, connectService } from './proxy-bridge.mjs';

// Has a service older than this client, which refuses it at sign-in, upgrade itself the way its own clients
// do: sign in with the protocol version of its release, ask it to check for the newest release and install
// it, and follow its progress until it restarts. Resolves to the version installed. `confirm`, given the version found,
// can decline the install. An error says why in its `code` where there is nothing to do: `current` (no newer
// release), `manual` (the release needs the server's image updated), `declined`, `busy` (sessions at work, which
// `force` upgrades past on a service of FORCED_UPGRADE_SINCE or later).
function open(address, fingerprint, resolveProxy) {
  return new WebSocket(address, {
    createConnection: (_options, created) => {
      connectService(address, { fingerprint }, resolveProxy).then(
        (socket) => created(null, socket),
        created,
      );
    },
  });
}

// What a service says to this client at sign-in, asked over a connection that ends at once: `ready` when it would
// take it, or its refusal for the version, with the client release it holds and how far it has fetched that one;
// `unreachable` when it does not answer, as while it restarts. The sign-in window follows a service this way while
// it fetches this client's installer, or restarts after its own upgrade.
export function probeService({ url, fingerprint, token, deviceName }, options = {}) {
  const address = new URL(url);
  const remote = options.open?.() ?? open(address, fingerprint, options.resolveProxy);
  return new Promise((resolve) => {
    const end = (result) => {
      clearTimeout(timer);
      remote.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => end({ status: 'unreachable' }), options.timeoutMs ?? 10_000);
    remote.on('open', () => {
      if (
        fingerprint &&
        !certificateMatches(remote._socket.getPeerCertificate().fingerprint256, fingerprint)
      )
        end({ status: 'failed', error: '服务证书指纹不匹配；未发送服务凭据。' });
      else
        remote.send(
          JSON.stringify({ type: 'auth', protocolVersion: PROTOCOL_VERSION, token, deviceName }),
        );
    });
    remote.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString('utf8'));
      } catch {
        return end({ status: 'unreachable' });
      }
      if (message.type === 'ready') end({ status: 'ready' });
      else if (message.type === 'connection.error' && message.code === 'version_mismatch')
        end({
          status: 'refused',
          service: message.service ?? null,
          release: message.client?.version ?? null,
          preparing: message.preparing
            ? message.preparing.size
              ? message.preparing.received / message.preparing.size
              : 0
            : null,
        });
      else if (message.type === 'connection.error')
        end({ status: 'failed', error: message.message ?? '服务端拒绝了连接。' });
    });
    remote.on('close', () => end({ status: 'unreachable' }));
    remote.on('error', () => end({ status: 'unreachable' }));
  });
}

export function upgradeService(
  { url, fingerprint, token, deviceName, service, force },
  options = {},
) {
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
  const remote = options.open?.() ?? open(address, fingerprint, options.resolveProxy);
  const send = (message) => remote.send(JSON.stringify({ requestId: randomUUID(), ...message }));
  return new Promise((resolve, reject) => {
    // A failure is said in the service's words: a text, or a phrase the window says in its language, with the
    // text the service sent beside it, if any.
    const fail = (words, code, sent) => {
      remote.close();
      const text = typeof words === 'string' ? words : (sent ?? words.key);
      reject(
        Object.assign(
          new Error(text),
          typeof words === 'string' ? {} : { phrase: words },
          code ? { code } : {},
        ),
      );
    };
    const end = (error, version, code) => {
      if (error) return fail(error, code);
      remote.close();
      resolve(version);
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
        fail(
          message.phrase ?? message.message ?? '服务端拒绝了升级。',
          message.code === 'native_busy' ? 'busy' : undefined,
          message.message,
        );
      // An upgrade already under way is only followed.
      else if (message.type === 'ready' && message.update?.state !== 'installing')
        send({ type: 'service.update.check' });
      else if (message.type === 'service.update') {
        options.onUpdate?.(message);
        if (message.state === 'available')
          Promise.resolve(options.confirm?.(message.latest) ?? true).then(
            (yes) =>
              yes
                ? send({
                    type: 'service.update.install',
                    version: message.latest,
                    ...(force ? { force: true } : {}),
                  })
                : end('没有升级服务端。', undefined, 'declined'),
            (error) => end(error.message, undefined, 'declined'),
          );
        else if (message.state === 'restarting') end(null, message.latest);
        else if (message.state === 'failed') fail(message.detail ?? '服务端升级失败。');
        else if (message.state === 'manual')
          end(
            `服务端 ${message.latest} 需要更新镜像，请在服务器上执行 sudo cc-desk-tunnel upgrade；没有这个命令的旧部署重新运行安装命令即可。`,
            undefined,
            'manual',
          );
        else if (message.state === 'idle')
          end('服务端没有找到更新的正式版本。', undefined, 'current');
      }
    });
    remote.on('close', () => end('与服务端的连接断开了；稍后重新连接，查看它是否已经升级。'));
    remote.on('error', (error) => end(`连不上服务端：${error.message}`));
  });
}
