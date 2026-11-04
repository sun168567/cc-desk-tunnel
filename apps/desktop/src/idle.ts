import type { IdleCompaction, SessionEvent } from '@cc-desk-tunnel/protocol';

// As the service has it until it says otherwise.
const DEFAULTS: IdleCompaction = { enabled: false, afterMinutes: 50, minTokens: 100_000 };
const HOUR = 3_600_000;

export type Reminder = {
  // Before the one-hour cache lapses, while compacting still reads it; or after it has.
  phase: 'before' | 'after';
  key: string;
  tokens: number;
  minutes: number;
};

// What an idle session reminds of, `now`: its last turn that wrote a prompt cache says when the cache was written and
// how long it lasts, and the last reading of the context how big it is (small again after a compaction). The service
// compacts by itself before the cache lapses when that is on, so there is then only the reminder after.
export function idleReminder(
  events: SessionEvent[],
  settings: IdleCompaction | null,
  now: number,
): Reminder | null {
  let turn: SessionEvent | undefined;
  let tokens: number | undefined;
  for (let index = events.length - 1; index >= 0 && !turn; index--) {
    const { payload } = events[index];
    if (payload.type !== 'native.metrics') continue;
    tokens ??= payload.context?.usedTokens;
    if (payload.cacheTtl) turn = events[index];
  }
  if (turn?.payload.type !== 'native.metrics' || tokens === undefined) return null;
  const { enabled, afterMinutes, minTokens } = settings ?? DEFAULTS;
  if (tokens < minTokens) return null;
  const idle = now - Date.parse(turn.createdAt);
  const lasts = turn.payload.cacheTtl === '1h' ? HOUR : 300_000;
  const key = `${turn.sessionId}:${turn.sequence}`;
  if (idle >= Math.max(lasts, HOUR))
    return { phase: 'after', key: `${key}:after`, tokens, minutes: Math.floor(idle / 60_000) };
  if (lasts === HOUR && !enabled && idle >= afterMinutes * 60_000 && idle < lasts)
    return {
      phase: 'before',
      key: `${key}:before`,
      tokens,
      minutes: Math.ceil((lasts - idle) / 60_000),
    };
  return null;
}
