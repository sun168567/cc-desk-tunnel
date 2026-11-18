import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelDetail, modelName } from '../src/modelNames.ts';

test('a model is named with its version, however Claude Code is signed in', () => {
  // After a browser login.
  const login = { displayName: 'Opus 5.5', description: 'For complex work and everyday tasks' };
  assert.equal(modelName(login), 'Opus 5.5');
  assert.equal(modelDetail(login), 'For complex work and everyday tasks');
  // With a setup token.
  const token = {
    displayName: 'Fable',
    description: 'Fable 5.2 · Most capable for your hardest tasks · Requires usage credits',
  };
  assert.equal(modelName(token), 'Fable 5.2');
  assert.equal(modelDetail(token), 'Most capable for your hardest tasks · Requires usage credits');
  // Names of a provider's own, and descriptions that are not about the name.
  assert.equal(
    modelName({ displayName: 'deepseek-chat', description: 'Configured' }),
    'deepseek-chat',
  );
  assert.equal(modelName({ displayName: 'Opus', description: 'Opusculum 2 · x' }), 'Opus');
  assert.equal(
    modelName({ displayName: 'Opus (1M context)', description: 'Opus 5.5 · x' }),
    'Opus (1M context)',
  );
});
