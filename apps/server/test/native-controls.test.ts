import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Query, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  nativeCapabilities,
  nativeContextRefresh,
  nativeMetrics,
  resultUsage,
} from '../src/native-controls.ts';

test('native model and account mapping preserves capability boundaries and does not pass through secrets', () => {
  const capabilities = nativeCapabilities(
    [
      {
        value: 'sonnet',
        displayName: 'Sonnet',
        description: 'native',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
      },
    ],
    {
      email: 'test@example.invalid',
      apiProvider: 'firstParty',
      apiKeySource: 'environment',
      secret: 'must-not-leave-sdk',
    } as never,
    ['compact', 'context'],
    'deepseek-chat',
  );
  assert.ok(capabilities.type === 'native.capabilities');
  assert.equal(capabilities.models[0].source, 'configured');
  assert.deepEqual(capabilities.models[0].supportedEffortLevels, []);
  assert.deepEqual(capabilities.models[1].supportedEffortLevels, ['low', 'high']);
  assert.equal(JSON.stringify(capabilities).includes('must-not-leave-sdk'), false);
});

test('context comes from the native summary and is distinct from cumulative usage totals', async () => {
  let detail: unknown, skip: unknown;
  const query = {
    async getContextUsage(options: unknown) {
      detail = options;
      return {
        model: 'test',
        totalTokens: 2500,
        rawMaxTokens: 10000,
        percentage: 25,
        categories: [{ name: 'Messages', tokens: 2500, kind: 'used' }],
      };
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options: unknown) {
      skip = options;
      return { rate_limits_available: false, rate_limits: null };
    },
  } as unknown as Query;
  const result = {
    total_cost_usd: 0.5,
    modelUsage: {
      test: {
        inputTokens: 100000,
        outputTokens: 500,
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 500,
      },
    },
  } as unknown as SDKResultMessage;
  const metrics = await nativeMetrics(query, result);
  assert.ok(metrics.type === 'native.metrics');
  assert.equal(metrics.context?.usedTokens, 2500);
  assert.equal(metrics.context?.percentage, 25);
  assert.equal(metrics.usage?.inputTokens, 100000);
  assert.equal(metrics.usage?.costUsd, 0.5);
  assert.deepEqual(detail, { detail: 'summary' });
  assert.deepEqual(skip, { skipBehaviors: true });
  assert.equal(metrics.rateLimits?.available, false);
  assert.deepEqual(metrics.rateLimits?.windows, []);
  assert.ok(metrics.rateLimits?.measuredAt);
});

test('unavailable native telemetry stays unavailable rather than fabricating quotas or context', async () => {
  const query = {
    async getContextUsage() {
      throw new Error('unsupported');
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      throw new Error('unavailable');
    },
  } as unknown as Query;
  const metrics = await nativeMetrics(query);
  assert.deepEqual(metrics, {
    type: 'native.metrics',
    context: null,
    usage: null,
    rateLimits: null,
    errors: { context: '原生接口读取失败', usage: '原生接口读取失败' },
  });
  assert.equal(resultUsage({} as SDKResultMessage), null);
});

test('optional native telemetry has a bounded wait and cannot hold a completed turn indefinitely', async () => {
  const query = {
    getContextUsage() {
      return new Promise(() => {});
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      return { rate_limits_available: false, rate_limits: null };
    },
  } as unknown as Query;
  const metrics = await nativeMetrics(query, undefined, 10);
  assert.ok(metrics.type === 'native.metrics');
  assert.equal(metrics.context, null);
  assert.equal(metrics.rateLimits?.available, false);
  assert.deepEqual(metrics.rateLimits?.windows, []);
  assert.equal(metrics.errors?.context, '原生接口读取超时');
});

test('native additive quota arrays cannot hide all account and context metrics', async () => {
  const query = {
    async getContextUsage() {
      return {
        model: 'opus',
        totalTokens: 1000,
        rawMaxTokens: 1000000,
        percentage: 0.1,
        categories: [],
      };
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      return {
        rate_limits_available: true,
        session: {
          total_cost_usd: 0.3,
          model_usage: {
            opus: {
              inputTokens: 100,
              outputTokens: 20,
              cacheReadInputTokens: 30,
              cacheCreationInputTokens: 40,
            },
          },
        },
        rate_limits: {
          five_hour: { utilization: 3, resets_at: '2026-10-03T02:00:00Z' },
          seven_day: { utilization: 0, resets_at: '2026-10-10T02:00:00Z' },
          limits: [{ type: 'five_hour', status: 'allowed', utilization: 0.03 }],
          spend: { balance: 0 },
          future: [1, 2, 3],
        },
      };
    },
  } as unknown as Query;
  const metrics = await nativeMetrics(query);
  assert.ok(metrics.type === 'native.metrics');
  assert.equal(metrics.context?.windowTokens, 1000000);
  assert.equal(metrics.usage?.inputTokens, 100);
  assert.equal(metrics.rateLimits?.windows.length, 2);
  assert.equal(metrics.rateLimits?.windows[0].utilization, 3);
});

test('a mid-turn refresh updates only context and keeps the last native quota reading', async () => {
  let usageReads = 0,
    total = 1000;
  const query = {
    async getContextUsage() {
      return {
        model: 'opus',
        totalTokens: total,
        rawMaxTokens: 10000,
        percentage: total / 100,
        categories: [],
      };
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      usageReads++;
      return {
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 24, resets_at: '2026-10-05T20:20:00Z' } },
      };
    },
  } as unknown as Query;
  const first = await nativeMetrics(query);
  assert.ok(first.type === 'native.metrics');
  total = 4000;
  const refreshed = await nativeContextRefresh(query, first);
  assert.equal(refreshed?.context?.usedTokens, 4000);
  assert.deepEqual(refreshed?.rateLimits, first.rateLimits);
  assert.equal(usageReads, 1);
  const failing = {
    async getContextUsage() {
      throw new Error('busy');
    },
  } as unknown as Query;
  assert.equal(await nativeContextRefresh(failing, first), null);
});

test('a resolved native model remains native instead of appearing as provider configuration', () => {
  const event = nativeCapabilities(
    [
      {
        value: 'opus',
        resolvedModel: 'claude-opus-5-5',
        displayName: 'Opus',
        description: 'native',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high', 'xhigh'],
      },
    ],
    {},
    [],
    'claude-opus-5-5',
  );
  assert.ok(event.type === 'native.capabilities');
  assert.equal(event.models.length, 1);
  assert.equal(event.models[0].source, 'native');
  assert.equal(event.models[0].resolvedModel, 'claude-opus-5-5');
});

test('new models and their effort levels pass through the native catalog without a host allowlist', () => {
  const models = [
    {
      value: 'haiku',
      resolvedModel: 'claude-haiku-5-5',
      displayName: 'Haiku',
      description: 'native',
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
    },
    { value: 'future-native-model', displayName: 'New model', description: 'native' },
  ];
  const result = nativeCapabilities(models as never, {}, [], 'claude-haiku-5-5');
  assert.ok(result.type === 'native.capabilities');
  assert.deepEqual(
    result.models.map(({ value }) => value),
    ['haiku', 'future-native-model'],
  );
  assert.equal(result.models[0].resolvedModel, 'claude-haiku-5-5');
  assert.deepEqual(result.models[0].supportedEffortLevels, [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
});

test('concurrent quota readings keep request order even when the older one finishes last', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-08T12:00:00Z') });
  let release!: () => void;
  const wait = new Promise<null>((resolve) => {
    release = () => resolve(null);
  });
  const query = (context: Promise<null>) =>
    ({
      getContextUsage: () => context,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        rate_limits_available: false,
        rate_limits: null,
      }),
    }) as unknown as Query;
  const first = nativeMetrics(query(wait));
  t.mock.timers.tick(100);
  const second = await nativeMetrics(query(Promise.resolve(null)));
  release();
  const older = await first;
  assert.ok(older.type === 'native.metrics' && second.type === 'native.metrics');
  assert.ok(older.rateLimits!.measuredAt! < second.rateLimits!.measuredAt!);
});

test('native quota windows retain reset times and per-model rows without exposing spend credentials', async () => {
  const query = {
    async getContextUsage() {
      return null;
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      return {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 37, resets_at: '2026-10-02T15:00:00Z' },
          seven_day: { utilization: 12, resets_at: '2026-10-09T15:00:00Z' },
          model_scoped: [
            { display_name: 'Fable', utilization: 41, resets_at: '2026-10-09T15:00:00Z' },
            { display_name: 'Test model', utilization: null, resets_at: null },
          ],
          extra_usage: { is_enabled: true, used_credits: 1234 },
        },
      };
    },
  } as unknown as Query;
  const metrics = await nativeMetrics(query);
  assert.ok(metrics.type === 'native.metrics');
  assert.deepEqual(metrics.rateLimits?.windows, [
    { name: 'five_hour', utilization: 37, resetsAt: '2026-10-02T15:00:00Z' },
    { name: 'seven_day', utilization: 12, resetsAt: '2026-10-09T15:00:00Z' },
    { name: 'seven_day:Fable', utilization: 41, resetsAt: '2026-10-09T15:00:00Z' },
    { name: 'seven_day:Test model', utilization: null, resetsAt: null },
  ]);
});
