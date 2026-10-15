import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AtSign, Folder, Image, Plus, Terminal } from 'lucide-react';
import { Claude, OpenAI } from '@lobehub/icons';
import type { Session, UsagePage } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { tokens } from './UsagePanel.tsx';

const TITLE_MAX = 22;
const TITLE_MIN = 14;

type RangeKey = 'all' | '30d' | '7d';
type TabKey = 'overview' | 'models';

const DAY_MS = 86_400_000;
const HEATMAP_WEEKS = 20;
const HEATMAP_CELLS = HEATMAP_WEEKS * 7;

// Shrink the greeting to the heading's width so a long name stays on one line. Below a readable
// size, the name and the sentence each stay intact and the sentence moves to the next line.
function useFittedTitle(enabled: boolean, text: string) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const heading = headingRef.current;
    const line = lineRef.current;
    if (!enabled || !heading || !line) return;

    let neededAtMax = 0;
    const measureNatural = () => {
      const previous = line.style.fontSize;
      const wrapped = line.classList.contains('is-wrapped');
      line.style.fontSize = `${TITLE_MAX}px`;
      line.classList.remove('is-wrapped');
      neededAtMax = line.scrollWidth;
      line.style.fontSize = previous;
      line.classList.toggle('is-wrapped', wrapped);
    };
    const apply = () => {
      const available = heading.clientWidth;
      if (available <= 0 || neededAtMax <= 0) return;
      let next = '';
      let wrap = false;
      if (neededAtMax > available + 1) {
        const size = ((available - 2) / neededAtMax) * TITLE_MAX;
        if (size >= TITLE_MIN) next = `${Math.round(size * 10) / 10}px`;
        else {
          next = `${TITLE_MIN}px`;
          wrap = true;
        }
      }
      if (line.style.fontSize !== next) line.style.fontSize = next;
      line.classList.toggle('is-wrapped', wrap);
    };

    measureNatural();
    apply();
    const observer = new ResizeObserver(() => apply());
    observer.observe(heading);
    const onFonts = () => {
      measureNatural();
      apply();
    };
    void document.fonts?.ready.then(onFonts);
    return () => observer.disconnect();
  }, [enabled, text]);

  return { headingRef, lineRef };
}

function shortModelName(raw: string | undefined | null): {
  label: string;
  vendor: 'claude' | 'openai';
} {
  if (!raw) return { label: 'Opus 5.5', vendor: 'claude' };
  const lower = raw.toLowerCase();
  if (lower.includes('gpt') || lower.includes('codex') || lower.startsWith('o')) {
    return { label: raw.replace(/^openai:/i, ''), vendor: 'openai' };
  }
  const match = /claude-([a-z]+)-(\d+)-(\d+)/i.exec(raw);
  if (match) {
    const family = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
    return { label: `${family} ${match[2]}.${match[3]}`, vendor: 'claude' };
  }
  return { label: raw, vendor: 'claude' };
}

function formatPeakHour(hour: number | null): string {
  if (hour == null || Number.isNaN(hour)) return '—';
  const h = ((hour % 24) + 24) % 24;
  return `${String(h).padStart(2, '0')}:00`;
}

function tokenComparisonNote(totalTokens: number): string {
  if (totalTokens <= 0) return '随时准备在这个工作区开始新的编码与协作任务。';
  const hobbitTokens = 95_000;
  const ratio = totalTokens / hobbitTokens;
  if (ratio >= 1.5) {
    return `已累计消耗约 ${Math.round(ratio)} 倍于《霍比特人》全书的 Token 量。`;
  }
  if (ratio >= 0.2) {
    return `已累计消耗约 ${ratio.toFixed(1)} 本《霍比特人》的 Token 量。`;
  }
  return `已累计处理 ${tokens(totalTokens)} Token，随时准备开始新的任务。`;
}

export default function WelcomeHero({
  sessionTitle,
  projectPath,
  connected,
  accountName,
  onNewSession,
  provider,
  client,
  sessions = [],
}: {
  sessionTitle?: string;
  projectPath?: string;
  connected?: boolean;
  accountName?: string;
  onNewSession?: () => void;
  provider?: 'claude' | 'openai';
  client?: ProxyClient;
  sessions?: Session[];
}) {
  const [osUser, setOsUser] = useState('');
  const [tab, setTab] = useState<TabKey>('overview');
  const [range, setRange] = useState<RangeKey>('30d');
  const [usage, setUsage] = useState<UsagePage | null>(null);

  useEffect(() => {
    void window.desktop?.username?.().then((name) => {
      if (name) setOsUser(name);
      else void window.desktop?.device?.().then((dev) => setOsUser(dev.name));
    });
  }, []);

  useEffect(() => {
    if (!client) return;
    let active = true;
    const now = Date.now();
    const days = range === '7d' ? 7 : range === '30d' ? 30 : 140;
    const from = now - days * DAY_MS;
    const offsetMinutes = -new Date().getTimezoneOffset();
    void client
      .fetch({
        type: 'usage.query',
        from: new Date(from).toISOString(),
        to: new Date(now).toISOString(),
        offset: 0,
        limit: 1,
        bucketMinutes: 1440,
        offsetMinutes,
      })
      .then(
        (result) => {
          if (active && result && Array.isArray(result.series)) setUsage(result);
        },
        () => {},
      );
    return () => {
      active = false;
    };
  }, [client, range, sessions.length]);

  const stats = useMemo(() => {
    const now = Date.now();
    const cutoff =
      range === '7d' ? now - 7 * DAY_MS : range === '30d' ? now - 30 * DAY_MS : 0;
    const filteredSessions = cutoff
      ? sessions.filter((s) => (Date.parse(s.updatedAt) || 0) >= cutoff)
      : sessions;

    const sessionCount = filteredSessions.length;
    const totalTokens = usage
      ? usage.totals.inputTokens +
        usage.totals.outputTokens +
        usage.totals.cacheReadTokens +
        usage.totals.cacheCreationTokens
      : 0;
    const messagesCount =
      usage && usage.totals.requests > 0 ? usage.totals.requests : sessionCount;

    const dayActivity = new Map<number, number>();
    const todayIndex = Math.floor(now / DAY_MS);
    if (usage) {
      for (const bucket of usage.series) {
        if (bucket.requests > 0) {
          const ts = typeof bucket.at === 'number' ? bucket.at : Date.parse(bucket.at);
          if (ts) {
            const idx = Math.floor(ts / DAY_MS);
            dayActivity.set(idx, (dayActivity.get(idx) ?? 0) + bucket.requests);
          }
        }
      }
    }
    for (const s of filteredSessions) {
      const ts = Date.parse(s.updatedAt) || Date.parse(s.createdAt);
      if (ts) {
        const idx = Math.floor(ts / DAY_MS);
        if (!dayActivity.has(idx)) dayActivity.set(idx, 1);
      }
    }

    const activeDays = dayActivity.size;

    const hourCounts = new Map<number, number>();
    for (const s of filteredSessions) {
      const ts = Date.parse(s.updatedAt) || Date.parse(s.createdAt);
      if (ts) {
        const h = new Date(ts).getHours();
        hourCounts.set(h, (hourCounts.get(h) ?? 0) + 1);
      }
    }
    let peakHour: number | null = null;
    let peakCount = 0;
    for (const [h, count] of hourCounts) {
      if (count > peakCount) {
        peakCount = count;
        peakHour = h;
      }
    }

    const topUsageModel = usage?.byModel?.[0]?.model;
    const fallbackSession = filteredSessions[0] ?? sessions[0];
    const favModel = topUsageModel
      ? shortModelName(topUsageModel)
      : fallbackSession?.provider === 'openai' || provider === 'openai'
        ? { label: fallbackSession?.model ?? 'Codex', vendor: 'openai' as const }
        : shortModelName(fallbackSession?.model);

    const cells: { key: number; count: number; level: 0 | 1 | 2 | 3; dateText: string }[] = [];
    let maxDaily = 1;
    for (const v of dayActivity.values()) {
      if (v > maxDaily) maxDaily = v;
    }
    const startDay = todayIndex - HEATMAP_CELLS + 1;
    for (let i = 0; i < HEATMAP_CELLS; i++) {
      const day = startDay + i;
      const count = dayActivity.get(day) ?? 0;
      const ratio = count / maxDaily;
      const level: 0 | 1 | 2 | 3 =
        count <= 0 ? 0 : ratio > 0.66 ? 3 : ratio > 0.33 ? 2 : 1;
      const dateText = new Date(day * DAY_MS).toLocaleDateString('zh-CN');
      cells.push({ key: day, count, level, dateText });
    }

    const modelsList =
      usage && usage.byModel.length > 0
        ? usage.byModel.slice(0, 5).map((row) => {
            const rowTokens =
              row.inputTokens +
              row.outputTokens +
              row.cacheReadTokens +
              row.cacheCreationTokens;
            const parsed = shortModelName(row.model);
            return {
              id: row.model,
              label: parsed.label,
              vendor: parsed.vendor,
              requests: row.requests,
              tokens: rowTokens,
            };
          })
        : [
            {
              id: favModel.label,
              label: favModel.label,
              vendor: favModel.vendor,
              requests: messagesCount,
              tokens: totalTokens,
            },
          ];

    return {
      sessionCount,
      messagesCount,
      totalTokens,
      activeDays,
      peakHour: formatPeakHour(peakHour),
      favModel,
      cells,
      modelsList,
    };
  }, [usage, sessions, range, provider]);

  const isDefaultTitle = !sessionTitle || sessionTitle === '新会话';
  const rawUser = accountName ? accountName.split('@')[0].trim() : '';
  const username =
    (rawUser && !['未登录', '账号', '离线模拟'].includes(rawUser) ? rawUser : '') || osUser;
  const greeting = '开始新的编码与协作会话吧！';
  const { headingRef, lineRef } = useFittedTitle(!!onNewSession, `${username}\n${greeting}`);

  return (
    <div className="welcome-hero">
      <div className="brand login-brand welcome-brand-lockup" aria-hidden="true">
        {provider === 'openai' ? (
          <OpenAI.Combine size={30} type={'color'} />
        ) : (
          <Claude.Combine size={30} type={'color'} />
        )}
        <span className="login-brand-divider" />
        <span className="login-brand-sub">CC Desk Tunnel</span>
      </div>

      <h2 className="welcome-title" ref={onNewSession ? headingRef : undefined}>
        {onNewSession ? (
          <span className="welcome-title-line" ref={lineRef}>
            {username && <span className="welcome-user-mention">@{username}</span>}
            <span className="welcome-title-rest">{greeting}</span>
          </span>
        ) : isDefaultTitle ? (
          '今天想推进什么工作？'
        ) : (
          sessionTitle
        )}
      </h2>

      <p className="welcome-subtitle">
        {onNewSession
          ? '从左侧选择已有会话继续，或新建一个会话连接工作区与终端。'
          : '在下方直接描述任务，支持引用工作区文件、粘贴截图与执行终端命令。'}
      </p>

      {projectPath && (
        <div className="empty-project" title={projectPath}>
          <Folder />
          <span>{projectPath}</span>
        </div>
      )}

      {onNewSession ? (
        <div className="welcome-actions">
          <button
            type="button"
            className="button primary welcome-cta"
            disabled={!connected}
            onClick={onNewSession}
          >
            <Plus />
            新建会话
          </button>
        </div>
      ) : (
        <div className="welcome-hints" aria-hidden="true">
          <span className="welcome-hint-pill">
            <AtSign />
            输入 @ 引用文件
          </span>
          <span className="welcome-hint-pill">
            <Image />
            粘贴或拖拽图片与附件
          </span>
          <span className="welcome-hint-pill">
            <Terminal />
            读写代码与执行命令
          </span>
        </div>
      )}

      <div className="welcome-card" aria-label="活动概览">
        <div className="welcome-card-bar">
          <div className="welcome-card-tabs" role="tablist" aria-label="概览视图">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'overview'}
              className={tab === 'overview' ? 'is-active' : undefined}
              onClick={() => setTab('overview')}
            >
              概览
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'models'}
              className={tab === 'models' ? 'is-active' : undefined}
              onClick={() => setTab('models')}
            >
              模型
            </button>
          </div>
          <div className="welcome-card-ranges" role="group" aria-label="统计周期">
            {(
              [
                ['all', '全部'],
                ['30d', '30天'],
                ['7d', '7天'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={range === key}
                className={range === key ? 'is-active' : undefined}
                onClick={() => setRange(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {tab === 'overview' ? (
          <>
            <div className="welcome-metrics">
              <div className="welcome-metric">
                <span>会话数</span>
                <strong>{stats.sessionCount.toLocaleString('zh-CN')}</strong>
              </div>
              <div className="welcome-metric">
                <span>消息数</span>
                <strong>{stats.messagesCount.toLocaleString('zh-CN')}</strong>
              </div>
              <div className="welcome-metric">
                <span>总 Token</span>
                <strong>{stats.totalTokens > 0 ? tokens(stats.totalTokens) : '0'}</strong>
              </div>
              <div className="welcome-metric">
                <span>活跃天数</span>
                <strong>{stats.activeDays}</strong>
              </div>
              <div className="welcome-metric">
                <span>高峰时段</span>
                <strong>{stats.peakHour}</strong>
              </div>
              <div className="welcome-metric">
                <span>常用模型</span>
                <strong className="welcome-fav-model">
                  {stats.favModel.vendor === 'openai' ? (
                    <OpenAI size={13} />
                  ) : (
                    <Claude.Color size={13} />
                  )}
                  <span>{stats.favModel.label}</span>
                </strong>
              </div>
            </div>

            <div className="welcome-heatmap" aria-hidden="true">
              {stats.cells.map((cell) => (
                <i
                  key={cell.key}
                  className={`heat-cell level-${cell.level}`}
                  title={`${cell.dateText} · ${cell.count} 次活动`}
                />
              ))}
            </div>

            <p className="welcome-footnote">{tokenComparisonNote(stats.totalTokens)}</p>
          </>
        ) : (
          <div className="welcome-models-list">
            {stats.modelsList.map((item) => {
              const maxTokens = Math.max(1, ...stats.modelsList.map((m) => m.tokens));
              const widthPct = item.tokens > 0 ? Math.max(8, Math.round((item.tokens / maxTokens) * 100)) : 12;
              return (
                <div className="welcome-model-row" key={item.id}>
                  <div className="welcome-model-head">
                    <span className="welcome-model-name">
                      {item.vendor === 'openai' ? (
                        <OpenAI size={14} />
                      ) : (
                        <Claude.Color size={14} />
                      )}
                      <strong>{item.label}</strong>
                    </span>
                    <span className="welcome-model-meta">
                      {item.requests.toLocaleString('zh-CN')} 次 ·{' '}
                      {item.tokens > 0 ? `${tokens(item.tokens)} tokens` : '0 tokens'}
                    </span>
                  </div>
                  <div className="welcome-model-bar">
                    <i style={{ width: `${widthPct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
