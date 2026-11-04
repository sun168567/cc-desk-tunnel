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
  compactionDue,
  readIdleCompaction,
  writeIdleCompaction,
} from '../src/idle-compaction.ts';
import { SessionStore } from '../src/store.ts';

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
  const compactions = new IdleCompactions(path, (sessionId) => fired.push(sessionId));
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
});
