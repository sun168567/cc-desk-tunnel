import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Throttle } from '../src/throttle.ts';

test('wrong tokens are free five times, then wait a minute doubling to an hour; success forgets them', () => {
  const throttle = new Throttle();
  for (let attempt = 0; attempt < 5; attempt++) throttle.fail('a', 0);
  assert.equal(throttle.blocked('a', 0), 0);
  throttle.fail('a', 0);
  assert.equal(throttle.blocked('a', 0), 60);
  assert.equal(throttle.blocked('a', 60_000), 0);
  assert.equal(throttle.blocked('b', 0), 0);
  throttle.fail('a', 60_000);
  assert.equal(throttle.blocked('a', 60_000), 120);
  for (let attempt = 0; attempt < 20; attempt++) throttle.fail('a', 0);
  assert.equal(throttle.blocked('a', 0), 3600);
  throttle.succeed('a');
  assert.equal(throttle.blocked('a', 0), 0);
});
test('connections that have not signed in are limited per address and in total', () => {
  const throttle = new Throttle();
  for (let index = 0; index < 4; index++) assert.equal(throttle.enter('a'), true);
  assert.equal(throttle.enter('a'), false);
  throttle.leave('a');
  assert.equal(throttle.enter('a'), true);
  for (let index = 0; index < 60; index++) assert.equal(throttle.enter(`b${index}`), true);
  assert.equal(throttle.enter('c'), false);
});
