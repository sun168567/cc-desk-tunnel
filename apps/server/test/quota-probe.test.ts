import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { nativeMetrics } from '../src/native-controls.ts';
import { createQuotaProbe, quotaFromHeaders } from '../src/quota-probe.ts';

const quotaHeaders = {
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.42',
  'anthropic-ratelimit-unified-5h-reset': '1792000000',
  'anthropic-ratelimit-unified-7d-utilization': '0.1',
  'anthropic-ratelimit-unified-7d-reset': '1792500000',
  'anthropic-ratelimit-unified-7d_opus-utilization': '0.3',
  'anthropic-ratelimit-unified-overage-utilization': '0',
};

function fakeFetch(status = 200, headers: Record<string, string> = quotaHeaders) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init! });
    return new Response('{}', { status, headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

test('the quota headers become the windows the CLI names, in percent with timestamps', () => {
  assert.deepEqual(quotaFromHeaders(new Headers(quotaHeaders)), [
    { name: 'five_hour', utilization: 42, resetsAt: '2026-10-14T17:46:40.000Z' },
    { name: 'seven_day', utilization: 10, resetsAt: '2026-10-20T12:40:00.000Z' },
    { name: 'seven_day_opus', utilization: 30, resetsAt: null },
  ]);
  assert.deepEqual(quotaFromHeaders(new Headers({ 'content-type': 'application/json' })), []);
});

test('a probe is one single-token request with the subscription token', async () => {
  const { fetch, requests } = fakeFetch();
  const probe = createQuotaProbe({ fetch, now: () => 0 });
  const reading = await probe({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' });
  assert.equal(reading?.windows.length, 3);
  assert.equal(reading?.measuredAt, new Date(0).toISOString());
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages');
  const headers = requests[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer sk-ant-oat01-test');
  assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(JSON.parse(String(requests[0].init.body)).max_tokens, 1);
});

test('no token, or credentials the CLI would use instead, means no request', async () => {
  const { fetch, requests } = fakeFetch();
  const probe = createQuotaProbe({ fetch });
  assert.equal(await probe({}), null);
  assert.equal(await probe({ CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' }), null);
  assert.equal(
    await probe({ CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://api.example.com' }),
    null,
  );
  assert.equal(requests.length, 0);
});

test('one reading serves every caller for the interval, a failed one too', async () => {
  let time = 0;
  const { fetch, requests } = fakeFetch(401, {});
  const probe = createQuotaProbe({ fetch, now: () => time, intervalMs: 60_000 });
  const env = { CLAUDE_CODE_OAUTH_TOKEN: 't' };
  assert.deepEqual(await Promise.all([probe(env), probe(env)]), [null, null]);
  time = 59_999;
  await probe(env);
  assert.equal(requests.length, 1);
  time = 60_000;
  await probe(env);
  assert.equal(requests.length, 2);
  await probe({ CLAUDE_CODE_OAUTH_TOKEN: 'another' });
  assert.equal(requests.length, 3);
});

test('a used-up quota is still read from the refused request', async () => {
  const { fetch } = fakeFetch(429);
  const reading = await createQuotaProbe({ fetch })({ CLAUDE_CODE_OAUTH_TOKEN: 't' });
  assert.equal(reading?.windows[0].utilization, 42);
});

function usageQuery(available: boolean) {
  return {
    async getContextUsage() {
      throw new Error('unsupported');
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      return {
        rate_limits_available: available,
        rate_limits: available
          ? { five_hour: { utilization: 7, resets_at: '2026-10-03T02:00:00Z' } }
          : null,
      };
    },
  } as unknown as Query;
}

test('the probe fills in the quota only when the CLI says the plan quota does not apply', async () => {
  let probes = 0;
  const probe = async () => {
    probes++;
    return {
      windows: [{ name: 'five_hour', utilization: 42, resetsAt: null }],
      measuredAt: '2026-10-01T00:00:00.000Z',
    };
  };
  const filled = await nativeMetrics(usageQuery(false), undefined, { probe });
  assert.ok(filled.type === 'native.metrics');
  assert.deepEqual(filled.rateLimits, {
    available: true,
    windows: [{ name: 'five_hour', utilization: 42, resetsAt: null }],
    measuredAt: '2026-10-01T00:00:00.000Z',
  });
  const native = await nativeMetrics(usageQuery(true), undefined, { probe });
  assert.ok(native.type === 'native.metrics');
  assert.equal(native.rateLimits?.windows[0].utilization, 7);
  assert.equal(probes, 1);
  const failed = await nativeMetrics(usageQuery(false), undefined, { probe: async () => null });
  assert.ok(failed.type === 'native.metrics');
  assert.equal(failed.rateLimits?.available, false);
});
