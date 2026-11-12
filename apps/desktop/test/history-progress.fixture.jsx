import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { ProxyClient } from '../src/client.ts';
import Conversation from '../src/Conversation.tsx';
import '../src/style.css';

const noop = () => {};
function Harness() {
  const [client] = useState(() => new ProxyClient());
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  window.historyClient = client;
  useEffect(() => {
    const url = 'ws://127.0.0.1:18895/ws';
    client.connect(
      url,
      'test-only-history-progress-token',
      {
        id: crypto.randomUUID(),
        name: '历史显示测试',
      },
      false,
      async () => url,
    );
    return () => client.disconnect();
  }, [client]);
  useEffect(() => {
    if (state.status === 'connected' && !state.selectedId && state.sessions.length)
      client.select(state.sessions[0].id);
  }, [state.status, state.selectedId, state.sessions]);
  const session = state.sessions.find((item) => item.id === state.selectedId);
  return (
    <main style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header style={{ padding: '16px 28px', background: 'var(--panel)' }}>
        CC Desk Tunnel · {session?.title}
      </header>
      <Conversation
        session={session}
        events={session ? client.shown(session.id) : []}
        history={session ? state.history[session.id] : undefined}
        connected={state.status === 'connected'}
        native={false}
        ownsRun={false}
        busy={false}
        newSession={noop}
        loadEarlier={() => client.loadEarlier(session.id)}
        replyApproval={async () => true}
        stopTask={noop}
        backgroundTask={noop}
        stop={noop}
        findRequest={0}
        here={false}
        clock={{ now: Date.now, activityAt: () => 0 }}
      />
    </main>
  );
}
createRoot(document.getElementById('root')).render(<Harness />);
