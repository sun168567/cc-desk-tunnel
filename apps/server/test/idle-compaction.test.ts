import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EventPayload } from '@cc-desk-tunnel/protocol';
import {
  IDLE_COMPACTION,
  IdleCompactions,
  cacheTtl,
  cacheWrites,
  compactionDue,
  readIdleCompaction,
  writeIdleCompaction,
} from '../src/idle-compaction.ts';
import { SessionStore } from '../src/store.ts';
import { Quotas, loginOf } from '../src/native-controls.ts';

type Metrics = Extract<EventPayload, { type: 'native.metrics' }>;
const MINUTE = 60_000;
function metrics(usedTokens: number, ttl?: '5m' | '1h'): Metrics {
  return {
    type: 'native.metrics',
    context: {
      model: 'claude-opus-5-5',
      usedTokens,
      windowTokens: 1_000_000,
      percentage: usedTokens / 10_000,
      measuredAt: new Date(0).toISOString(),
      categories: [],
    },
    usage: null,
    rateLimits: null,
    ...(ttl ? { cacheTtl: ttl } : {}),
  };
}
function directory(t: { after: (fn: () => void) => void }) {
  const path = mkdtempSync(join(tmpdir(), 'idle-compaction-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('a turn says how long its cache lasts by what its requests wrote', () => {
  assert.equal(
    cacheTtl({ cache_creation: { ephemeral_1h_input_tokens: 900, ephemeral_5m_input_tokens: 40 } }),
    '1h',
  );
  assert.equal(
    cacheTtl({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 40 } }),
    '5m',
  );
  // Read from the cache only, or no breakdown: not known.
  assert.equal(cacheTtl({ cache_creation: { ephemeral_1h_input_tokens: 0 } }), undefined);
  assert.equal(cacheTtl({ cache_creation: null }), undefined);
  assert.equal(cacheTtl(undefined), undefined);
});

test('an idle session is due afterMinutes after its turn, only with a one-hour cache and a large context', () => {
  const on = { ...IDLE_COMPACTION, enabled: true };
  assert.equal(compactionDue(on, 1000, metrics(150_000, '1h')), 1000 + 50 * MINUTE);
  assert.equal(compactionDue(IDLE_COMPACTION, 1000, metrics(150_000, '1h')), null, 'off');
  assert.equal(compactionDue(on, 1000, metrics(150_000, '5m')), null, 'five-minute cache');
  assert.equal(compactionDue(on, 1000, metrics(150_000)), null, 'cache not known');
  assert.equal(compactionDue(on, 1000, metrics(99_999, '1h')), null, 'small context');
  assert.equal(compactionDue({ ...on, afterMinutes: 30 }, 0, metrics(100_000, '1h')), 30 * MINUTE);
});

test('the setting is kept with the sessions; a file that cannot be read is the defaults', (t) => {
  const path = directory(t);
  assert.deepEqual(readIdleCompaction(path), IDLE_COMPACTION);
  assert.deepEqual(writeIdleCompaction(path, { enabled: true, afterMinutes: 45 }), {
    ...IDLE_COMPACTION,
    enabled: true,
    afterMinutes: 45,
  });
  assert.equal(readIdleCompaction(path).afterMinutes, 45);
  // The cache lapses at an hour: a compaction after it would read the whole context anew.
  assert.throws(() => writeIdleCompaction(path, { afterMinutes: 60 }));
  assert.equal(readIdleCompaction(path).afterMinutes, 45);
  writeFileSync(join(path, 'idle-compaction.json'), '{');
  assert.deepEqual(readIdleCompaction(path), IDLE_COMPACTION);
});

test('a session is compacted once when due, not after a message, and not once its cache is about to lapse', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const path = directory(t);
  const fired: string[] = [];
  const compactions = new IdleCompactions(
    path,
    (sessionId) => fired.push(sessionId),
    () => null,
  );
  compactions.update({ enabled: true });
  compactions.arm('a', 0, metrics(150_000, '1h'), 0);
  compactions.arm('b', 0, metrics(150_000, '1h'), 0);
  compactions.arm('small', 0, metrics(10_000, '1h'), 0);
  assert.equal(compactions.armed('small'), false);
  compactions.cancel('b');
  t.mock.timers.tick(50 * MINUTE - 1);
  assert.deepEqual(fired, []);
  t.mock.timers.tick(1);
  assert.deepEqual(fired, ['a']);
  assert.equal(compactions.armed('a'), false);
  // As after a restart: past its time but with the cache still there, at once; within a minute of the hour, not at all.
  compactions.arm('due', 0, metrics(150_000, '1h'), 57 * MINUTE);
  t.mock.timers.tick(0);
  assert.deepEqual(fired, ['a', 'due']);
  compactions.arm('late', 0, metrics(150_000, '1h'), 59 * MINUTE);
  assert.equal(compactions.armed('late'), false);
  // Turning it off clears what was set.
  compactions.arm('c', 50 * MINUTE, metrics(150_000, '1h'), 50 * MINUTE);
  compactions.update({ enabled: false });
  t.mock.timers.tick(60 * MINUTE);
  assert.deepEqual(fired, ['a', 'due']);
});

test('quota resets postpone idle compaction only while the original cache remains usable', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const quotas = new Quotas();
  const reading = (resetsAt: number) => ({
    available: true,
    windows: [{ name: 'five_hour', utilization: 100, resetsAt: new Date(resetsAt).toISOString() }],
  });
  const fired: string[] = [];
  const compactions = new IdleCompactions(
    directory(t),
    (id) => fired.push(id),
    (id) => quotas.blockedUntil(id, reading((id === 'soon' ? 55 : 65) * MINUTE)),
  );
  t.after(() => compactions.clear());
  compactions.update({ enabled: true });
  for (const id of ['soon', 'expired']) compactions.arm(id, 0, metrics(150_000, '1h'));
  assert.equal(compactions.armed('expired'), false);
  t.mock.timers.tick(50 * MINUTE);
  assert.deepEqual(fired, []);
  t.mock.timers.tick(5 * MINUTE - 1);
  assert.deepEqual(fired, []);
  t.mock.timers.tick(1);
  assert.deepEqual(fired, ['soon']);
  t.mock.timers.tick(10 * MINUTE);
  assert.deepEqual(fired, ['soon'], 'no full-price catch-up after the cache expires');
});

test('a limit reached after arming is rechecked at the deadline and at a changed reset time', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const quotas = new Quotas();
  const fired: string[] = [];
  const compactions = new IdleCompactions(
    directory(t),
    (id) => fired.push(id),
    () => quotas.blockedUntil('same-account', null),
  );
  t.after(() => compactions.clear());
  compactions.update({ enabled: true });
  for (const id of ['waiting', 'cancelled']) compactions.arm(id, 0, metrics(150_000, '1h'));
  const reject = (minutes: number) =>
    quotas.observe('same-account', {
      type: 'rate_limit_event',
      uuid: randomUUID(),
      session_id: 'other-session',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: minutes * 60 },
    });
  // Another session exhausts the account while the timer is waiting. The rejection need not carry a percentage.
  t.mock.timers.tick(49 * MINUTE);
  reject(55);
  t.mock.timers.tick(MINUTE);
  assert.deepEqual(fired, []);
  assert.equal(compactions.armed('waiting'), true);
  compactions.cancel('cancelled');
  reject(57);
  t.mock.timers.tick(5 * MINUTE);
  assert.deepEqual(fired, []);
  t.mock.timers.tick(2 * MINUTE);
  assert.deepEqual(fired, ['waiting']);
});

test('a deferred compaction is dropped at the cache margin, for an unknown reset, or when disabled', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let blocked: number | null = null;
  const fired: string[] = [];
  const compactions = new IdleCompactions(
    directory(t),
    (id) => fired.push(id),
    () => blocked,
  );
  t.after(() => compactions.clear());
  compactions.update({ enabled: true });
  compactions.arm('margin', 0, metrics(150_000, '1h'));
  blocked = 59 * MINUTE;
  t.mock.timers.tick(50 * MINUTE);
  assert.equal(compactions.armed('margin'), false);
  blocked = Infinity;
  compactions.arm('unknown-reset', 0, metrics(150_000, '1h'));
  assert.equal(compactions.armed('unknown-reset'), false);
  blocked = 55 * MINUTE;
  compactions.arm('disabled', 0, metrics(150_000, '1h'));
  compactions.update({ enabled: false });
  t.mock.timers.tick(10 * MINUTE);
  assert.deepEqual(fired, []);
});

test('restart restores quota scheduling even after a context-only reading', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const path = directory(t);
  let store = new SessionStore(path);
  const session = store.create(randomUUID(), '限额会话', '/tmp/project', {
    id: randomUUID(),
    name: '测试设备',
  });
  const account = { email: 'quota@example.invalid', apiProvider: 'firstParty' };
  store.append(session.id, 'run', {
    type: 'native.capabilities',
    models: [],
    commands: [],
    account,
  });
  store.append(session.id, 'run', {
    ...metrics(150_000, '1h'),
    rateLimits: {
      available: true,
      windows: [
        { name: 'five_hour', utilization: 100, resetsAt: new Date(55 * MINUTE).toISOString() },
      ],
    },
  });
  store.append(session.id, 'read', metrics(150_000));
  store.close();
  store = new SessionStore(path);
  const quotas = new Quotas();
  const fired: string[] = [];
  const compactions = new IdleCompactions(
    path,
    (id) => fired.push(id),
    (id) => quotas.blockedUntil(loginOf(store.lastAccount(id) ?? {}), store.lastQuota(id)),
  );
  t.after(() => {
    compactions.clear();
    store.close();
  });
  compactions.update({ enabled: true });
  const turn = store.lastCachedTurn(session.id)!;
  assert.deepEqual(store.lastAccount(session.id), account);
  assert.equal(store.lastMetrics(session.id)?.rateLimits, null);
  assert.equal(store.lastQuota(session.id)?.windows[0]?.utilization, 100);
  compactions.arm(session.id, turn.endedAt, turn.metrics);
  t.mock.timers.tick(50 * MINUTE);
  assert.deepEqual(fired, []);
  t.mock.timers.tick(5 * MINUTE);
  assert.deepEqual(fired, [session.id]);
});

test('the store finds the last turn that wrote a cache, and when it ended', (t) => {
  const path = mkdtempSync(join(tmpdir(), 'idle-compaction-'));
  const store = new SessionStore(path);
  t.after(() => {
    store.database.close();
    rmSync(path, { recursive: true, force: true });
  });
  const session = store.create(randomUUID(), '会话', 'D:\\工作', {
    id: randomUUID(),
    name: '电脑',
  });
  assert.equal(store.lastCachedTurn(session.id), null);
  const turn = store.append(session.id, 'run', metrics(150_000, '1h'));
  // A status read after it says nothing of the cache.
  store.append(session.id, 'read', metrics(160_000));
  const found = store.lastCachedTurn(session.id);
  assert.equal(found?.metrics.context?.usedTokens, 150_000);
  assert.equal(found?.endedAt, Date.parse(turn.createdAt));
  // A compaction after it, as a terminal's CLI makes of an idle session by itself, leaves nothing to compact.
  store.append(session.id, 'terminal', {
    type: 'native.compact',
    trigger: 'auto',
    previousTokens: 150_000,
  });
  assert.equal(store.lastCachedTurn(session.id), null);
  store.append(session.id, 'run', metrics(20_000, '1h'));
  assert.equal(store.lastCachedTurn(session.id)?.metrics.context?.usedTokens, 20_000);
});

test("a result that does not break its cache writes down is read by the session's totals", () => {
  const written = cacheWrites();
  const usage = (hour: number, minutes: number) => ({
    'claude-opus-5-5': {
      cacheCreationEphemeral1hInputTokens: hour,
      cacheCreationEphemeral5mInputTokens: minutes,
    },
  });
  assert.equal(written(usage(1000, 0)), '1h');
  assert.equal(written(usage(1000, 0)), undefined, 'nothing written this turn');
  assert.equal(written(usage(1000, 300)), '5m');
  assert.equal(written(usage(4000, 600)), '1h');
  assert.equal(written(undefined), undefined, 'a CLI that does not count them');
});
