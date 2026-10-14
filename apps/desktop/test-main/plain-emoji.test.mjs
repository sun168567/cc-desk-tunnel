import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainEmoji } from '../src/plain-emoji.ts';

test('status emoji are drawn as text characters', () => {
  assert.equal(plainEmoji('✅ 与修订后的评审报告一致。'), '✓ 与修订后的评审报告一致。');
  assert.equal(plainEmoji('❌ 未通过'), '✗ 未通过');
  assert.equal(plainEmoji('⚠️ 注意'), '⚠ 注意');
  assert.equal(plainEmoji('✔️ 已核对'), '✔ 已核对');
});

test('emoji inside code stay as Claude wrote them', () => {
  const fenced = '```\n✅ keep\n```';
  assert.equal(plainEmoji(fenced), fenced);
  assert.equal(plainEmoji('run `✅` now'), 'run `✅` now');
  assert.equal(plainEmoji('前文 ✅\n```\n✅\n```\n后文 ❌'), '前文 ✓\n```\n✅\n```\n后文 ✗');
});
