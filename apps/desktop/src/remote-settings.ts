import type { RemoteStatus } from './desktop.d.ts';

export type RemoteConfiguration = Pick<RemoteStatus, 'enabled' | 'lan' | 'port'>;
export type RemoteChange = Partial<RemoteConfiguration>;
type RemoteSettingsApi = {
  read: () => Promise<RemoteStatus>;
  configure: (configuration: RemoteConfiguration) => Promise<RemoteStatus>;
  reset: () => Promise<RemoteStatus>;
};

// Each action changes only its own fields, against the preceding action's actual result. A blur and
// the click following it must both be saved; a failed bind must not poison later toggle requests.
export function remoteSettingsQueue(initial: RemoteStatus, api: RemoteSettingsApi) {
  let current = initial;
  let tail = Promise.resolve();
  function enqueue(change: (status: RemoteStatus) => Promise<RemoteStatus>) {
    const operation = tail.then(async () => {
      let error = '';
      try {
        current = await change(current);
      } catch (reason) {
        error = reason instanceof Error ? reason.message : '设置保存失败，请重试。';
        try {
          current = await api.read();
        } catch {
          // Keep the last confirmed status if both the write and subsequent status read fail.
        }
      }
      return { status: current, error };
    });
    tail = operation.then(() => {});
    return operation;
  }
  return {
    save: (change: RemoteChange) => {
      const patch = { ...change };
      return enqueue((status) =>
        api.configure({ enabled: status.enabled, lan: status.lan, port: status.port, ...patch }),
      );
    },
    reset: () => enqueue(() => api.reset()),
    refresh: () => enqueue(() => api.read()),
  };
}

// The renderer owns one queue, not each settings page. Reopening settings first waits for any
// in-flight write from the previous page so the next switch cannot restore an obsolete port.
export function remoteSettingsSession(api: RemoteSettingsApi) {
  let pending: Promise<ReturnType<typeof remoteSettingsQueue>> | undefined;
  return async () => {
    pending ??= api
      .read()
      .then((initial) => remoteSettingsQueue(initial, api))
      .catch((error) => {
        pending = undefined;
        throw error;
      });
    const queue = await pending;
    return { queue, ...(await queue.refresh()) };
  };
}
