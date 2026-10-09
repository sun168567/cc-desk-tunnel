import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { getPrefs } from './prefs.ts';
import type { NotifyKind } from './prefs.ts';

export type Notice = {
  id: string;
  kind: NotifyKind;
  title: string;
  body: string;
  sessionId?: string;
  at: number;
  read: boolean;
};
export type Notifications = {
  notices: Notice[];
  unread: number;
  // Reports something that happened outside the session list: a lost connection, a task that was not sent.
  push: (notice: Pick<Notice, 'kind' | 'title' | 'body' | 'sessionId'>) => void;
  markRead: () => void;
  clear: () => void;
};
const kept = 50;

// Watches every session's run for the moments that need the user — it ended, or it waits for an answer — and
// tells them: in the bell's list, and through the system's own notification when the window is not in front.
// The session being read in a focused window says it already and raises neither.
export function useNotifications(client: ProxyClient, viewing: () => string | null): Notifications {
  const [notices, setNotices] = useState<Notice[]>([]);
  const view = useRef(viewing);
  view.current = viewing;

  const push = useCallback<Notifications['push']>((notice) => {
    const prefs = getPrefs().notify;
    if (!prefs.enabled || !prefs[notice.kind]) return;
    const away = !document.hasFocus() || document.visibilityState === 'hidden';
    if (!away && notice.sessionId && notice.sessionId === view.current()) return;
    setNotices((current) =>
      [{ ...notice, id: crypto.randomUUID(), at: Date.now(), read: false }, ...current].slice(
        0,
        kept,
      ),
    );
    if (away)
      void window.desktop?.notify({
        title: notice.title,
        body: notice.body,
        sessionId: notice.sessionId ?? null,
        silent: !prefs.sound,
      });
  }, []);

  useEffect(() => {
    let previous = new Map<string, Session['activeRun']>();
    let known = false;
    const inspect = () => {
      const { sessions, status } = client.state;
      if (status !== 'connected') {
        known = false;
        return;
      }
      const runs = new Map(sessions.map((session) => [session.id, session.activeRun]));
      // The first directory after connecting is the starting point, not a change.
      if (known)
        for (const session of sessions) {
          const before = previous.get(session.id);
          const now = session.activeRun;
          if (now?.surface === 'terminal' || before?.surface === 'terminal') continue;
          if (now?.status === 'awaiting_approval' && before?.status !== 'awaiting_approval')
            waiting(session);
          // Claude's turn is over once only background tasks go on; their ending without another turn is no news.
          if (now?.waiting === 'background' && before && before.waiting !== 'background')
            push({ kind: 'done', title: '任务完成', body: session.title, sessionId: session.id });
          if (before && !now && before.waiting !== 'background') ended(session, before.id);
        }
      previous = runs;
      known = true;
    };
    // The run's last events are merged into the store a moment after the session itself changes.
    const later = (report: () => void) => setTimeout(report, 200);
    const waiting = (session: Session) => {
      const question = session.activeRun?.waiting === 'question';
      push({
        kind: question ? 'question' : 'approval',
        title: question ? 'Claude 有问题要问你' : '等待审批',
        body: session.title,
        sessionId: session.id,
      });
    };
    const ended = (session: Session, runId: string) =>
      later(() => {
        const events = (client.state.events[session.id] ?? []).filter(
          (event) => event.runId === runId,
        );
        const status = events.findLast((event) => event.payload.type === 'run.status')?.payload;
        const outcome = status?.type === 'run.status' ? status.status : undefined;
        // Stopping a run is the user's own doing.
        if (outcome === 'cancelled') return;
        const error = events.findLast((event) => event.payload.type === 'run.error')?.payload;
        if (outcome === 'failed' || error)
          push({
            kind: 'failed',
            title: '任务失败',
            body: `${session.title}${error?.type === 'run.error' ? `：${error.message}` : ''}`,
            sessionId: session.id,
          });
        else push({ kind: 'done', title: '任务完成', body: session.title, sessionId: session.id });
      });
    inspect();
    return client.subscribe(inspect);
  }, [client, push]);

  return {
    notices,
    unread: notices.filter((notice) => !notice.read).length,
    push,
    markRead: useCallback(
      () => setNotices((current) => current.map((notice) => ({ ...notice, read: true }))),
      [],
    ),
    clear: useCallback(() => setNotices([]), []),
  };
}
