import { useEffect, useState } from 'react';
import { Activity, Database } from 'lucide-react';
import type { NativeMetrics } from '@cc-desk-tunnel/protocol';
import { localeOf, useT } from './i18n.ts';
import ContextMeter from './ContextMeter.tsx';
import { usePrefs } from './prefs.ts';
import type { ProxyClient } from './client.ts';
import { barText, sessionFields, type SessionField, type SessionStats } from './sessionStats.ts';
import { usePopover } from './usePopover.ts';

// One part of the bar: a button with the figures switched on that opens a card with all of them.
function Part({
  group,
  stats,
  chosen,
  title,
  icon,
  note,
}: {
  group: SessionField['group'];
  stats: SessionStats;
  chosen: Record<string, boolean>;
  title: string;
  icon: React.ReactNode;
  note?: string;
}) {
  const { open, setOpen, container, card } = usePopover();
  const rows = sessionFields.flatMap((field) => {
    const value = field.group === group ? field.value(stats) : null;
    return value == null ? [] : [{ field, value }];
  });
  if (rows.length === 0) return null;
  const headline = rows.find(({ field }) => field.key === 'tokens' || field.key === 'turns');
  return (
    <div className={`session-bar-part ${group}`} ref={container}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {icon}
        <span>{barText(group, stats, chosen) || title}</span>
      </button>
      {open && (
        <div className="turn-stats-card" role="dialog" aria-label={title} ref={card}>
          <header>
            {icon}
            <strong>{title}</strong>
            {headline && <b>{headline.value}</b>}
          </header>
          <dl>
            {rows
              .filter((row) => row !== headline)
              .map(({ field, value }) => (
                <div key={field.key}>
                  <dt>{field.label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
          </dl>
          {note && <p>{note}</p>}
        </div>
      )}
    </div>
  );
}

// The strip under the input box, centred: what the whole session has done and used, and how full the context
// window is. It asks the service again whenever a turn's report arrives, `refresh` counting them.
export default function SessionBar({
  client,
  sessionId,
  refresh,
  metrics,
  native,
}: {
  client: ProxyClient;
  sessionId: string;
  refresh: number;
  metrics: NativeMetrics | null;
  native: boolean;
}) {
  const t = useT();
  const { sessionBar } = usePrefs();
  const [stats, setStats] = useState<SessionStats | null>(null);
  useEffect(() => {
    if (!sessionBar.enabled) return;
    let current = true;
    client.fetch({ type: 'session.stats', sessionId }).then(
      (result) => current && setStats(result),
      () => current && setStats(null),
    );
    return () => {
      current = false;
    };
  }, [client, sessionId, refresh, sessionBar.enabled]);
  if (!sessionBar.enabled) return null;
  const shown = !!stats && stats.sessionId === sessionId && stats.requests > 0;
  if (!shown && !native) return null;
  // The call log is pruned, so a session older than its oldest record is counted from there.
  const since = stats?.firstRecordAt
    ? t('session:stats.since', {
        date: new Date(stats.firstRecordAt).toLocaleDateString(localeOf(t)),
      })
    : undefined;
  // How the cache writes split by lifetime, which only the CLI's own totals say (CLI 2.1.311 and later).
  const usage = metrics?.usage;
  const lifetimes =
    usage?.cacheWrite1hTokens !== undefined
      ? t('session:stats.lifetimes', {
          hour: usage.cacheWrite1hTokens.toLocaleString(localeOf(t)),
          minutes: (usage.cacheWrite5mTokens ?? 0).toLocaleString(localeOf(t)),
        })
      : undefined;
  return (
    <div className="session-bar">
      {shown && stats && (
        <>
          <Part
            group="session"
            stats={stats}
            chosen={sessionBar.summary}
            title={t('session:stats.session')}
            icon={<Activity />}
            note={since}
          />
          <Part
            group="tokens"
            stats={stats}
            chosen={sessionBar.summary}
            title={t('session:stats.tokens')}
            icon={<Database />}
            note={
              lifetimes && since
                ? t('session:stats.both', { lifetimes, since })
                : (lifetimes ?? since)
            }
          />
        </>
      )}
      {native && <ContextMeter metrics={metrics} withPercent />}
    </div>
  );
}
