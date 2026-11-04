import { useEffect, useState } from 'react';
import { Hourglass, X } from 'lucide-react';
import type { IdleCompaction, SessionEvent } from '@cc-desk-tunnel/protocol';
import { idleReminder } from './idle.ts';
import { IconButton } from './ui.tsx';

const size = (tokens: number) => `${Math.round(tokens / 1000)}K tokens`;
const span = (minutes: number) =>
  minutes >= 60
    ? `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`
    : `${minutes} 分钟`;

// Shown above the message box of the session being read; closing it hides it until the next turn.
export default function IdleReminder({
  events,
  settings,
  canCompact,
  compact,
  startFresh,
}: {
  events: SessionEvent[];
  settings: IdleCompaction | null;
  canCompact: boolean;
  compact: () => void;
  startFresh: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [closed, setClosed] = useState<string[]>([]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const reminder = idleReminder(events, settings, now);
  if (!reminder || closed.includes(reminder.key)) return null;
  return (
    <div className="elsewhere-bar idle-reminder" role="status">
      <Hourglass />
      {reminder.phase === 'before' ? (
        <p>
          提示缓存约 {reminder.minutes}{' '}
          分钟后过期。现在压缩读取的是缓存，比过期后再压缩便宜得多（上下文约 {size(reminder.tokens)}
          ）。
        </p>
      ) : (
        <p>
          距上一轮已过 {span(reminder.minutes)}，提示缓存已过期：下一条消息会按全价重读约{' '}
          {size(reminder.tokens)} 的上下文。新任务建议新建会话（相当于
          /clear）；要接着做又想省一些，可以先切到较便宜的模型压缩，再切回原模型。
        </p>
      )}
      {reminder.phase === 'before' ? (
        <button type="button" className="button primary" disabled={!canCompact} onClick={compact}>
          现在压缩
        </button>
      ) : (
        <button type="button" className="button secondary" onClick={startFresh}>
          新建会话
        </button>
      )}
      <IconButton title="关闭提醒" onClick={() => setClosed((keys) => [...keys, reminder.key])}>
        <X />
      </IconButton>
    </div>
  );
}
