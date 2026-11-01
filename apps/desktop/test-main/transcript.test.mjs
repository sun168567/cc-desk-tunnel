import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversation } from '../src/transcript.ts';

let sequence = 0;
const at = (second) => new Date(Date.UTC(2026, 9, 26, 12, 0, second)).toISOString();
const event = (runId, second, payload) => ({
  sessionId: 'session',
  runId,
  sequence: ++sequence,
  createdAt: at(second),
  payload,
});
const said = (runId, second, messageId, text) =>
  event(runId, second, { type: 'text.delta', messageId, text });

test('an automatic compaction is one mark among the steps, with what came after it under it', () => {
  const turns = conversation([
    event('run', 0, { type: 'message.user', messageId: 'question', text: '做事' }),
    said('run', 1, 'before', '压缩前'),
    event('run', 2, { type: 'native.notice', text: 'compacting' }),
    event('run', 3, { type: 'native.notice', text: 'compacting' }),
    event('run', 4, { type: 'native.notice', text: 'compacting' }),
    event('run', 5, { type: 'native.notice', text: 'status' }),
    event('run', 6, { type: 'native.compact', trigger: 'auto', previousTokens: 468496 }),
    said('run', 7, 'after', '压缩后'),
  ]);
  assert.equal(turns.length, 1);
  assert.deepEqual(
    turns[0].steps.map((step) => step.kind),
    ['assistant', 'compact', 'assistant'],
  );
  const mark = turns[0].steps[1];
  assert.equal(mark.at, at(2));
  assert.equal(mark.endedAt, at(6));
  assert.equal(mark.previousTokens, 468496);
  assert.deepEqual(turns[0].notices, []);
});

test('"continue" takes the stopped turn up again instead of starting one of its own', () => {
  const stats = (messageId, outputTokens, outputPerSecond) => ({
    type: 'turn.stats',
    messageId,
    requests: 1,
    inputTokens: 1,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    modelMs: 1000,
    ttftMs: 100,
    outputPerSecond,
    partial: false,
  });
  const turns = conversation([
    event('first', 0, { type: 'message.user', messageId: 'question', text: '做事' }),
    said('first', 1, 'one', '第一段'),
    event('first', 2, { type: 'run.status', status: 'cancelled', reason: '用户停止' }),
    event('first', 2, stats('question', 100, 100)),
    event('second', 62, {
      type: 'message.user',
      messageId: 'again',
      text: '继续',
      continued: true,
    }),
    said('second', 63, 'two', '第二段'),
    event('second', 64, { type: 'run.status', status: 'completed' }),
    event('second', 64, stats('again', 300, 100)),
  ]);
  assert.equal(turns.length, 1);
  const [turn] = turns;
  assert.equal(turn.question.text, '做事');
  assert.deepEqual(
    turn.steps.map((step) => step.kind),
    ['assistant', 'notice'],
  );
  assert.equal(turn.answer.text, '第二段');
  assert.equal(turn.outcome, undefined);
  assert.equal(turn.pausedMs, 60000);
  assert.equal(turn.stats.outputTokens, 400);
  assert.equal(turn.stats.outputPerSecond, 100);
});

test("a terminal's turns are marked, and each ends with the last thing recorded of it, not with the terminal", () => {
  const turns = conversation([
    event('terminal', 0, {
      type: 'run.status',
      status: 'running',
      surface: 'terminal',
      connectionId: 'c',
    }),
    event('terminal', 10, {
      type: 'message.user',
      messageId: 'first',
      text: '终端里问的',
      scenario: 'chat',
    }),
    said('terminal', 12, 'one', '第一个回答'),
    event('terminal', 20, {
      type: 'message.user',
      messageId: 'second',
      text: '再问',
      scenario: 'chat',
    }),
    said('terminal', 25, 'two', '第二个回答'),
    event('terminal', 59, {
      type: 'run.status',
      status: 'completed',
      surface: 'terminal',
      connectionId: 'c',
    }),
    event('chat', 59, {
      type: 'message.user',
      messageId: 'chat',
      text: '图形界面里问的',
      scenario: 'chat',
    }),
  ]);
  assert.deepEqual(
    turns.map((turn) => [turn.question.terminal ?? false, turn.endedAt, turn.answer?.text]),
    [
      [true, at(12), '第一个回答'],
      [true, at(25), '第二个回答'],
      [false, undefined, undefined],
    ],
  );
});
