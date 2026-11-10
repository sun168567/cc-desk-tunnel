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
    return days > 0
      ? `Claude Code 的登录约 ${days} 天后到期（${expiresAt!.slice(0, 10)}），到期后要在“账号与额度”里重新登录。`
      : `Claude Code 的登录可能已经到期（${expiresAt!.slice(0, 10)}）；如果请求开始失败，请在“账号与额度”里重新登录。`;
  };
}
