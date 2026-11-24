import type { ServerMessage } from '@cc-desk-tunnel/protocol';
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
const count = (value: number) => `${value.toLocaleString('zh-CN')} tok`;

export const sessionFields: SessionField[] = [
  {
    key: 'turns',
    group: 'session',
    label: '轮数',
    summary: true,
    // Requests from before the log named their prompts count as steps but belong to no turn.
    value: (stats) => (stats.turns ? `${stats.turns} 轮` : null),
    short: (stats) => `${stats.turns} 轮`,
  },
  {
    key: 'steps',
    group: 'session',
    label: '步数',
    summary: true,
    value: (stats) => `${stats.requests} 步`,
    short: (stats) => `${stats.requests} 步`,
  },
  {
    key: 'speed',
    group: 'session',
    label: '平均速度',
    summary: true,
    value: (stats) =>
      stats.outputPerSecond == null ? null : `${stats.outputPerSecond.toFixed(1)} tok/s`,
    short: (stats) => `平均 ${Math.round(stats.outputPerSecond!)} tok/s`,
  },
  {
    key: 'ttft',
    group: 'session',
    label: '平均首字',
    summary: false,
    value: (stats) => (stats.ttftMs == null ? null : seconds(stats.ttftMs)),
    short: (stats) => `首字 ${seconds(stats.ttftMs!)}`,
  },
  {
    key: 'modelTime',
    group: 'session',
    label: '模型用时',
    summary: false,
    value: (stats) => seconds(stats.modelMs),
    short: (stats) => `模型 ${seconds(stats.modelMs)}`,
  },
  {
    key: 'tokens',
    group: 'tokens',
    label: '总用量',
    summary: true,
    value: (stats) => count(total(stats)),
    short: (stats) => `${tokens(total(stats))} tok`,
  },
  {
    key: 'cacheHit',
    group: 'tokens',
    label: '缓存命中',
    summary: true,
    value: (stats) => (total(stats) ? percent(cacheHitRate(stats)) : null),
    short: (stats) => `缓存命中 ${percent(cacheHitRate(stats))}`,
  },
  {
    key: 'input',
    group: 'tokens',
    label: '未缓存输入',
    summary: false,
    value: (stats) => count(stats.inputTokens),
  },
  {
    key: 'cacheRead',
    group: 'tokens',
    label: '缓存读取',
    summary: false,
    value: (stats) => count(stats.cacheReadTokens),
  },
  {
    key: 'cacheWrite',
    group: 'tokens',
    label: '缓存写入',
    summary: false,
    value: (stats) => count(stats.cacheCreationTokens),
  },
  {
    key: 'output',
    group: 'tokens',
    label: '输出',
    summary: false,
    value: (stats) => count(stats.outputTokens),
  },
  {
    key: 'cost',
    group: 'tokens',
    label: '等价费用',
    summary: false,
    // The official CLI's API-price estimate, not a subscription bill.
    value: (stats) => (stats.requests ? `${dollars(stats.costUsd)}（按 API 价格估算）` : null),
    short: (stats) => `等价 ${dollars(stats.costUsd)}`,
  },
];

// `chosen` holds only the switches the user has flipped, by key.
export const inBar = (field: SessionField, chosen: Record<string, boolean>) =>
  chosen[field.key] ?? field.summary;

// What one part of the bar says: the group's figures switched on that have a value.
export const barText = (
  group: SessionField['group'],
  stats: SessionStats,
  chosen: Record<string, boolean>,
) =>
  sessionFields
    .filter((field) => field.group === group && inBar(field, chosen) && field.value(stats) != null)
    .map((field) => field.short?.(stats) ?? `${field.label} ${field.value(stats)}`)
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
