import type { NativeMetrics } from '@cc-desk-tunnel/protocol';

export const defaultQuotaGate = { warn: 90, stop: 95 };
export const defaultQuotaLimits = { fiveHour: defaultQuotaGate, week: defaultQuotaGate };

export type QuotaGate = { warn: number; stop: number };
export type QuotaLimits = { fiveHour: QuotaGate; week: QuotaGate };
// The official 5-hour window, as last reported. `available` is false for an API account, which has no
// subscription window; a null utilization is a reading that did not include a number.
export type FiveHourReading = {
  available: boolean;
  utilization: number | null;
  resetsAt: string | null;
};
export type QuotaAlert = { key: string; text: string; stopped: boolean };
export type QuotaView =
  | { level: 'unknown' }
  | { level: 'clear' }
  | { level: 'warn' | 'stop'; text: string; alerts: QuotaAlert[] };

export const quotaGateError = '提醒档必须低于停发档，且都是 1 到 100 之间的整数。';

export function validQuotaGate(warn: number, stop: number) {
  return (
    Number.isInteger(warn) &&
    Number.isInteger(stop) &&
    warn >= 1 &&
    warn <= 99 &&
    stop >= 2 &&
    stop <= 100 &&
    warn < stop
  );
}

function resetPhrase(resetsAt: string | null) {
  if (!resetsAt || Number.isNaN(Date.parse(resetsAt))) return '重置时间未提供';
  return `将于 ${new Date(resetsAt).toLocaleString('zh-CN', { hour12: false })} 重置`;
}

export function quotaText(
  label: string,
  utilization: number,
  resetsAt: string | null,
  stopped: boolean,
) {
  const reset = resetPhrase(resetsAt);
  return stopped
    ? `${label}已用 ${utilization}%，已暂停发送。${reset}。`
    : `${label}已用 ${utilization}%，${reset}。`;
}

export function readQuotaLimits(saved: unknown): QuotaLimits {
  if (!saved || typeof saved !== 'object')
    return {
      ...defaultQuotaLimits,
      fiveHour: { ...defaultQuotaGate },
      week: { ...defaultQuotaGate },
    };
  const value = saved as { warn?: unknown; stop?: unknown; fiveHour?: unknown; week?: unknown };
  // Older settings kept one pair, and it applied only to the 5-hour window.
  if (value.fiveHour || value.week)
    return { fiveHour: gateOf(value.fiveHour), week: gateOf(value.week) };
  return { fiveHour: gateOf(value), week: { ...defaultQuotaGate } };
}
function gateOf(value: unknown): QuotaGate {
  const warn = value && typeof value === 'object' ? (value as { warn?: unknown }).warn : undefined;
  const stop = value && typeof value === 'object' ? (value as { stop?: unknown }).stop : undefined;
  return typeof warn === 'number' && typeof stop === 'number' && validQuotaGate(warn, stop)
    ? { warn, stop }
    : { ...defaultQuotaGate };
}

const watched = [
  ['five_hour', '5 小时额度', 'fiveHour'],
  ['seven_day', '每周额度', 'week'],
] as const;

// A plan with a weekly quota per model has several weekly windows; the fullest is the one that stops
// work first. `seven_day_oauth_apps` limits the account's other applications, not this one.
function windowOf(
  windows: NonNullable<NativeMetrics['rateLimits']>['windows'],
  id: (typeof watched)[number][0],
) {
  if (id === 'five_hour') return windows.find((item) => item.name === 'five_hour');
  return windows
    .filter(
      (item) =>
        item.name.startsWith('seven_day') &&
        item.name !== 'seven_day_oauth_apps' &&
        item.utilization != null,
    )
    .sort((a, b) => b.utilization! - a.utilization!)[0];
}

function crossed(
  id: (typeof watched)[number][0],
  label: string,
  gate: QuotaGate,
  reading: FiveHourReading,
  now: number,
): QuotaAlert | null {
  if (reading.utilization == null) return null;
  if (reading.resetsAt) {
    const at = Date.parse(reading.resetsAt);
    if (Number.isFinite(at) && at <= now) return null;
  }
  const stopped = reading.utilization >= gate.stop;
  if (!stopped && reading.utilization < gate.warn) return null;
  return {
    key: `${id}|${reading.resetsAt ?? ''}|${gate.warn}`,
    stopped,
    text: quotaText(label, reading.utilization, reading.resetsAt, stopped),
  };
}

// No reading yet stays unknown, so a reminder already given is not forgotten while the page is loading.
// An empty number, an API account, or a window whose reset time has passed does not hold the send button.
// Either official window can warn or stop on its own pair of percents; stopping wins over a warning.
export function quotaViewOf(
  limits: QuotaLimits,
  metrics: NativeMetrics | null | undefined,
  now = Date.now(),
): QuotaView {
  const rateLimits = metrics?.rateLimits;
  if (!rateLimits) return { level: 'unknown' };
  if (!rateLimits.available) return { level: 'clear' };
  const alerts = watched.flatMap(([id, label, gate]) => {
    const window = windowOf(rateLimits.windows, id);
    const reading = {
      available: true,
      utilization: window?.utilization ?? null,
      resetsAt: window?.resetsAt ?? null,
    };
    const alert = crossed(id, label, limits[gate], reading, now);
    return alert ? [alert] : [];
  });
  if (!alerts.length) return { level: 'clear' };
  return {
    level: alerts.some((alert) => alert.stopped) ? 'stop' : 'warn',
    text: alerts.map((alert) => alert.text).join(''),
    alerts,
  };
}

// The two figures worth a glance while writing: how much of the five-hour and of the weekly quota is used.
// (The idea of the quota beside the message box: #27 and #41, hansaes.)
export function quotaFigures(limits: NonNullable<NativeMetrics['rateLimits']> | null | undefined) {
  if (!limits?.available) return [];
  const read = limits.windows.filter((window) => window.utilization !== null);
  const hour = read.find((window) => window.name === 'five_hour');
  const week = read
    .filter(
      (window) => window.name.startsWith('seven_day') && window.name !== 'seven_day_oauth_apps',
    )
    .sort((a, b) => b.utilization! - a.utilization!)[0];
  return [
    ...(hour ? [{ label: '5 小时', ...hour }] : []),
    ...(week ? [{ label: '每周', ...week }] : []),
  ].map(({ label, utilization, resetsAt }) => ({
    label,
    used: Math.round(utilization!),
    resetsAt,
  }));
}
