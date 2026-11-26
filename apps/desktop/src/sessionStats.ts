import type { ServerMessage } from '@cc-desk-tunnel/protocol';
import { localeOf, type T } from './i18n.ts';
import { cacheHitRate, percent } from './UsageCharts.tsx';
import { dollars, seconds, tokens } from './UsagePanel.tsx';

export type SessionStats = Extract<ServerMessage, { type: 'session.stats' }>;

// One figure of a session, in the same shape as a turn's. The bar has two parts, each opening its own card:
// `session` holds the figures about the work, `tokens` the ones about what it used.
export type SessionField = {
  key: string;
  group: 'session' | 'tokens';
  label: string;
  summary: boolean;
  value: (stats: SessionStats) => string | null;
  short?: (stats: SessionStats) => string;
};

const total = (stats: SessionStats) =>
  stats.inputTokens + stats.outputTokens + stats.cacheReadTokens + stats.cacheCreationTokens;
const count = (t: T, value: number) => `${value.toLocaleString(localeOf(t))} tok`;

// The fields in the window's words: what names and tells each figure takes the window's `t`.
export const sessionFields = (t: T): SessionField[] => [
  {
    key: 'turns',
    group: 'session',
    label: t('account:stat.turns'),
    summary: true,
    // Requests from before the log named their prompts count as steps but belong to no turn.
    value: (stats) => (stats.turns ? t('account:stat.turnCount', { count: stats.turns }) : null),
    short: (stats) => t('account:stat.turnCount', { count: stats.turns }),
  },
  {
    key: 'steps',
    group: 'session',
    label: t('account:stat.steps'),
    summary: true,
    value: (stats) => t('account:stat.stepCount', { count: stats.requests }),
    short: (stats) => t('account:stat.stepCount', { count: stats.requests }),
  },
  {
    key: 'speed',
    group: 'session',
    label: t('account:stat.speed'),
    summary: true,
    value: (stats) =>
      stats.outputPerSecond == null ? null : `${stats.outputPerSecond.toFixed(1)} tok/s`,
    short: (stats) => t('account:stat.speedShort', { speed: Math.round(stats.outputPerSecond!) }),
  },
  {
    key: 'ttft',
    group: 'session',
    label: t('account:stat.ttft'),
    summary: false,
    value: (stats) => (stats.ttftMs == null ? null : seconds(stats.ttftMs)),
    short: (stats) => t('account:stat.ttftShort', { time: seconds(stats.ttftMs!) }),
  },
  {
    key: 'modelTime',
    group: 'session',
    label: t('account:stat.modelTime'),
    summary: false,
    value: (stats) => seconds(stats.modelMs),
    short: (stats) => t('account:stat.modelTimeShort', { time: seconds(stats.modelMs) }),
  },
  {
    key: 'tokens',
    group: 'tokens',
    label: t('account:stat.total'),
    summary: true,
    value: (stats) => count(t, total(stats)),
    short: (stats) => `${tokens(t, total(stats))} tok`,
  },
  {
    key: 'cacheHit',
    group: 'tokens',
    label: t('account:stat.cacheHit'),
    summary: true,
    value: (stats) => (total(stats) ? percent(cacheHitRate(stats)) : null),
    short: (stats) => t('account:stat.cacheHitShort', { rate: percent(cacheHitRate(stats)) }),
  },
  {
    key: 'input',
    group: 'tokens',
    label: t('account:stat.uncachedInput'),
    summary: false,
    value: (stats) => count(t, stats.inputTokens),
  },
  {
    key: 'cacheRead',
    group: 'tokens',
    label: t('account:usage.col.cacheRead'),
    summary: false,
    value: (stats) => count(t, stats.cacheReadTokens),
  },
  {
    key: 'cacheWrite',
    group: 'tokens',
    label: t('account:usage.col.cacheWrite'),
    summary: false,
    value: (stats) => count(t, stats.cacheCreationTokens),
  },
  {
    key: 'output',
    group: 'tokens',
    label: t('account:usage.col.output'),
    summary: false,
    value: (stats) => count(t, stats.outputTokens),
  },
  {
    key: 'cost',
    group: 'tokens',
    label: t('account:usage.measure.costUsd'),
    summary: false,
    // The official CLI's API-price estimate, not a subscription bill.
    value: (stats) =>
      stats.requests ? t('account:stat.costEstimate', { cost: dollars(stats.costUsd) }) : null,
    short: (stats) => t('account:stat.costShort', { cost: dollars(stats.costUsd) }),
  },
];

// `chosen` holds only the switches the user has flipped, by key.
export const inBar = (field: SessionField, chosen: Record<string, boolean>) =>
  chosen[field.key] ?? field.summary;

// What one part of the bar says: the group's figures switched on that have a value.
export const barText = (
  t: T,
  group: SessionField['group'],
  stats: SessionStats,
  chosen: Record<string, boolean>,
) =>
  sessionFields(t)
    .filter((field) => field.group === group && inBar(field, chosen) && field.value(stats) != null)
    .map(
      (field) =>
        field.short?.(stats) ??
        t('account:stat.labelled', { label: field.label, value: field.value(stats)! }),
    )
    .join(' · ');

// A made-up session for the settings to preview the bar with.
export const sampleSession: SessionStats = {
  type: 'session.stats',
  requestId: '00000000-0000-4000-8000-000000000000',
  sessionId: '00000000-0000-4000-8000-000000000001',
  turns: 12,
  requests: 38,
  inputTokens: 210,
  outputTokens: 31400,
  cacheReadTokens: 1_240_000,
  cacheCreationTokens: 96_000,
  modelMs: 412_000,
  ttftMs: 1100,
  outputPerSecond: 96.4,
  costUsd: 4.82,
  firstRecordAt: null,
};
