import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UPDATE_LOOK_MS, lookDue } from '../src/update-check.ts';

test('a client in use has the service look again once its last look is an hour old', () => {
  const now = Date.now();
  assert.equal(lookDue({ state: 'idle', checkedAt: now - UPDATE_LOOK_MS + 1000 }, now), false);
  assert.equal(lookDue({ state: 'idle', checkedAt: now - UPDATE_LOOK_MS }, now), true);
  assert.equal(
    lookDue({ state: 'available', latest: '9.9.9', checkedAt: now - 2 * UPDATE_LOOK_MS }, now),
    true,
  );
  // Not while it looks or installs, and not for a service that follows no releases.
  for (const state of ['checking', 'installing', 'restarting'])
    assert.equal(lookDue({ state, checkedAt: 0 }, now), false);
  assert.equal(lookDue(undefined, now), false);
  // A service that has not looked yet since it started is asked at once.
  assert.equal(lookDue({ state: 'idle' }, now), true);
});
