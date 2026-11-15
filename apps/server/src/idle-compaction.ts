import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { idleCompactionSchema } from '@cc-desk-tunnel/protocol';
import type { EventPayload, IdleCompaction } from '@cc-desk-tunnel/protocol';

type Metrics = Extract<EventPayload, { type: 'native.metrics' }>;

export const IDLE_COMPACTION: IdleCompaction = {
  enabled: false,
  afterMinutes: 50,
  minTokens: 100_000,
};
// The one-hour cache lasts from the turn's last request. A compaction is sent with a minute to spare, as after the
// service restarted late in the hour; past that it would read the whole context anew, and is left out.
const LASTS_MS = 3_600_000;
const SPARE_MS = 60_000;

const file = (directory: string) => join(directory, 'idle-compaction.json');

// The service's own setting, kept with its sessions. A file it cannot read is the defaults.
export function readIdleCompaction(directory: string): IdleCompaction {
  try {
    return idleCompactionSchema.parse({
      ...IDLE_COMPACTION,
      ...JSON.parse(readFileSync(file(directory), 'utf8')),
    });
  } catch {
    return { ...IDLE_COMPACTION };
  }
}

export function writeIdleCompaction(directory: string, values: Partial<IdleCompaction>) {
  const next = idleCompactionSchema.parse({ ...readIdleCompaction(directory), ...values });
  writeFileSync(`${file(directory)}.new`, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${file(directory)}.new`, file(directory));
  return next;
}

// How long the prompt cache a turn wrote lasts, as its requests were billed (the API's usage says how much of what it
// wrote is kept for an hour and how much for five minutes); nothing when it wrote none.
export function cacheTtl(usage: unknown): '5m' | '1h' | undefined {
  const written = (
    usage as
      | {
          cache_creation?: {
            ephemeral_1h_input_tokens?: number;
            ephemeral_5m_input_tokens?: number;
          } | null;
        }
      | undefined
  )?.cache_creation;
  if ((written?.ephemeral_1h_input_tokens ?? 0) > 0) return '1h';
  if ((written?.ephemeral_5m_input_tokens ?? 0) > 0) return '5m';
  return undefined;
}

// The same for a result whose usage does not break its cache writes down, from the session's running totals by
// lifetime (CLI 2.1.311 and later): what they grew by since the turn before. The first turn a run hears of compares
// with nothing, so a resumed session's earlier writes count for it.
export function cacheWrites() {
  let before = { hour: 0, minutes: 0 };
  return (
    modelUsage:
      | Record<
          string,
          {
            cacheCreationEphemeral1hInputTokens?: number;
            cacheCreationEphemeral5mInputTokens?: number;
          }
        >
      | undefined,
  ): '5m' | '1h' | undefined => {
    const values = Object.values(modelUsage ?? {});
    const now = {
      hour: values.reduce(
        (sum, value) => sum + (value.cacheCreationEphemeral1hInputTokens ?? 0),
        0,
      ),
      minutes: values.reduce(
        (sum, value) => sum + (value.cacheCreationEphemeral5mInputTokens ?? 0),
        0,
      ),
    };
    const grew = { hour: now.hour > before.hour, minutes: now.minutes > before.minutes };
    before = now;
    return grew.hour ? '1h' : grew.minutes ? '5m' : undefined;
  };
}

// When a session whose turn ended at `endedAt` is to be compacted: `afterMinutes` later, if that turn wrote a one-hour
// cache and the context holds `minTokens` or more; otherwise never (null).
export function compactionDue(settings: IdleCompaction, endedAt: number, metrics: Metrics) {
  const tokens = metrics.context?.usedTokens;
  if (!settings.enabled || metrics.cacheTtl !== '1h' || tokens === undefined) return null;
  if (tokens < settings.minTokens) return null;
  return endedAt + settings.afterMinutes * 60_000;
}

// One timer per session, set when a turn ends and cleared by whatever comes first: another message, a terminal, the
// setting changed. `fire` compacts the session as the compact button does.
export class IdleCompactions {
  settings: IdleCompaction;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private directory: string;
  private fire: (sessionId: string) => void;
  constructor(directory: string, fire: (sessionId: string) => void) {
    this.directory = directory;
    this.fire = fire;
    this.settings = readIdleCompaction(directory);
  }
  update(values: Partial<IdleCompaction>) {
    this.settings = writeIdleCompaction(this.directory, values);
    this.clear();
    return this.settings;
  }
  arm(sessionId: string, endedAt: number, metrics: Metrics, now = Date.now()) {
    this.cancel(sessionId);
    const due = compactionDue(this.settings, endedAt, metrics);
    const lapses = endedAt + LASTS_MS - SPARE_MS;
    if (due === null || now >= lapses) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(sessionId);
        if (Date.now() < lapses) this.fire(sessionId);
      },
      Math.max(0, due - now),
    );
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }
  armed(sessionId: string) {
    return this.timers.has(sessionId);
  }
  cancel(sessionId: string) {
    clearTimeout(this.timers.get(sessionId));
    this.timers.delete(sessionId);
  }
  clear() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
