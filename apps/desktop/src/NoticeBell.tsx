import { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { useT } from './i18n.ts';
import type { Notifications } from './notifications.ts';
import { ago } from './paths.ts';

// Each kind of notice by the word that heads it.
const names = {
  done: 'nav:notice.kind.done',
  failed: 'nav:notice.kind.failed',
  approval: 'nav:notice.kind.approval',
  question: 'nav:notice.kind.question',
  schedule: 'nav:notice.kind.schedule',
  connection: 'nav:notice.kind.connection',
} as const;

// The bell keeps what was reported while the user was elsewhere; opening it counts as having seen it.
export default function NoticeBell({
  notifications,
  open: openSession,
}: {
  notifications: Notifications;
  open: (sessionId: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const { notices, unread, markRead, clear } = notifications;
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div className="notice-bell" ref={container}>
      <button
        type="button"
        className="icon-button"
        title={t('nav:notice.title')}
        aria-label={unread ? t('nav:notice.unread', { count: unread }) : t('nav:notice.title')}
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          markRead();
        }}
      >
        <Bell />
        {unread > 0 && <span className="notice-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="notice-list" role="dialog" aria-label={t('nav:notice.title')}>
          <header>
            <strong>{t('nav:notice.title')}</strong>
            {notices.length > 0 && (
              <button type="button" onClick={clear}>
                {t('nav:notice.clear')}
              </button>
            )}
          </header>
          {notices.length === 0 && <p className="list-empty">{t('nav:notice.none')}</p>}
          {notices.map((notice) => (
            <button
              type="button"
              key={notice.id}
              className={`notice ${notice.kind}`}
              disabled={!notice.sessionId}
              onClick={() => {
                setOpen(false);
                openSession(notice.sessionId!);
              }}
            >
              <span>
                <strong>{notice.title}</strong>
                <small>
                  {t(names[notice.kind])} · {ago(t, notice.at)}
                </small>
              </span>
              <span className="notice-body">{notice.body}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
