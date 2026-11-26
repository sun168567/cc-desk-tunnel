import type { AccountQuota } from '@cc-desk-tunnel/protocol';
import type { T } from './i18n.ts';

// The two figures worth a glance while writing: how much of the five-hour and of the weekly quota is used.
// A plan with a weekly quota per model has several weekly windows; the fullest is the one that stops work
// first. `seven_day_oauth_apps` limits the account's other applications, not this one.
// (The idea of the quota beside the message box: #27 and #41, hansaes.)
export function quotaFigures(
  t: T,
  limits: NonNullable<AccountQuota['rateLimits']> | null | undefined,
) {
  if (!limits?.available) return [];
  const read = limits.windows.filter((window) => window.utilization !== null);
  const hour = read.find((window) => window.name === 'five_hour');
  const week = read
    .filter(
      (window) => window.name.startsWith('seven_day') && window.name !== 'seven_day_oauth_apps',
    )
    .sort((a, b) => b.utilization! - a.utilization!)[0];
  return [
    ...(hour ? [{ label: t('account:quota.short.hour'), ...hour }] : []),
    ...(week ? [{ label: t('account:quota.short.week'), ...week }] : []),
  ].map(({ label, utilization, resetsAt }) => ({
    label,
    used: Math.round(utilization!),
    resetsAt,
  }));
}
