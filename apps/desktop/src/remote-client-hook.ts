import { useCallback, useEffect, useRef } from 'react';
import type { ProxyClient } from './client.ts';
import { createRemoteClientAdapter, remoteClientMethods } from './remote-client.ts';
import type { RemoteClientHost } from './remote-client.ts';

// Installing this hook does nothing until the desktop's optional Web listener is enabled.
export function useRemoteClientRequests(
  client: ProxyClient,
  getLocalTerminal: () => string | null,
) {
  const localTerminal = useRef(getLocalTerminal);
  localTerminal.current = getLocalTerminal;
  const adapter = useRef<ReturnType<typeof createRemoteClientAdapter> | null>(null);
  useEffect(() => {
    const host = window.desktop as (Window['desktop'] & Partial<RemoteClientHost>) | undefined;
    if (
      host?.remote ||
      !host?.onRemoteRequest ||
      !host.onRemoteEnabledChanged ||
      !host.publishRemoteEvent
    )
      return;
    const current = createRemoteClientAdapter(
      client,
      (event) => host.publishRemoteEvent!(event),
      () => localTerminal.current(),
    );
    adapter.current = current;
    let requests = () => {};
    const enabled = host.onRemoteEnabledChanged((value) => {
      requests();
      requests = value ? host.onRemoteRequest!(remoteClientMethods, current.invoke) : () => {};
      current.setEnabled(value);
    });
    return () => {
      enabled();
      requests();
      current.dispose();
      if (adapter.current === current) adapter.current = null;
    };
  }, [client]);
  return useCallback(
    (sessionId: string) => adapter.current?.terminalProblem(sessionId) ?? null,
    [],
  );
}
