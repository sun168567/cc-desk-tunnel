import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { EventPayload } from '@cc-desk-tunnel/protocol';
import { ClaudeStream } from '../src/claude-stream.ts';

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
  stream.accept({ type: 'system', subtype: 'informational', content: 'Native notice' });
  assert.ok(
    events.some((event) => event.type === 'native.notice' && event.text === 'Native notice'),
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
