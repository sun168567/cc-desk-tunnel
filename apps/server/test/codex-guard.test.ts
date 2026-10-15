import assert from 'node:assert/strict';
import { test } from 'node:test';
import { takeIpc, takeLog } from '../src/codex-guard.ts';

test('IPC past the per-second budget is limited once, then accepted again', () => {
  const state = { window: 0, count: 0 };
  for (let index = 0; index < 200; index++) assert.equal(takeIpc(state, 5_000), 'ok');
  assert.equal(takeIpc(state, 5_000), 'limit');
  assert.equal(takeIpc(state, 5_000), 'drop');
  assert.equal(takeIpc(state, 6_000), 'ok');
});

test('a log stops at its byte cap and discards the rest', () => {
  const first = takeLog(0, Buffer.from('abcdefghij'), 8);
  assert.equal(first.slice?.toString(), 'abcdefgh');
  assert.equal(first.used, 8);
  const rest = takeLog(first.used, Buffer.from('more'), 8);
  assert.equal(rest.slice, undefined);
  assert.equal(rest.used, 8);
});
