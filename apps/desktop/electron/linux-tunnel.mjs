import { startLinuxSsh } from './linux-ssh.mjs';
import { startRelay } from './relay.mjs';

// The Linux desktop's side of the tunnel: a per-connection SSH endpoint reached through the service's WSS relay.
// No tunnel program or extra port is involved.
export async function startLinuxTunnel(configuration, binaries, signal, onFailure) {
  let ssh, relay, closing;
  const close = () =>
    (closing ??= (async () => {
      signal.removeEventListener('abort', abort);
      relay?.close();
      await ssh?.close();
    })());
  const abort = () => {
    void close();
  };
  try {
    signal.throwIfAborted();
    ssh = await startLinuxSsh();
    signal.throwIfAborted();
    relay = startRelay(configuration, ssh.port, binaries.openRelay, onFailure);
    signal.addEventListener('abort', abort, { once: true });
    return {
      credentials: {
        type: 'tunnel.credentials',
        connectionId: configuration.connectionId,
        platform: 'linux',
        username: ssh.username,
        privateKey: ssh.privateKey,
        hostPublicKey: ssh.hostPublicKey,
        powershellPath: '/bin/bash',
        ...(binaries.schedulesPath && { schedulesPath: binaries.schedulesPath }),
      },
      close,
      // Fresh relay connections after the control connection was resumed.
      reset: () => relay.reset(),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
