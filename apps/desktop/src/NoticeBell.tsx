import { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import type { Notifications } from './notifications.ts';
import { ago } from './paths.ts';

const names = {
  done: '完成',
  failed: '失败',
  approval: '审批',
  question: '提问',
  schedule: '定时任务',
  connection: '连接',
};

// The bell keeps what was reported while the user was elsewhere; opening it counts as having seen it.
export default function NoticeBell({
  notifications,
  open: openSession,
}: {
  notifications: Notifications;
  open: (sessionId: string) => void;
}) {
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
        title="通知"
        aria-label={unread ? `通知（${unread} 条未读）` : '通知'}
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
        <div className="notice-list" role="dialog" aria-label="通知">
          <header>
            <strong>通知</strong>
            {notices.length > 0 && (
              <button type="button" onClick={clear}>
                清空
              </button>
            )}
          </header>
          {notices.length === 0 && <p className="list-empty">暂无通知</p>}
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
                  {names[notice.kind]} · {ago(notice.at)}
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
