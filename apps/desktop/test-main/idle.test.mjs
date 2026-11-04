import assert from 'node:assert/strict';
import { test } from 'node:test';
import { idleReminder } from '../src/idle.ts';

const MINUTE = 60_000;
const off = { enabled: false, afterMinutes: 50, minTokens: 100_000 };
let sequence = 0;
const event = (at, payload) => ({
  sessionId: 's',
  runId: 'r',
  sequence: ++sequence,
  createdAt: new Date(at).toISOString(),
  payload,
});
const turn = (at, usedTokens = 150_000, cacheTtl = '1h') =>
  event(at, {
    type: 'native.metrics',
    context: {
      model: 'm',
      usedTokens,
      windowTokens: 1_000_000,
      percentage: 15,
      measuredAt: new Date(at).toISOString(),
      categories: [],
    },
    usage: null,
    rateLimits: null,
    cacheTtl,
  });

test('an idle session reminds before its one-hour cache lapses and after, not before the time set', () => {
  const events = [turn(0)];
  assert.equal(idleReminder(events, off, 49 * MINUTE), null);
  assert.deepEqual(
    (({ phase, minutes, tokens }) => ({ phase, minutes, tokens }))(
      idleReminder(events, off, 52 * MINUTE),
    ),
    { phase: 'before', minutes: 8, tokens: 150_000 },
  );
  const after = idleReminder(events, off, 80 * MINUTE);
  assert.equal(after.phase, 'after');
  assert.equal(after.minutes, 80);
  assert.notEqual(after.key, idleReminder(events, off, 52 * MINUTE).key);
  // Without settings from the service, its defaults.
  assert.equal(idleReminder(events, null, 52 * MINUTE).phase, 'before');
});

test('nothing is said before the hour when the service compacts, the cache is short or the context small', () => {
  assert.equal(idleReminder([turn(0)], { ...off, enabled: true }, 52 * MINUTE), null);
  assert.equal(idleReminder([turn(0)], { ...off, enabled: true }, 61 * MINUTE).phase, 'after');
  assert.equal(idleReminder([turn(0, 150_000, '5m')], off, 52 * MINUTE), null);
  assert.equal(idleReminder([turn(0, 150_000, '5m')], off, 61 * MINUTE).phase, 'after');
  assert.equal(idleReminder([turn(0, 50_000)], off, 80 * MINUTE), null);
});

test('the size is the last reading of the context: after a compaction it is small, and nothing is said', () => {
  // A status read after the turn says nothing of the cache but how big the context is now.
  const reading = (at, usedTokens) => ({
    ...turn(at, usedTokens),
    payload: { ...turn(at, usedTokens).payload, cacheTtl: undefined },
  });
  assert.equal(idleReminder([turn(0), reading(MINUTE, 160_000)], off, 52 * MINUTE).tokens, 160_000);
  assert.equal(idleReminder([turn(0), reading(MINUTE, 20_000)], off, 52 * MINUTE), null);
  assert.equal(idleReminder([turn(0), reading(MINUTE, 20_000)], off, 80 * MINUTE), null);
  // No turn that wrote a cache: nothing to time it by.
  assert.equal(idleReminder([reading(0, 160_000)], off, 80 * MINUTE), null);
});
