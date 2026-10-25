import type { NativeMetrics } from '@cc-desk-tunnel/protocol';

type Windows = NonNullable<NativeMetrics['rateLimits']>['windows'];
export type ProbedQuota = { windows: Windows; measuredAt: string };
export type QuotaProbe = (env: Record<string, string | undefined>) => Promise<ProbedQuota | null>;

// A long-lived token from `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN) may only make model requests, so the CLI
// cannot read the plan quota with it and reports none. Every model request answers with the quota in its response
// headers; a one-token request is the cheapest way to have them. It is a real request and counts against the plan.
const endpoint = 'https://api.anthropic.com/v1/messages';
const model = 'claude-haiku-5-5';
const prefix = 'anthropic-ratelimit-unified-';
// Any of these means the CLI does not answer with the subscription token, so its quota is not this session's.
const otherCredentials = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

// `5h` and `7d` are the five-hour and weekly windows; a weekly window of its own model is named after it, `7d_opus`.
function windowName(claim: string) {
  if (claim === '5h') return 'five_hour';
  if (claim === '7d') return 'seven_day';
  if (claim.startsWith('7d_')) return `seven_day_${claim.slice(3)}`;
  return undefined;
}

// Utilization comes as a fraction and the reset as Unix seconds; the CLI's own reading has percent and a timestamp.
export function quotaFromHeaders(headers: Headers): Windows {
  const windows: Windows = [];
  for (const [header, value] of headers) {
    const base = header.startsWith(prefix) ? header.match(/^(.+)-utilization$/)?.[1] : undefined;
    const name = base && windowName(base.slice(prefix.length));
    const fraction = Number(value);
    if (!name || !Number.isFinite(fraction)) continue;
    const reset = Number(headers.get(`${base}-reset`));
    windows.push({
      name,
      utilization: Math.max(0, fraction * 100),
      resetsAt: reset > 0 ? new Date(reset * 1000).toISOString() : null,
    });
  }
  return windows;
}

// One reading serves every session for a minute, as often as a long turn rereads the CLI's own quota; a failed
// probe is not retried sooner.
export function createQuotaProbe({
  fetch = globalThis.fetch,
  now = Date.now,
  intervalMs = 60_000,
  timeoutMs = 10_000,
} = {}): QuotaProbe {
  let last: { at: number; token: string; reading: Promise<ProbedQuota | null> } | undefined;
  async function probe(token: string) {
    const measuredAt = new Date(now()).toISOString();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          system: "You are Claude Code, Anthropic's official CLI for Claude.",
          messages: [{ role: 'user', content: 'quota' }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // A refused request (429 when the quota is used up) still carries the headers.
      await response.body?.cancel();
      const windows = quotaFromHeaders(response.headers);
      return windows.length ? { windows, measuredAt } : null;
    } catch {
      return null;
    }
  }
  return (env) => {
    const token = env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token || otherCredentials.some((name) => env[name])) return Promise.resolve(null);
    if (!last || last.token !== token || now() - last.at >= intervalMs)
      last = { at: now(), token, reading: probe(token) };
    return last.reading;
  };
}

export const probeQuota = createQuotaProbe();
