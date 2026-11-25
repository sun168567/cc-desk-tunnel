import type { TurnStats } from '@cc-desk-tunnel/protocol';
import { localeOf, type T } from './i18n.ts';
import { cacheHitRate, percent } from './UsageCharts.tsx';
import { seconds, tokens } from './UsagePanel.tsx';

// One figure of a turn. The detail list shows every field that has a value; the summary line only the ones
// switched on in the settings, which start as `summary`. A new figure is one more entry here.
export type StatField = {
  key: string;
  label: string;
  summary: boolean;
  // Null when the turn has no such figure.
  value: (stats: TurnStats) => string | null;
  // A shorter wording for the summary line; by default the label and the value.
  short?: (stats: TurnStats) => string;
};

const total = (stats: TurnStats) =>
  stats.inputTokens + stats.outputTokens + stats.cacheReadTokens + stats.cacheCreationTokens;
const count = (t: T, value: number) => `${value.toLocaleString(localeOf(t))} tok`;

// The fields in the window's words: what names and tells each figure takes the window's `t`.
export const statFields = (t: T): StatField[] => [
  {
    key: 'tokens',
    label: t('account:stat.tokens'),
    summary: true,
    value: (stats) => count(t, total(stats)),
    short: (stats) => `${tokens(t, total(stats))} tok`,
  },
  {
    key: 'ttft',
    label: t('account:stat.ttft'),
    summary: true,
    value: (stats) => (stats.ttftMs == null ? null : seconds(stats.ttftMs)),
  },
  {
    key: 'speed',
    label: t('account:stat.speed'),
    summary: true,
    value: (stats) =>
      stats.outputPerSecond == null ? null : `${stats.outputPerSecond.toFixed(1)} tok/s`,
    short: (stats) => t('account:stat.speedShort', { speed: Math.round(stats.outputPerSecond!) }),
  },
  {
    key: 'modelTime',
    label: t('account:stat.modelTime'),
    summary: false,
    value: (stats) => seconds(stats.modelMs),
  },
  {
    key: 'requests',
    label: t('account:stat.requests'),
    summary: false,
    value: (stats) => t('account:stat.requestCount', { count: stats.requests }),
  },
  {
    key: 'input',
    label: t('account:usage.col.input'),
    summary: false,
    value: (stats) => count(t, stats.inputTokens),
  },
  {
    key: 'output',
    label: t('account:usage.col.output'),
    summary: false,
    value: (stats) => count(t, stats.outputTokens),
  },
  {
    key: 'cacheRead',
    label: t('account:usage.col.cacheRead'),
    summary: false,
    value: (stats) => count(t, stats.cacheReadTokens),
  },
  {
    key: 'cacheWrite',
    label: t('account:usage.col.cacheWrite'),
    summary: false,
    value: (stats) => count(t, stats.cacheCreationTokens),
  },
  {
    key: 'cacheHit',
    label: t('account:stat.cacheHit'),
    summary: false,
    value: (stats) => (total(stats) ? percent(cacheHitRate(stats)) : null),
  },
];

// `chosen` holds only the switches the user has flipped, by key.
export const inSummary = (field: StatField, chosen: Record<string, boolean>) =>
  chosen[field.key] ?? field.summary;

// The summary line: the fields switched on that have a value, short wording where a field has one.
export const summaryText = (t: T, stats: TurnStats, chosen: Record<string, boolean>) =>
  statFields(t)
    .filter((field) => inSummary(field, chosen) && field.value(stats) != null)
    .map(
      (field) =>
        field.short?.(stats) ??
        t('account:stat.labelled', { label: field.label, value: field.value(stats)! }),
    )
    .join(' · ');

// A made-up turn for the settings to preview the line with.
export const sampleStats: TurnStats = {
  type: 'turn.stats',
  requests: 2,
  inputTokens: 12,
  outputTokens: 2700,
  cacheReadTokens: 36567,
  cacheCreationTokens: 9259,
  modelMs: 28200,
  ttftMs: 952,
  outputPerSecond: 99.3,
  partial: false,
};
