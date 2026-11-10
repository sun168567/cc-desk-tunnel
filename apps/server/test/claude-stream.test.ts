import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { EventPayload } from '@cc-desk-tunnel/protocol';
import { ClaudeStream, shownToday } from '../src/claude-stream.ts';

test('native partial text/thinking are not duplicated by complete assistant events', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.accept({
    type: 'system',
    subtype: 'init',
    session_id: randomUUID(),
    model: 'test',
    claude_code_version: '2.1.286',
  });
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  stream.accept({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } },
  });
  stream.accept({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '公开推理' } },
  });
  stream.accept({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: '公开推理' }] },
  });
  stream.accept({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '实际增量' } },
  });
  stream.accept({ type: 'assistant', message: { content: [{ type: 'text', text: '实际增量' }] } });
  stream.accept({ type: 'result', subtype: 'success', is_error: false, result: '实际增量' });
  assert.equal(events.filter((event) => event.type === 'text.delta').length, 1);
  assert.equal(events.filter((event) => event.type === 'thinking.delta').length, 1);
  assert.equal(stream.result?.failed, false);
});
test('native Bash input, permission identity and unmodified tool results remain correlated', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  const toolId = 'call_native_not_uuid';
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  stream.accept({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolId, name: 'Bash', input: {} },
    },
  });
  stream.accept({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"command":"ssh -F config windows"}' },
    },
  });
  stream.accept({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: toolId,
          name: 'Bash',
          input: { command: 'ssh -F config windows' },
        },
      ],
    },
  });
  assert.equal(stream.tool('Bash', { command: 'ssh -F config windows' }, toolId).id, toolId);
  stream.accept({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolId,
          is_error: true,
          content: 'D:\\中文\nExit code 5',
        },
      ],
    },
  });
  assert.equal(events.filter((event) => event.type === 'tool.requested').length, 1);
  const result = events.find((event) => event.type === 'tool.result');
  assert.ok(result?.type === 'tool.result');
  assert.equal(result.toolId, toolId);
  assert.equal(result.exitCode, null);
  assert.equal(result.status, 'failed');
  assert.match(result.output, /D:\\中文/);
});
test('native denials and upstream failures are represented without inventing a policy', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.tool('Bash', { command: 'example' }, 'native-tool').denied = true;
  stream.accept({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'native-tool',
          is_error: true,
          content: 'Permission denied',
        },
      ],
    },
  });
  assert.ok(events.some((event) => event.type === 'tool.result' && event.status === 'denied'));
  stream.accept({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['Upstream failed'],
  });
  assert.equal(stream.result?.failed, true);
  assert.ok(
    events.some((event) => event.type === 'run.error' && event.message === 'Upstream failed'),
  );
});
test('identical concurrent native calls keep their IDs and progress uses real SDK events', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.tool('Bash', { command: 'same' }, 'call-1');
  stream.tool('Bash', { command: 'same' }, 'call-2');
  assert.equal(stream.tools.size, 2);
  stream.accept({ type: 'tool_progress', tool_use_id: 'call-2', elapsed_time_seconds: 3 });
  assert.ok(
    events.some(
      (event) =>
        event.type === 'tool.progress' && event.toolId === 'call-2' && event.elapsedSeconds === 3,
    ),
  );
  stream.accept({ type: 'system', subtype: 'status', status: 'compacting' });
  stream.accept({ type: 'system', subtype: 'status', status: null });
  assert.deepEqual(
    events.filter((event) => event.type === 'native.notice').map((event) => event.text),
    ['compacting'],
  );
  stream.accept({ type: 'system', subtype: 'informational', content: 'Native notice' });
  assert.ok(
    events.some((event) => event.type === 'native.notice' && event.text === 'Native notice'),
  );
  // As CLI 2.1.321 says on its way out that a full disk kept it from saving the session.
  stream.accept({
    type: 'system',
    subtype: 'session_writes_lost',
    error_code: 'ENOSPC',
    lost: ['transcript'],
    transcript_session_ids: ['x'],
  });
  const lost = events.at(-1);
  assert.equal(lost?.type, 'native.notice');
  assert.match(lost?.type === 'native.notice' ? lost.text : '', /磁盘已满.*会话记录缺了一部分/);
});
test("a call waiting on a foreground task names it; a background task or another agent's call does not", () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.tool('Bash', { command: 'npm test' }, 'call-1');
  const started = { type: 'system', subtype: 'task_started', description: 'npm test' };
  stream.accept({ ...started, task_id: 'b1', tool_use_id: 'call-1', is_backgrounded: false });
  stream.accept({ ...started, task_id: 'b2', tool_use_id: 'call-1', is_backgrounded: true });
  stream.accept({ ...started, task_id: 'b3', tool_use_id: 'elsewhere', is_backgrounded: false });
  stream.accept({ ...started, task_id: 'b4', is_backgrounded: false });
  assert.deepEqual(
    events.filter((event) => event.type === 'tool.task'),
    [{ type: 'tool.task', toolId: 'call-1', taskId: 'b1' }],
  );
});

test('requested and effective native approval modes remain distinct', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event), 'auto');
  stream.accept({
    type: 'system',
    subtype: 'init',
    session_id: randomUUID(),
    model: 'test',
    permissionMode: 'default',
  });
  const init = events.find((event) => event.type === 'native.session');
  assert.ok(init?.type === 'native.session');
  assert.equal(init.requestedPermissionMode, 'auto');
  assert.equal(init.permissionMode, 'default');
  assert.ok(
    events.some((event) => event.type === 'native.notice' && event.text.includes('default')),
  );
});

test('native compact metadata and effective effort are forwarded without local summarization', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event), 'plan', 'high');
  stream.accept({
    type: 'system',
    subtype: 'init',
    session_id: randomUUID(),
    model: 'test',
    permissionMode: 'plan',
    effort: 'medium',
  });
  stream.accept({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'manual', pre_tokens: 5432 },
  });
  const session = events.find((event) => event.type === 'native.session');
  assert.ok(session?.type === 'native.session');
  assert.equal(session.requestedEffort, 'high');
  assert.equal(session.effort, 'medium');
  assert.ok(
    events.some(
      (event) =>
        event.type === 'native.compact' &&
        event.previousTokens === 5432 &&
        event.trigger === 'manual',
    ),
  );
});

test('the model requests of a turn are counted from their start events', () => {
  const stream = new ClaudeStream(() => {});
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  stream.accept({ type: 'stream_event', event: { type: 'message_stop' } });
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  assert.equal(stream.requests, 2);
  stream.requests = 0;
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  assert.equal(stream.requests, 1);
});

test('what a local command printed becomes a reply of its own, without terminal colours', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.accept({
    type: 'system',
    subtype: 'local_command_output',
    content: '\u001b[1mContext\u001b[0m 12%',
    uuid: randomUUID(),
    session_id: randomUUID(),
  });
  assert.equal(events.length, 1);
  assert.ok(events[0].type === 'text.delta');
  assert.equal(events[0].text, '```text\nContext 12%\n```');
});

test('a local command that prints plain text is shown as printed, its dollars no formula', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  const usage =
    'Total cost:            $0.0919 (costs may be inaccurate)\nUsage by model:\n  gpt-5.6-terra:  16.2k input ($0.0919)';
  stream.accept({ type: 'assistant', message: { content: [{ type: 'text', text: usage }] } });
  stream.accept({ type: 'result', subtype: 'success', is_error: false, result: usage });
  // A reply of the model that is plain text stays as it came.
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  stream.accept({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '$x$ 是变量' }] },
  });
  const texts = events.flatMap((event) => (event.type === 'text.delta' ? [event.text] : []));
  assert.deepEqual(texts, ['```text\n' + usage + '\n```', '$x$ 是变量']);
});

test('a local command answered after a streamed reply is shown as a reply of its own', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  stream.accept({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '模型的回答' } },
  });
  stream.accept({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '模型的回答' }] },
  });
  stream.accept({ type: 'result', subtype: 'success', is_error: false, result: '模型的回答' });
  // Claude Code 2.1.293 answers /context and /usage with a whole message, and no model request before it.
  stream.accept({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '## Context Usage' }] },
  });
  stream.accept({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '## Context Usage',
  });
  const texts = events.filter((event) => event.type === 'text.delta');
  assert.deepEqual(
    texts.map((event) => event.text),
    ['模型的回答', '## Context Usage'],
  );
  assert.notEqual(texts[0].messageId, texts[1].messageId);
});

test('the gateway notice of auto mode is shown once a day, other notices every time', () => {
  const billing =
    "We're changing auto mode to no longer charge for classifier requests in Claude Code. However, this session isn't eligible because your requests go through api.example.com.";
  const day = 86_400_000;
  assert.equal(shownToday(billing, 10 * day), false);
  assert.equal(shownToday(billing, 10 * day + 1000), true);
  assert.equal(shownToday(billing, 11 * day - 1), true);
  assert.equal(shownToday(billing, 11 * day), false);
  assert.equal(shownToday('Native notice', 11 * day), false);
  assert.equal(shownToday('Native notice', 11 * day), false);
});
