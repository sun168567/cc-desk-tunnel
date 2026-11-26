import type { AccountQuota } from '@cc-desk-tunnel/protocol';
import type { T } from './i18n.ts';

type Window = NonNullable<AccountQuota['rateLimits']>['windows'][number];

// The quota windows the account's plan reports, by name (account:quota.window.<name>), as the clients and ccdt call
// them. The last is read from a long-lived token's replies, which do not name the models it counts.
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

// The model a weekly window counts apart: `/usage` names it (`seven_day:<model>`, a Max plan's Fable), the response
// headers name Opus and Sonnet. None for the account's whole week.
function modelOf(name: string) {
  if (name.startsWith('seven_day:')) return name.slice('seven_day:'.length);
  const named = /^seven_day_(opus|sonnet)$/.exec(name)?.[1];
  return named ? named[0]!.toUpperCase() + named.slice(1) : null;
}

// The two figures worth a glance while writing: how much of the five-hour and of the weekly quota is used. The week
// is the account's whole week, unless the model this session uses has a weekly window of its own that is fuller,
// which then stops it first and is named after the model; `model` is whatever names that model (its value, ID and
// name). With no whole week to show, the fullest window stands in. `seven_day_oauth_apps` limits the account's
// other applications, not this one. (The idea of the quota beside the message box: #27 and #41, hansaes.)
export function quotaFigures(
  t: T,
  limits: NonNullable<AccountQuota['rateLimits']> | null | undefined,
  model = '',
) {
  if (!limits?.available) return [];
  const read = limits.windows.filter((window) => window.utilization !== null);
  const hour = read.find((window) => window.name === 'five_hour');
  const fullest = (windows: Window[]) =>
    windows.toSorted((a, b) => b.utilization! - a.utilization!)[0];
  const weeks = read.filter(
    (window) => window.name.startsWith('seven_day') && window.name !== 'seven_day_oauth_apps',
  );
  const whole = weeks.find((window) => window.name === 'seven_day');
  const words = model.toLowerCase();
  const own = words
    ? fullest(weeks.filter((window) => words.includes(modelOf(window.name)?.toLowerCase() ?? '\0')))
    : undefined;
  const week =
    own && (!whole || own.utilization! > whole.utilization!) ? own : (whole ?? fullest(weeks));
  const apart = week && modelOf(week.name);
  return [
    ...(hour ? [{ label: t('account:quota.short.hour'), ...hour }] : []),
    ...(week
      ? [
          {
            label: apart
              ? t('account:quota.short.modelWeek', { model: apart })
              : t('account:quota.short.week'),
            ...week,
          },
        ]
      : []),
  ].map(({ label, utilization, resetsAt }) => ({
    label,
    used: Math.round(utilization!),
    resetsAt,
  }));
}
