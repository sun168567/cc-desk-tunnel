import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import type { UsagePage, UsageSummary } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { Trans } from 'react-i18next';
import { localeOf, type T, useT } from './i18n.ts';
import { IconButton } from './ui.tsx';
import { ModelBreakdown, TokenTrend, cacheHitRate, percent } from './UsageCharts.tsx';

const pageSize = 50;
// The quota windows the account's plan reports, by name (account:quota.window.<name>). The last is read from a
// long-lived token's replies, which do not name the models it counts.
const quotaWindows = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_oauth_apps',
  'seven_day_overage_included',
] as const;
const isQuotaWindow = (name: string): name is (typeof quotaWindows)[number] =>
  (quotaWindows as readonly string[]).includes(name);
// The service names a per-model weekly window `seven_day:<model>`, as the account's plan reports it.
export const quotaName = (t: T, name: string) =>
  isQuotaWindow(name)
    ? t(`account:quota.window.${name}`)
    : name.startsWith('seven_day:')
      ? t('account:quota.window.model', { model: name.slice(10) })
      : undefined;
// Large counts in the language's short form (12K, 1.2万); a formatter for each language shown.
const compacts = new Map<string, Intl.NumberFormat>();
const compactOf = (locale: string) => {
  let format = compacts.get(locale);
  if (!format)
    compacts.set(
      locale,
      (format = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })),
    );
  return format;
};
export const tokens = (t: T, value: number) =>
  value < 10000 ? value.toLocaleString(localeOf(t)) : compactOf(localeOf(t)).format(value);
export const dollars = (value: number) =>
  `$${value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toFixed(value >= 0.01 || value === 0 ? 2 : 4)}`;
export const seconds = (ms: number | null) =>
  ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const total = (item: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}) => item.inputTokens + item.outputTokens + item.cacheReadTokens + item.cacheCreationTokens;
const hour = 3600_000;
// The ranges offered, besides the plan's own windows (account:usage.range.<id>), and what the chart may show
// (account:usage.measure.<id>).
const presets = ['today', '24h', '7d', '30d', 'custom'] as const;
const measures = ['costUsd', 'tokens', 'requests'] as const;
type Measure = (typeof measures)[number];
const localInput = (date: Date) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export default function UsagePanel({
  client,
  summary,
  initial,
  back,
}: {
  client: ProxyClient;
  summary: UsageSummary | null;
  initial: string;
  back: () => void;
}) {
  const t = useT();
  const locale = localeOf(t);
  const [preset, setPreset] = useState(initial);
  const [customFrom, setCustomFrom] = useState(() => localInput(new Date(Date.now() - 24 * hour)));
  const [customTo, setCustomTo] = useState(() => localInput(new Date()));
  const [model, setModel] = useState('');
  const [measure, setMeasure] = useState<Measure>('costUsd');
  const [page, setPage] = useState<UsagePage | null>(null);
  // Which page of the records is shown, from the newest.
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  const range = useMemo(() => {
    const now = loadedAt;
    const window = summary?.windows.find((item) => item.name === preset);
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const from = window
      ? Date.parse(window.startedAt)
      : preset === 'today'
        ? midnight.getTime()
        : preset === '24h'
          ? now - 24 * hour
          : preset === '7d'
            ? now - 7 * 24 * hour
            : preset === '30d'
              ? now - 30 * 24 * hour
              : new Date(customFrom).getTime() || now - 24 * hour;
    const to = preset === 'custom' ? new Date(customTo).getTime() || now : now;
    const span = Math.max(to - from, hour);
    return {
      from,
      to,
      bucketMinutes: span <= 6 * hour ? 30 : span <= 48 * hour ? 60 : 1440,
      bounded: preset === 'custom',
    };
  }, [preset, customFrom, customTo, summary, loadedAt]);
  // The range ends where it was last read, so records arriving meanwhile do not shift the pages; refreshing
  // moves the end.
  const load = useCallback(
    async (index: number) => {
      setLoading(true);
      setError(null);
      try {
        const result = await client.fetch({
          type: 'usage.query',
          from: new Date(range.from).toISOString(),
          to: new Date(range.to).toISOString(),
          ...(model && { model }),
          offset: index * pageSize,
          limit: pageSize,
          bucketMinutes: range.bucketMinutes,
          offsetMinutes: -new Date().getTimezoneOffset(),
        });
        setPage(result);
        setIndex(index);
      } catch (error) {
        setError(error instanceof Error ? error.message : t('account:readFailed'));
      } finally {
        setLoading(false);
      }
    },
    [client, range, model],
  );
  useEffect(() => {
    void load(0);
  }, [load]);
  // Empty buckets are drawn too, so the time axis stays even.
  const bars = useMemo(() => {
    const step = range.bucketMinutes * 60_000,
      offset = -new Date().getTimezoneOffset() * 60_000;
    const align = (time: number) => Math.floor((time + offset) / step) * step - offset;
    const values = new Map((page?.series ?? []).map((item) => [Date.parse(item.at), item]));
    const result = [];
    for (let at = align(range.from); at <= range.to && result.length < 400; at += step)
      result.push(
        values.get(at) ?? {
          at: new Date(at).toISOString(),
          requests: 0,
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0,
        },
      );
    return result;
  }, [page?.series, range]);
  const peak = Math.max(...bars.map((bar) => bar[measure]), 0);
  const format = (value: number) =>
    measure === 'costUsd'
      ? dollars(value)
      : measure === 'tokens'
        ? tokens(t, value)
        : value.toLocaleString(locale);
  const bucketLabel = (at: string) =>
    new Date(at).toLocaleString(
      locale,
      range.bucketMinutes >= 1440
        ? { month: 'numeric', day: 'numeric' }
        : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' },
    );
  const totals = page?.totals;
  const pages = Math.max(Math.ceil((totals?.requests ?? 0) / pageSize), 1);
  return (
    <section className="account-page" aria-label={t('account:usage.title')}>
      <header className="account-heading">
        <IconButton title={t('account:usage.back')} onClick={back}>
          <ArrowLeft />
        </IconButton>
        <h1>{t('account:usage.title')}</h1>
        <IconButton
          title={t('account:usage.refresh')}
          disabled={loading}
          onClick={() => setLoadedAt(Date.now())}
        >
          <RefreshCw className={loading ? 'spinning' : ''} />
        </IconButton>
      </header>
      <div className="account-body usage-body">
        <div className="usage-filters">
          <div className="segmented" role="group" aria-label={t('account:usage.rangeLabel')}>
            {[
              ...(summary?.windows
                .filter((window) => quotaName(t, window.name))
                .map(
                  (window) =>
                    [
                      window.name,
                      t('account:usage.range.window', { name: quotaName(t, window.name) ?? '' }),
                    ] as const,
                ) ?? []),
              ...presets.map((id) => [id, t(`account:usage.range.${id}`)] as const),
            ].map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={preset === value}
                onClick={() => {
                  setPreset(value);
                  setLoadedAt(Date.now());
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <select
            aria-label={t('account:usage.model')}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">{t('account:usage.allModels')}</option>
            {[...new Set([...(page?.models ?? []), ...(model ? [model] : [])])].map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {preset === 'custom' && (
            <div className="usage-custom">
              <input
                type="datetime-local"
                aria-label={t('account:usage.from')}
                value={customFrom}
                max={customTo}
                onChange={(event) => setCustomFrom(event.target.value)}
              />
              <span>{t('account:usage.to')}</span>
              <input
                type="datetime-local"
                aria-label={t('account:usage.toLabel')}
                value={customTo}
                min={customFrom}
                onChange={(event) => setCustomTo(event.target.value)}
              />
            </div>
          )}
        </div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="usage-tiles">
          <div>
            <span>{t('account:usage.measure.requests')}</span>
            <strong>{totals ? totals.requests.toLocaleString(locale) : '—'}</strong>
          </div>
          <div
            title={
              totals
                ? t('account:usage.tokensWhole', {
                    input: totals.inputTokens.toLocaleString(locale),
                    output: totals.outputTokens.toLocaleString(locale),
                    read: totals.cacheReadTokens.toLocaleString(locale),
                    write: totals.cacheCreationTokens.toLocaleString(locale),
                  })
                : undefined
            }
          >
            <span>{t('account:usage.totalTokens')}</span>
            <strong>{totals ? tokens(t, total(totals)) : '—'}</strong>
            <small>
              {totals
                ? t('account:usage.tokensShort', {
                    input: tokens(t, totals.inputTokens),
                    output: tokens(t, totals.outputTokens),
                    cache: tokens(t, totals.cacheReadTokens + totals.cacheCreationTokens),
                  })
                : ''}
            </small>
          </div>
          <div title={t('account:usage.hitFormula')}>
            <span>{t('account:usage.hitRate')}</span>
            <strong>{percent(totals ? cacheHitRate(totals) : null)}</strong>
            <small>
              {totals
                ? t('account:usage.cacheRead', { tokens: tokens(t, totals.cacheReadTokens) })
                : ''}
            </small>
          </div>
          <div>
            <span>{t('account:usage.apiCost')}</span>
            <strong>{totals ? dollars(totals.costUsd) : '—'}</strong>
            <small>{t('account:usage.apiCostDetail')}</small>
          </div>
          <div>
            <span>{t('account:usage.ttft')}</span>
            <strong>{seconds(totals?.ttftMs ?? null)}</strong>
          </div>
          <div>
            <span>{t('account:usage.speed')}</span>
            <strong>
              {totals?.outputPerSecond != null ? `${totals.outputPerSecond.toFixed(1)} tok/s` : '—'}
            </strong>
          </div>
        </div>
        <figure className="usage-chart">
          <figcaption>
            <span>
              {t(
                range.bucketMinutes >= 1440
                  ? 'account:usage.chart.daily'
                  : range.bucketMinutes === 60
                    ? 'account:usage.chart.hourly'
                    : 'account:usage.chart.halfHourly',
                { measure: t(`account:usage.measure.${measure}`) },
              )}
            </span>
            <div className="segmented" role="group" aria-label={t('account:usage.measureLabel')}>
              {measures.map((key) => (
                <button
                  type="button"
                  key={key}
                  aria-pressed={measure === key}
                  onClick={() => setMeasure(key)}
                >
                  {t(`account:usage.measure.${key}`)}
                </button>
              ))}
            </div>
          </figcaption>
          <div className="usage-plot" onMouseLeave={() => setHover(null)}>
            <span className="usage-peak">{peak ? format(peak) : ''}</span>
            <div className="usage-bars">
              {bars.map((bar, index) => (
                <div
                  key={bar.at}
                  className={hover === index ? 'hovered' : ''}
                  onMouseEnter={() => setHover(index)}
                >
                  <i
                    style={{
                      height:
                        peak && bar[measure] ? `max(2px, ${(bar[measure] / peak) * 100}%)` : 0,
                    }}
                  />
                </div>
              ))}
            </div>
            {hover !== null && bars[hover] && (
              <div
                className="usage-tip"
                role="tooltip"
                style={
                  hover < bars.length / 2
                    ? { left: `${(hover / bars.length) * 100}%` }
                    : { right: `${(1 - (hover + 1) / bars.length) * 100}%` }
                }
              >
                <strong>{bucketLabel(bars[hover].at)}</strong>
                <span>
                  {t('account:usage.requests', {
                    count: bars[hover].requests,
                    n: bars[hover].requests.toLocaleString(locale),
                  })}
                </span>
                <span>{tokens(t, bars[hover].tokens)} tokens</span>
                <span>{dollars(bars[hover].costUsd)}</span>
              </div>
            )}
          </div>
          <div className="usage-axis">
            <span>{bars[0] && bucketLabel(bars[0].at)}</span>
            <span>{bars.length > 1 && bucketLabel(bars.at(-1)!.at)}</span>
          </div>
        </figure>
        <TokenTrend buckets={bars} label={bucketLabel} format={(value) => tokens(t, value)} />
        {page && page.byModel.length > 0 && (
          <ModelBreakdown
            models={page.byModel}
            tokens={(value) => tokens(t, value)}
            dollars={dollars}
          />
        )}
        <div className="usage-table usage-log">
          <h2 className="usage-section">{t('account:usage.records')}</h2>
          <table>
            <thead>
              <tr>
                <th>{t('account:usage.col.time')}</th>
                <th>{t('account:usage.col.session')}</th>
                <th>{t('account:usage.model')}</th>
                <th>{t('account:usage.col.input')}</th>
                <th>{t('account:usage.col.output')}</th>
                <th>{t('account:usage.col.cacheRead')}</th>
                <th>{t('account:usage.col.cacheWrite')}</th>
                <th>{t('account:usage.measure.costUsd')}</th>
                <th>{t('account:usage.col.ttft')}</th>
                <th>{t('account:usage.col.duration')}</th>
                <th>{t('account:usage.col.speed')}</th>
              </tr>
            </thead>
            <tbody>
              {page?.rows.map((row) => {
                const streaming =
                  row.ttftMs != null && row.durationMs > row.ttftMs
                    ? row.durationMs - row.ttftMs
                    : null;
                return (
                  <tr key={row.id}>
                    <td>
                      {new Date(row.at).toLocaleString(locale, {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </td>
                    <td title={row.sessionTitle ?? row.sessionId ?? undefined}>
                      {row.sessionTitle ?? (row.source && row.source !== 'sdk' ? row.source : '—')}
                    </td>
                    <td>{row.model}</td>
                    <td>{row.inputTokens.toLocaleString(locale)}</td>
                    <td>{row.outputTokens.toLocaleString(locale)}</td>
                    <td>{row.cacheReadTokens.toLocaleString(locale)}</td>
                    <td>{row.cacheCreationTokens.toLocaleString(locale)}</td>
                    <td>{dollars(row.costUsd)}</td>
                    <td>{seconds(row.ttftMs)}</td>
                    <td>{seconds(row.durationMs)}</td>
                    <td>
                      {streaming
                        ? `${(row.outputTokens / (streaming / 1000)).toFixed(1)} tok/s`
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {page && !page.rows.length && <p className="muted">{t('account:usage.empty')}</p>}
          {page && pages > 1 && (
            <nav className="usage-pager" aria-label={t('account:usage.pager')}>
              <IconButton
                title={t('account:usage.previous')}
                disabled={loading || index === 0}
                onClick={() => {
                  void load(index - 1);
                }}
              >
                <ChevronLeft />
              </IconButton>
              <label>
                <Trans
                  t={t}
                  i18nKey="account:usage.page"
                  values={{ pages }}
                  components={{
                    page: (
                      <input
                        key={index}
                        aria-label={t('account:usage.pageNumber')}
                        inputMode="numeric"
                        defaultValue={index + 1}
                        disabled={loading}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter') return;
                          const wanted = Math.round(Number(event.currentTarget.value));
                          if (wanted >= 1 && wanted <= pages) void load(wanted - 1);
                          else event.currentTarget.value = String(index + 1);
                        }}
                        onBlur={(event) => {
                          event.currentTarget.value = String(index + 1);
                        }}
                      />
                    ),
                  }}
                />
              </label>
              <IconButton
                title={t('account:usage.next')}
                disabled={loading || !page.hasMore}
                onClick={() => {
                  void load(index + 1);
                }}
              >
                <ChevronRight />
              </IconButton>
              <span>
                {t('account:usage.pageSize', {
                  total: totals!.requests.toLocaleString(locale),
                  size: pageSize,
                })}
              </span>
            </nav>
          )}
        </div>
        {summary && (
          <p className="account-updated">
            {summary.firstRecordAt
              ? t('account:usage.retentionSince', {
                  count: summary.retentionDays,
                  first: new Date(summary.firstRecordAt).toLocaleString(locale),
                })
              : t('account:usage.retention', { count: summary.retentionDays })}
          </p>
        )}
      </div>
    </section>
  );
}
