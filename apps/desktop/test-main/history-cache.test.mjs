import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addRange, heldBelow, heldUnder } from '../src/historyCache.ts';

test('kept stretches join where they meet, and say what is held below a page and where a fetch can stop', () => {
  let ranges = addRange([], [10, 20]);
  ranges = addRange(ranges, [0, 5]);
  assert.deepEqual(ranges, [
    [0, 5],
    [10, 20],
  ]);
  ranges = addRange(ranges, [20, 30]);
  assert.deepEqual(ranges, [
    [0, 5],
    [10, 30],
  ]);
  assert.deepEqual(addRange(ranges, [7, 7]), ranges);
  // Within (10, 30] below 25 there is something to read; right above 10 there is not, so the service is asked
  // for what lies between 5 and the page.
  assert.deepEqual(heldBelow(ranges, 25), [10, 30]);
  assert.equal(heldBelow(ranges, 11), undefined);
  assert.equal(heldUnder(ranges, 11), 5);
  assert.equal(heldBelow(ranges, 8), undefined);
  assert.equal(heldUnder(ranges, 8), 5);
  assert.deepEqual(heldBelow(ranges, 6), [0, 5]);
  assert.equal(heldUnder([[3, 9]], 4), 0);
  assert.deepEqual(addRange(ranges, [4, 10]), [[0, 30]]);
});
