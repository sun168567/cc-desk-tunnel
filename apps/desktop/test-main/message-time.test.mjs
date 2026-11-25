import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageTime } from '../src/messageTime.ts';
import { t } from '../src/i18n.ts';

test('message dates distinguish today, yesterday, older years and invalid timestamps', () => {
  const now = new Date(2026, 0, 1, 12);
  assert.match(messageTime(t, new Date(2026, 0, 1, 9).toISOString(), now).short, /^今天 09:00$/);
  assert.match(messageTime(t, new Date(2025, 11, 31, 9).toISOString(), now).short, /^昨天 09:00$/);
  assert.match(messageTime(t, new Date(2025, 11, 30, 9).toISOString(), now).short, /2025/);
  assert.match(messageTime(t, now.toISOString(), now).full, /2026.*12:00:00/);
  assert.equal(messageTime(t, 'invalid', now), null);
});
