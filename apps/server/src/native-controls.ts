import type {
  AccountInfo,
  ModelInfo,
  Query,
  SDKRateLimitEvent,
  SDKResultMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { eventPayloadSchema } from '@cc-desk-tunnel/protocol';
import type {
  EventPayload,
  NativeCapabilities,
  NativeMetrics as Metrics,
} from '@cc-desk-tunnel/protocol';

type ContextUsage = Awaited<ReturnType<Query['getContextUsage']>>;
type UsageReading = Awaited<
  ReturnType<Query['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET']>
>;
type Windows = NonNullable<Metrics['rateLimits']>['windows'];
export type ObservedQuota = { windows: Windows; measuredAt: string };
// `seven_day_overage_included` is the weekly window of the models the plan counts apart. The response headers do not
// say which models those are, so it keeps its own name rather than one guessed after native `/usage`, which names the
// same window after the model the server calls it by.
type UnifiedWindow = { utilization?: number; resetsAt?: number };

// Who the CLI is signed in as. A reading seen under one login says nothing about another.
export function loginOf(account: AccountInfo) {
  const { apiProvider, tokenSource, apiKeySource, email, organization, subscriptionType } = account;
  return JSON.stringify([
    apiProvider,
    tokenSource,
    apiKeySource,
    email,
    organization,
    subscriptionType,
  ]);
}

// The CLI passes on the quota its own model requests were answered with as `rate_limit_event`. A login with
// CLAUDE_CODE_OAUTH_TOKEN may not read the plan quota through `/usage`, but its requests carry it all the same.
// `unifiedWindows` names every window of the response; it is not in the SDK's published type. Without it the event
// speaks for one window. Utilization comes as a fraction and the reset as Unix seconds.
export function observedQuota(
  event: SDKRateLimitEvent,
  previous: ObservedQuota | null,
  now = Date.now(),
): ObservedQuota | null {
  const info = event.rate_limit_info as SDKRateLimitEvent['rate_limit_info'] & {
    unifiedWindows?: Record<string, UnifiedWindow | undefined>;
  };
  const named: [string, UnifiedWindow | undefined][] = info.unifiedWindows
    ? Object.entries(info.unifiedWindows)
    : info.rateLimitType && info.rateLimitType !== 'overage'
      ? [[info.rateLimitType, info]]
      : [];
  const windows = named.flatMap(([name, window]) =>
    window && Number.isFinite(window.utilization)
      ? [
          {
            name,
            utilization: Math.max(0, window.utilization! * 100),
            resetsAt: window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : null,
          },
        ]
      : [],
  );
  return merged(windows, previous, now);
}

// A window a reading leaves out keeps its last reading until it resets (see `unexpired`).
function merged(windows: Windows, previous: ObservedQuota | null, now: number) {
  if (!windows.length) return null;
  const kept = (previous?.windows ?? []).filter(
    (window) => !windows.some((row) => row.name === window.name),
  );
  return { windows: [...kept, ...windows], measuredAt: new Date(now).toISOString() };
}

// The quota the CLI hands its status line (`rate_limits`, CLI 2.1.293), from the same replies as `rate_limit_event`:
// the session and weekly windows, in percent, with resets in Unix seconds; one without a reset could not be told from
// one that has passed (see `unexpired`). A terminal has no message stream to carry the event, so this is how its
// replies' quota is heard (see `terminalSettings`).
export function statusLineQuota(status: unknown): Windows {
  const limits = (status as { rate_limits?: Record<string, unknown> } | null)?.rate_limits;
  return ['five_hour', 'seven_day'].flatMap((name) => {
    const window = limits?.[name] as { used_percentage?: unknown; resets_at?: unknown } | undefined;
    return typeof window?.used_percentage === 'number' &&
      Number.isFinite(window.used_percentage) &&
      typeof window.resets_at === 'number'
      ? [
          {
            name,
            utilization: Math.max(0, window.used_percentage),
            resetsAt: new Date(window.resets_at * 1000).toISOString(),
          },
        ]
      : [];
  });
}

// The quota last seen in the message stream, kept by the login it came under (see `loginOf`). A project whose
// settings sign in otherwise (an API key, another token) keeps apart, and a run still going under a login since
// replaced writes to its own, not to the new one's.
export class ObservedQuotas {
  private readings = new Map<string, ObservedQuota>();
  of(login: string) {
    return this.readings.get(login) ?? null;
  }
  observe(login: string, event: SDKRateLimitEvent, now = Date.now()) {
    const reading = observedQuota(event, this.of(login), now);
    if (reading) this.readings.set(login, reading);
  }
  observeWindows(login: string, windows: Windows, now = Date.now()) {
    const reading = merged(windows, this.of(login), now);
    if (reading) this.readings.set(login, reading);
  }
  // What was heard before the login was known becomes that login's, unless it has its own.
  adopt(from: string, to: string) {
    const reading = this.readings.get(from);
    this.readings.delete(from);
    if (reading && !this.readings.has(to)) this.readings.set(to, reading);
  }
}

// A stored reading outlives its window: once the reset time passes, the figure no longer holds. The CLI drops such
// windows from `unifiedWindows` the same way; a window without a reset time cannot be told apart and is dropped too.
export function unexpired(observed: ObservedQuota | null, now = Date.now()): ObservedQuota | null {
  const windows = (observed?.windows ?? []).filter(
    (window) => window.resetsAt !== null && Date.parse(window.resetsAt) > now,
  );
  return windows.length ? { ...observed!, windows } : null;
}

// The plan quota as the CLI's `/usage` data gives it, as of `measuredAt`.
function planQuota(usage: UsageReading, measuredAt: string): NonNullable<Metrics['rateLimits']> {
  const windows = usage.rate_limits
    ? Object.entries(usage.rate_limits).flatMap(([name, value]) => {
        if (!value || name === 'extra_usage') return [];
        // Per-model weekly rows (a Max plan's Fable limit) are named after the weekly window they belong to.
        if (name === 'model_scoped' && Array.isArray(value))
          return value.map((item) => ({
            name: `seven_day:${item.display_name}`,
            utilization: item.utilization,
            resetsAt: item.resets_at,
          }));
        if (!Array.isArray(value) && 'utilization' in value && 'resets_at' in value)
          return [{ name, utilization: value.utilization, resetsAt: value.resets_at }];
        return [];
      })
    : [];
  return { available: usage.rate_limits_available, windows, measuredAt };
}

// What a reading gets of the quota: what the service holds, why a read it made failed, and the CLI's whole
// answer if that CLI was the one asked, whose session totals are then this session's.
export type QuotaAnswer = {
  rateLimits: Metrics['rateLimits'];
  error?: string;
  usage?: UsageReading;
};

// The plan quota is the account's, not a session's: the service holds one per login, and every session and device
// reads it here. Most of it comes with the replies: the CLI passes on the quota every model response carries
// (`rate_limit_event`) whenever it moves, at no cost. A read adds what only `/usage` gives (the per-model rows, and
// whether the plan quota applies at all) and stands in where nothing is being answered. It is a request of its own
// to the account's usage endpoint (`GET /api/oauth/usage` in the CLI), which answers each account only so often, so
// only the service decides when: at most once a minute, through whichever CLI is at hand then, and only while a
// connected client wants the quota kept current (`wanted`) or the user asks.
export class Quotas {
  wanted: () => boolean = () => true;
  private readonly interval: number;
  private observed = new ObservedQuotas();
  private reads = new Map<
    string,
    { at: number; rateLimits: Metrics['rateLimits']; pending?: Promise<unknown> }
  >();
  // The login last seen in a run or a read. A terminal's CLI does not say whom it is signed in as; it is the service's
  // own CLI configuration, so it is taken to be this one.
  private login?: string;
  constructor(interval = 60_000) {
    this.interval = interval;
  }
  private heard(login: string) {
    if (this.login === undefined) this.observed.adopt('', login);
    this.login = login;
  }
  observe(login: string, event: SDKRateLimitEvent, now = Date.now()) {
    this.heard(login);
    this.observed.observe(login, event, now);
  }
  // The windows a terminal's status line showed (see `statusLineQuota`), and the quota as it now stands.
  observeTerminal(windows: Windows, now = Date.now()) {
    const login = this.login ?? '';
    this.observed.observeWindows(login, windows, now);
    return this.of(login, now);
  }
  // Reads anew through `query` when asked or due; a read under way is waited for instead.
  async through(
    login: string,
    query: Query,
    { asked = false, timeoutMs = 5000, now = Date.now() } = {},
  ): Promise<QuotaAnswer> {
    this.heard(login);
    const held = this.reads.get(login);
    if (held?.pending) await held.pending;
    else if (asked || (this.wanted() && (!held || now - held.at >= this.interval))) {
      const measuredAt = new Date(now).toISOString();
      const entry: { at: number; rateLimits: Metrics['rateLimits']; pending?: Promise<unknown> } = {
        at: now,
        rateLimits: held?.rateLimits ?? null,
      };
      this.reads.set(login, entry);
      const pending = optionalStatus(
        () =>
          query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
        timeoutMs,
      );
      entry.pending = pending;
      const { value, error } = await pending;
      entry.pending = undefined;
      // A failed read keeps the last reading, which says how old it is.
      if (value) entry.rateLimits = planQuota(value, measuredAt);
      return { rateLimits: this.of(login, now), error, ...(value ? { usage: value } : {}) };
    }
    return { rateLimits: this.of(login, now) };
  }
  // The windows the replies carried since the last read replace those of the read, which keeps the rest. Where the
  // CLI says the plan quota does not apply, as with a login by CLAUDE_CODE_OAUTH_TOKEN, the replies are all there is.
  of(login: string, now = Date.now()): Metrics['rateLimits'] {
    const read = this.reads.get(login)?.rateLimits ?? null;
    const observed = unexpired(this.observed.of(login), now);
    if (!observed) return read;
    if (!read?.available) return { available: true, ...observed };
    if (observed.measuredAt <= read.measuredAt!) return read;
    const carried = new Map(observed.windows.map((window) => [window.name, window]));
    return {
      available: true,
      windows: [
        ...read.windows.map((window) => carried.get(window.name) ?? window),
        ...observed.windows.filter(
          (window) => !read.windows.some((row) => row.name === window.name),
        ),
      ],
      measuredAt: observed.measuredAt,
    };
  }
}

export function nativeCapabilities(
  models: ModelInfo[],
  account: AccountInfo,
  commands: SlashCommand[],
  configuredModel?: string,
  // Commands whose use is bound to the CLI's own terminal, as the CLI names them.
  terminal: string[] = [],
): EventPayload {
  const usable = commands.filter((command) => !terminal.includes(command.name));
  const catalog: NativeCapabilities['models'] = models.map((model) => ({
    value: model.value,
    resolvedModel: model.resolvedModel,
    displayName: model.displayName,
    description: model.description,
    source: 'native',
    supportedEffortLevels: model.supportedEffortLevels ?? [],
  }));
  if (
    configuredModel &&
    !catalog.some(
      (model) =>
        model.value === configuredModel ||
        models.find((row) => row.value === model.value)?.resolvedModel === configuredModel,
    )
  )
    catalog.unshift({
      value: configuredModel,
      displayName: configuredModel,
      description: '',
      source: 'configured',
      supportedEffortLevels: [],
    });
  // Send named public identity fields only; no credentials or arbitrary initialization payload.
  return eventPayloadSchema.parse({
    type: 'native.capabilities',
    models: catalog,
    commands: usable.map((command) => command.name),
    commandDetails: usable.map(({ name, description, argumentHint, aliases }) => ({
      name,
      description: description ?? '',
      argumentHint: argumentHint ?? '',
      ...(aliases?.length ? { aliases } : {}),
    })),
    account: {
      email: account.email,
      organization: account.organization,
      subscriptionType: account.subscriptionType,
      apiProvider: account.apiProvider,
      apiKeySource: account.apiKeySource,
      tokenSource: account.tokenSource,
    },
  });
}

export function resultUsage(result: SDKResultMessage): Metrics['usage'] {
  if (!result.modelUsage) return null;
  const values = Object.values(result.modelUsage);
  return {
    costUsd: Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null,
    inputTokens: values.reduce((sum, value) => sum + value.inputTokens, 0),
    outputTokens: values.reduce((sum, value) => sum + value.outputTokens, 0),
    cacheReadTokens: values.reduce((sum, value) => sum + value.cacheReadInputTokens, 0),
    cacheWriteTokens: values.reduce((sum, value) => sum + value.cacheCreationInputTokens, 0),
    ...lifetimes(values),
    measuredAt: new Date().toISOString(),
  };
}
// The cache writes by lifetime, from a CLI that counts them so.
function lifetimes(values: NonNullable<SDKResultMessage['modelUsage']>[string][]) {
  if (!values.some((value) => value.cacheCreationEphemeral1hInputTokens !== undefined)) return {};
  const sum = (
    key: 'cacheCreationEphemeral1hInputTokens' | 'cacheCreationEphemeral5mInputTokens',
  ) => values.reduce((total, value) => total + (value[key] ?? 0), 0);
  return {
    cacheWrite1hTokens: sum('cacheCreationEphemeral1hInputTokens'),
    cacheWrite5mTokens: sum('cacheCreationEphemeral5mInputTokens'),
  };
}

async function optionalStatus<T>(
  read: () => Promise<T>,
  timeoutMs: number,
): Promise<{ value: T | null; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(read)
        .then(
          (value) => ({ value }),
          () => ({ value: null, error: '原生接口读取失败' }),
        ),
      new Promise<{ value: null; error: string }>((resolve) => {
        timer = setTimeout(() => resolve({ value: null, error: '原生接口读取超时' }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function contextSummary(context: ContextUsage | null): Metrics['context'] {
  return context && context.rawMaxTokens > 0
    ? {
        model: context.model,
        usedTokens: context.totalTokens,
        windowTokens: context.rawMaxTokens,
        percentage: context.percentage,
        measuredAt: new Date().toISOString(),
        categories: context.categories.map(({ id, name, tokens, kind }) => ({
          ...(id && { id }),
          name,
          tokens,
          kind,
        })),
      }
    : null;
}

// `quota` gets the plan quota (see `Quotas`); without it this CLI is asked directly. `previous` holds the session
// totals for a reading that brings none of its own.
export async function nativeMetrics(
  query: Query,
  result?: SDKResultMessage,
  {
    timeoutMs = 5000,
    quota = (query) => new Quotas().through('', query, { asked: true, timeoutMs }),
    previous = null,
  }: {
    timeoutMs?: number;
    quota?: (query: Query) => Promise<QuotaAnswer>;
    previous?: Metrics['usage'];
  } = {},
): Promise<EventPayload> {
  const [contextStatus, answer] = await Promise.all([
    optionalStatus(() => query.getContextUsage({ detail: 'summary' }), timeoutMs),
    quota(query),
  ]);
  const totals =
    result ??
    (answer.usage?.session
      ? ({
          total_cost_usd: answer.usage.session.total_cost_usd,
          modelUsage: answer.usage.session.model_usage,
        } as SDKResultMessage)
      : undefined);
  return eventPayloadSchema.parse({
    type: 'native.metrics',
    context: contextSummary(contextStatus.value),
    usage: totals ? resultUsage(totals) : previous,
    rateLimits: answer.rateLimits,
    ...(contextStatus.error || answer.error
      ? {
          errors: { context: contextStatus.error, usage: answer.error },
        }
      : {}),
  });
}
