import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { sessionSchema } from '@cc-desk-tunnel/protocol';
import { markdown } from '../src/exportSession.ts';

function session(extra = {}) {
  const at = new Date().toISOString();
  return sessionSchema.parse({
    id: randomUUID(),
    title: '导出',
    projectPath: 'D:\\work',
    createdAt: at,
    updatedAt: at,
    activeRun: null,
    ...extra,
  });
}

function turn(sessionId, text) {
  const runId = randomUUID();
  const at = new Date().toISOString();
  return [
    {
      sessionId,
      runId,
      sequence: 1,
      createdAt: at,
      payload: { type: 'message.user', messageId: randomUUID(), text: '你好', scenario: 'chat' },
    },
    {
      sessionId,
      runId,
      sequence: 2,
      createdAt: at,
      payload: { type: 'text.delta', messageId: randomUUID(), text },
    },
    {
      sessionId,
      runId,
      sequence: 3,
      createdAt: at,
      payload: { type: 'run.status', status: 'completed', connectionId: randomUUID() },
    },
  ];
}

test('an export names the provider and model, and keeps credentials out', () => {
  const claude = session();
  const claudeText = markdown(claude, turn(claude.id, '收到'));
  assert.match(claudeText, /- 提供商：Claude\n- 模型：默认/);
  assert.match(claudeText, /## Claude Code\n\n收到/);
  assert.equal(claudeText.includes('## OpenAI'), false);

  const openai = session({ provider: 'openai', profileId: 'default', model: 'gpt-test' });
  const openaiText = markdown(openai, turn(openai.id, '收到'));
  assert.match(openaiText, /- 提供商：OpenAI\n- 模型：gpt-test/);
  assert.match(openaiText, /## OpenAI\n\n收到/);
  assert.equal(openaiText.includes('## Claude Code'), false);
  assert.equal(openaiText.includes('auth.openai.com'), false);
  assert.equal(openaiText.includes('设备码'), false);
  assert.equal(openaiText.includes('CODEX_HOME'), false);
});
