import { useEffect, useState } from 'react';
import { Activity, Database } from 'lucide-react';
import type { NativeMetrics } from '@cc-desk-tunnel/protocol';
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
    ? `调用记录最早从 ${new Date(stats.firstRecordAt).toLocaleDateString('zh-CN')} 起，更早的请求不在统计内。`
    : undefined;
  // How the cache writes split by lifetime, which only the CLI's own totals say (CLI 2.1.311 and later).
  const usage = metrics?.usage;
  const lifetimes =
    usage?.cacheWrite1hTokens !== undefined
      ? `CLI 报告的缓存写入中，1 小时缓存 ${usage.cacheWrite1hTokens.toLocaleString('zh-CN')}、5 分钟缓存 ${(usage.cacheWrite5mTokens ?? 0).toLocaleString('zh-CN')} tokens；1 小时缓存的写入单价是 5 分钟的 1.6 倍。`
      : undefined;
  return (
    <div className="session-bar">
      {shown && stats && (
        <>
          <Part
            group="session"
            stats={stats}
            chosen={sessionBar.summary}
            title="会话统计"
            icon={<Activity />}
            note={since}
          />
          <Part
            group="tokens"
            stats={stats}
            chosen={sessionBar.summary}
            title="Token 用量"
            icon={<Database />}
            note={[lifetimes, since].filter(Boolean).join('') || undefined}
          />
        </>
      )}
      {native && <ContextMeter metrics={metrics} withPercent />}
    </div>
  );
}
