import { useEffect, useState } from 'react';
import { Hourglass, X } from 'lucide-react';
import type { IdleCompaction, SessionEvent } from '@cc-desk-tunnel/protocol';
import { idleReminder } from './idle.ts';
import { useT } from './i18n.ts';
import type { T } from './i18n.ts';
import { IconButton } from './ui.tsx';

const size = (tokens: number) => `${Math.round(tokens / 1000)}K tokens`;
const span = (t: T, minutes: number) =>
  minutes >= 60
    ? minutes % 60
      ? t('common:hours.minutes', { h: Math.floor(minutes / 60), m: minutes % 60 })
      : t('common:hours.whole', { h: Math.floor(minutes / 60) })
    : t('common:minutes', { m: minutes });

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
  const t = useT();
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
          {t('session:idle.before', { minutes: reminder.minutes, size: size(reminder.tokens) })}
        </p>
      ) : (
        <p>
          {t('session:idle.after', {
            span: span(t, reminder.minutes),
            size: size(reminder.tokens),
          })}
        </p>
      )}
      {reminder.phase === 'before' ? (
        <button type="button" className="button primary" disabled={!canCompact} onClick={compact}>
          {t('session:idle.compactNow')}
        </button>
      ) : (
        <button type="button" className="button secondary" onClick={startFresh}>
          {t('nav:newSession')}
        </button>
      )}
      <IconButton
        title={t('session:idle.close')}
        onClick={() => setClosed((keys) => [...keys, reminder.key])}
      >
        <X />
      </IconButton>
    </div>
  );
}
