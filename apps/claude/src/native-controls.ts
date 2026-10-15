import type {
  AccountInfo,
  ModelInfo,
  Query,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { eventPayloadSchema } from '@cc-desk-tunnel/protocol';
import type {
  EventPayload,
  NativeCapabilities,
  NativeMetrics as Metrics,
} from '@cc-desk-tunnel/protocol';

type ContextUsage = Awaited<ReturnType<Query['getContextUsage']>>;

export function nativeCapabilities(
  models: ModelInfo[],
  account: AccountInfo,
  commands: string[],
  configuredModel?: string,
): EventPayload {
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
    commands,
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
    measuredAt: new Date().toISOString(),
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
        categories: context.categories.map(({ name, tokens, kind }) => ({ name, tokens, kind })),
      }
    : null;
}

// Mid-turn refresh: only the context changes with each model call; quota and totals keep their last native reading.
export async function nativeContextRefresh(
  query: Query,
  previous: Metrics,
  timeoutMs = 5000,
): Promise<Metrics | null> {
  const context = contextSummary(
    (await optionalStatus(() => query.getContextUsage({ detail: 'summary' }), timeoutMs)).value,
  );
  if (!context) return null;
  return {
    type: 'native.metrics',
    context,
    usage: previous.usage,
    rateLimits: previous.rateLimits,
    ...(previous.errors?.usage ? { errors: { usage: previous.errors.usage } } : {}),
  };
}

export async function nativeMetrics(
  query: Query,
  result?: SDKResultMessage,
  timeoutMs = 5000,
): Promise<EventPayload> {
  // Order readings by when they were requested, not when concurrent status calls happened to finish.
  const measuredAt = new Date().toISOString();
  const [contextStatus, usageStatus] = await Promise.all([
    optionalStatus(() => query.getContextUsage({ detail: 'summary' }), timeoutMs),
    optionalStatus(
      () =>
        query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      timeoutMs,
    ),
  ]);
  const context = contextStatus.value,
    usage = usageStatus.value;
  const windows = usage?.rate_limits
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
  const totals =
    result ??
    (usage?.session
      ? ({
          total_cost_usd: usage.session.total_cost_usd,
          modelUsage: usage.session.model_usage,
        } as SDKResultMessage)
      : undefined);
  return eventPayloadSchema.parse({
    type: 'native.metrics',
    context: contextSummary(context),
    usage: totals ? resultUsage(totals) : null,
    rateLimits: usage ? { available: usage.rate_limits_available, windows, measuredAt } : null,
    ...(contextStatus.error || usageStatus.error
      ? {
          errors: { context: contextStatus.error, usage: usageStatus.error },
        }
      : {}),
  });
}
