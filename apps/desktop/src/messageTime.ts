export function messageTime(at: string, now = new Date()) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return null;
  const time = date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const today = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const day = today
    ? '今天'
    : date.toDateString() === yesterday.toDateString()
      ? '昨天'
      : date.toLocaleDateString('zh-CN', {
          ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
          month: 'numeric',
          day: 'numeric',
        });
  return {
    short: `${day} ${time}`,
    full: date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }),
  };
}
