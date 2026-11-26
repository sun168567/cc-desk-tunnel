import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { PROTOCOL_HISTORY, PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { certificateMatches, connectService } from './proxy-bridge.mjs';
import { failure, phrase } from './failure.cjs';
import { say } from './words.mjs';

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
        end({ status: 'failed', error: say(phrase('desktop:bridge.pinMismatch')) });
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
        end({
          status: 'failed',
          error: say(message.phrase ?? message.message ?? phrase('desktop:service.refused')),
        });
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
  if (!protocolVersion) return Promise.reject(failure('desktop:service.tooOld', { service }));
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
        end(phrase('desktop:bridge.pinMismatch'));
      else remote.send(JSON.stringify({ type: 'auth', protocolVersion, token, deviceName }));
    });
    // Read as plain JSON: the frames are those of an older release.
    remote.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.type === 'connection.error' || (message.type === 'response' && !message.ok))
        fail(
          message.phrase ?? message.message ?? phrase('desktop:service.upgradeRefused'),
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
                : end(phrase('desktop:service.declined'), undefined, 'declined'),
            (error) => end(error.phrase ?? error.message, undefined, 'declined'),
          );
        else if (message.state === 'restarting') end(null, message.latest);
        else if (message.state === 'failed')
          fail(message.detail ?? phrase('desktop:service.upgradeFailed'));
        else if (message.state === 'manual')
          end(phrase('desktop:service.manual', { version: message.latest }), undefined, 'manual');
        else if (message.state === 'idle')
          end(phrase('desktop:service.noNewer'), undefined, 'current');
      }
    });
    remote.on('close', () => end(phrase('desktop:service.closed')));
    remote.on('error', (error) =>
      end(phrase('desktop:service.unreachable', { reason: error.phrase ?? error.message })),
    );
  });
}
