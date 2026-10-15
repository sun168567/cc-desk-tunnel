import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipIpc } from '../src/worker.ts';

test('an oversized Codex event is replaced by a short limit error', () => {
  const sessionId = '0d0c6a0e-6a53-4a0c-9d3a-2f6f5f3f7b11';
  const small = clipIpc({
    type: 'event',
    generation: 1,
    sessionId,
    payload: { type: 'text.delta', messageId: '11111111-1111-4111-8111-111111111111', text: 'ok' },
  });
  assert.equal(small?.type, 'event');
  const huge = clipIpc({
    type: 'event',
    generation: 1,
    sessionId,
    payload: {
      type: 'text.delta',
      messageId: '11111111-1111-4111-8111-111111111111',
      text: 'x'.repeat(300 * 1024),
    },
  });
  assert.equal(huge?.type, 'event');
  if (huge?.type !== 'event') return;
  assert.equal(huge.payload.type, 'run.error');
  if (huge.payload.type === 'run.error') assert.equal(huge.payload.code, 'codex_limited');
});
