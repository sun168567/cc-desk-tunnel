import { localeOf, type T } from './i18n.ts';

// Making a formatter costs far more than using one, and every message shown asks for its time: one set for each
// language the window has shown.
const sets = new Map<string, ReturnType<typeof formatters>>();
const formatters = (locale: string) => ({
  clock: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }),
  day: new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }),
  dayOfYear: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'numeric', day: 'numeric' }),
  whole: new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }),
});
function formattersOf(locale: string) {
  let set = sets.get(locale);
  if (!set) sets.set(locale, (set = formatters(locale)));
  return set;
}

export function messageTime(t: T, at: string, now = new Date()) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return null;
  const today = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const { clock, day, dayOfYear, whole } = formattersOf(localeOf(t));
  const label = today
    ? t('common:today')
    : date.toDateString() === yesterday.toDateString()
      ? t('common:yesterday')
      : (date.getFullYear() !== now.getFullYear() ? dayOfYear : day).format(date);
  return { short: `${label} ${clock.format(date)}`, full: whole.format(date) };
}
