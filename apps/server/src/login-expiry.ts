import { phrase } from '@cc-desk-tunnel/i18n';

// Days left of a sign-in that ends at `expiresAt`, rounded up; null for no date.
export function daysLeft(expiresAt: string | undefined, now = Date.now()) {
  const at = expiresAt ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(at) ? Math.ceil((at - now) / 86_400_000) : null;
}
// The CLI warns from ten days before a stored claude.ai sign-in ends, in its terminal. A conversation in the window is
// told with a turn's result, which carries the date, at most once a day.
export function loginExpiryWarnings() {
  let warnedOn = '';
  return (expiresAt: string | undefined, now = Date.now()) => {
    const days = daysLeft(expiresAt, now);
    const today = new Date(now).toISOString().slice(0, 10);
    if (days === null || days > 10 || warnedOn === today) return null;
    warnedOn = today;
    const date = expiresAt!.slice(0, 10);
    return days > 0
      ? phrase('service:notice.loginExpiring', { count: days, date })
      : phrase('service:notice.loginExpired', { date });
  };
}
