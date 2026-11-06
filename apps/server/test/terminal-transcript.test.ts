import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EventPayload } from '@cc-desk-tunnel/protocol';
import {
  statusLineContext,
  terminalActivity,
  terminalEvents,
  terminalHooks,
  terminalRecord,
  terminalSettings,
  TerminalTranscript,
} from '../src/terminal-transcript.ts';

const session = '11111111-2222-4333-8444-555555555555';
const entry = (uuid: string, type: SessionMessage['type'], message: unknown, extra = {}) =>
  ({
    type,
    uuid,
    session_id: session,
    message,
    parent_tool_use_id: null,
    parent_agent_id: null,
    ...extra,
  }) as SessionMessage;
const answer = (uuid: string, id: string, content: unknown[]) =>
  entry(uuid, 'assistant', { id, role: 'assistant', model: 'claude-opus-5-5', content });

// Shapes as `getSessionMessages` of SDK 0.3.286 returns them for CLI 2.1.293, including after a /compact.
test('a terminal turn comes back as the events of a chat run, without what was there before', () => {
  const events: EventPayload[] = [];
  terminalEvents(
    [
      entry('old-1', 'user', { role: 'user', content: '图形界面里问的' }),
      answer('old-2', 'msg_0', [{ type: 'text', text: '已经显示过' }]),
      entry(
        'new-1',
        'user',
        { role: 'user', content: '终端里问的' },
        { origin: { kind: 'human' } },
      ),
      answer('new-2', 'msg_1', [{ type: 'text', text: '先看看' }]),
      answer('new-3', 'msg_1', [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ]),
      entry('new-4', 'user', {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' }],
      }),
      answer('new-5', 'msg_2', [{ type: 'text', text: '有一个文件' }]),
      entry('new-6', 'system', undefined),
      // What the CLI writes after a turn the user interrupted.
      entry('new-7', 'assistant', {
        id: 'msg_3',
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'No response requested.' }],
      }),
    ],
    new Set(['old-1', 'old-2']),
    (event) => events.push(event),
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['message.user', 'text.delta', 'tool.requested', 'tool.result', 'text.delta'],
  );
  const [prompt, first, tool, result, second] = events as never[] as Record<string, unknown>[];
  assert.equal(prompt.text, '终端里问的');
  assert.equal(first.text, '先看看');
  assert.equal(tool.name, 'Bash');
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'a.txt');
  assert.equal(second.text, '有一个文件');
  assert.notEqual(first.messageId, second.messageId);
});

test('each event keeps the time the CLI recorded it at', () => {
  const times: (string | undefined)[] = [];
  terminalEvents(
    [
      entry(
        'q',
        'user',
        { role: 'user', content: '问' },
        { timestamp: '2026-11-01T02:00:00.000Z' },
      ),
      answer('a', 'msg_1', [{ type: 'text', text: '答' }]),
    ],
    new Set(),
    (_, at) => times.push(at),
  );
  assert.deepEqual(times, ['2026-11-01T02:00:00.000Z', undefined]);
});

test('a compaction is one mark: the summary, notes, kept messages and the command said again are not shown', () => {
  const events: EventPayload[] = [];
  terminalEvents(
    [
      entry('boundary', 'system', undefined),
      entry(
        'summary',
        'user',
        { role: 'user', content: 'This session is being continued from a previous conversation…' },
        { isCompactSummary: true, is_meta: true },
      ),
      answer('kept', 'msg_4', [{ type: 'text', text: '压缩前保留的' }]),
      entry(
        'caveat',
        'user',
        { role: 'user', content: '<local-command-caveat>…' },
        { is_meta: true },
      ),
      entry('command', 'user', {
        role: 'user',
        content:
          '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args> 保留要点 </command-args>',
      }),
      entry('printed', 'user', {
        role: 'user',
        content: '<local-command-stdout>\u001b[2mCompacted\u001b[22m</local-command-stdout>',
      }),
      entry('task', 'user', { role: 'user', content: '任务结束' }, { origin: { kind: 'task' } }),
      entry('after', 'user', {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>给模型的</system-reminder>' },
          { type: 'text', text: '压缩之后' },
        ],
      }),
    ],
    new Set(['kept']),
    (event) => events.push(event),
  );
  assert.deepEqual(events, [
    { type: 'native.compact', trigger: 'unknown', previousTokens: null },
    {
      type: 'message.user',
      messageId: (events[1] as { messageId: string }).messageId,
      text: '压缩之后',
      scenario: 'chat',
    },
  ]);
});

// Lines as CLI 2.1.293 writes them to its record of a session, with what does not matter here left out.
const line = (fields: object) =>
  `${JSON.stringify({ sessionId: session, isSidechain: false, timestamp: '2026-11-06T03:00:00.000Z', ...fields })}\n`;
const said = (uuid: string, content: unknown, fields = {}) =>
  line({ type: 'user', uuid, message: { role: 'user', content }, ...fields });
const replied = (uuid: string, id: string, content: unknown[], ttl?: '5m' | '1h') =>
  line({
    type: 'assistant',
    uuid,
    message: {
      id,
      role: 'assistant',
      model: 'claude-opus-5-5',
      content,
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: ttl ? 300 : 0,
        cache_creation: {
          ephemeral_1h_input_tokens: ttl === '1h' ? 300 : 0,
          ephemeral_5m_input_tokens: ttl === '5m' ? 300 : 0,
        },
      },
    },
  });

test('the record is read as the CLI writes it, and a turn shows part by part as one chat run would', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-terminal-record-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, `${session}.jsonl`);
  writeFileSync(path, said('before', '终端打开前的'));
  const events: EventPayload[] = [];
  const transcript = new TerminalTranscript((event) => events.push(event));
  // What the record held as the terminal opened, and from where it was when the terminal's first hook named it.
  const known = new Set(['before']);
  let offset = statSync(path).size;
  const read = () => {
    const part = terminalRecord(path, offset);
    offset = part.offset;
    transcript.accept(part.messages, known);
    for (const message of part.messages) known.add(message.uuid);
    return events
      .splice(0)
      .map((event) =>
        event.type === 'message.user' ||
        event.type === 'text.delta' ||
        event.type === 'native.notice'
          ? `${event.type} ${event.text}`
          : event.type === 'native.compact'
            ? `${event.type} ${event.trigger} ${event.previousTokens}`
            : event.type,
      );
  };
  assert.deepEqual(terminalRecord(join(directory, 'none.jsonl'), 0), { messages: [], offset: 0 });

  // A question and the first parts of the answer, with a line the CLI is still writing.
  const rest = replied('a3', 'msg_2', [{ type: 'text', text: '有一个文件' }], '5m');
  appendFileSync(
    path,
    line({ type: 'mode', mode: 'normal' }) +
      said('q1', '看看目录', { origin: { kind: 'human' }, promptId: 'p1' }) +
      replied('a1', 'msg_1', [{ type: 'text', text: '先看看' }], '1h') +
      replied('a2', 'msg_1', [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ]) +
      line({ type: 'attachment', uuid: 'x1', attachment: {} }) +
      said('r1', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' }]) +
      rest.slice(0, 30),
  );
  assert.deepEqual(read(), [
    'message.user 看看目录',
    'text.delta 先看看',
    'tool.requested',
    'tool.result',
  ]);
  assert.equal(transcript.cacheTtl(), '1h');
  assert.equal(transcript.cacheTtl(), undefined);

  // The rest of that line and the answer, which the CLI writes a moment after the turn is over; a subagent's lines and
  // a task's report are not the conversation's.
  appendFileSync(
    path,
    rest.slice(30) +
      line({ type: 'assistant', uuid: 's1', isSidechain: true, message: { content: [] } }) +
      said('t1', '任务结束', { origin: { kind: 'task-notification' } }),
  );
  assert.deepEqual(read(), ['text.delta 有一个文件']);
  assert.equal(transcript.cacheTtl(), '5m');

  // A local command is one line of what it did; /exit says nothing.
  appendFileSync(
    path,
    said('c1', '<local-command-caveat>Caveat…</local-command-caveat>', { isMeta: true }) +
      said(
        'c2',
        '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>',
      ) +
      said(
        'c3',
        '<local-command-stdout>Set model to \u001b[1m`Opus 5.5`\u001b[22m</local-command-stdout>',
      ) +
      said('c4', '<command-name>/exit</command-name>\n<command-args></command-args>') +
      said('c5', '<local-command-stdout>Bye!</local-command-stdout>'),
  );
  assert.deepEqual(read(), ['native.notice 在终端里执行了 /model：Set model to Opus 5.5']);

  // /compact: what the user typed, and one mark with what the boundary says of it. The CLI writes the command and what
  // it printed again after the summary.
  appendFileSync(
    path,
    said('k1', '/compact') +
      line({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'b1',
        parentUuid: null,
        compactMetadata: { trigger: 'manual', preTokens: 447294 },
      }) +
      said('k2', 'This session is being continued…', {
        parentUuid: 'b1',
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }) +
      said('k3', '<local-command-caveat>Caveat…</local-command-caveat>', { isMeta: true }) +
      said(
        'k4',
        '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>',
      ) +
      said(
        'k5',
        '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>',
      ),
  );
  assert.deepEqual(read(), ['message.user /compact', 'native.compact manual 447294']);

  // A command of the CLI's that asks the model is a question as any other.
  appendFileSync(
    path,
    said('v1', '<command-name>/review</command-name>\n<command-args>42</command-args>') +
      said('v2', '审查这个 PR…', { isMeta: true }),
  );
  assert.deepEqual(read(), ['message.user /review 42']);
  // Read whole again as the turn ends, nothing shows twice.
  transcript.accept(terminalRecord(path, 0).messages, known);
  transcript.settle();
  assert.deepEqual(events, []);
  // Written anew, the record is read from its end.
  writeFileSync(path, said('n1', '新的'));
  assert.deepEqual(read(), []);
  assert.equal(offset, statSync(path).size);
});

test('the context comes from what the CLI shows in its status line', () => {
  const context = statusLineContext({
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    context_window: {
      context_window_size: 1_000_000,
      current_usage: {
        input_tokens: 2,
        output_tokens: 8,
        cache_creation_input_tokens: 1286,
        cache_read_input_tokens: 140066,
      },
    },
  });
  assert.equal(context?.model, 'claude-opus-5-5');
  assert.equal(context?.usedTokens, 141354);
  assert.equal(context?.windowTokens, 1_000_000);
  // In whole percents, as the SDK gives them.
  assert.equal(context?.percentage, 14);
  assert.deepEqual(context?.categories, []);
  // The status line names the model's window even where the CLI settings compact by a smaller one, which /context and
  // the SDK count by; a larger one leaves the model's.
  const status = {
    model: { id: 'claude-opus-5-5' },
    context_window: {
      context_window_size: 1_000_000,
      current_usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 232,
        cache_read_input_tokens: 167041,
      },
    },
  };
  assert.deepEqual(
    (({ windowTokens, percentage }) => ({ windowTokens, percentage }))(
      statusLineContext(status, 500_000)!,
    ),
    { windowTokens: 500_000, percentage: 33 },
  );
  assert.equal(statusLineContext(status, 2_000_000)?.windowTokens, 1_000_000);
  assert.equal(statusLineContext(status, null)?.windowTokens, 1_000_000);
  assert.equal(statusLineContext({ context_window: { current_usage: null } }), null);
  assert.equal(statusLineContext(null), null);
});

test('the terminal settings add the hooks to the provider settings, readable only by the service', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-terminal-settings-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const provider = join(directory, 'provider.json');
  writeFileSync(
    provider,
    JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://example.test' },
      hooks: { SessionStart: [{ hooks: [] }] },
    }),
  );
  const settings = join(directory, 'terminal.json');
  const hooks = join(directory, "it's.hooks");
  terminalSettings(settings, hooks, provider);
  const written = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(written.env.ANTHROPIC_BASE_URL, 'https://example.test');
  assert.equal(written.hooks.SessionStart.length, 2);
  const command = `{ cat; echo; } >> '${hooks.replaceAll("'", "'\\''")}'`;
  assert.equal(written.hooks.SessionStart[1].hooks[0].command, command);
  for (const name of ['UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop'])
    assert.equal(written.hooks[name][0].hooks[0].command, command);
  if (process.platform !== 'win32') assert.equal(statSync(settings).mode & 0o777, 0o600);
  assert.equal(written.statusLine, undefined);
});

test("the terminal status line keeps what the CLI hands it, and still shows the user's own", (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-terminal-status-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settings = join(directory, 'terminal.json');
  const status = join(directory, "it's.status");
  const user = join(directory, 'user.json');
  const input = JSON.stringify({
    rate_limits: { five_hour: { used_percentage: 12, resets_at: 1 } },
  });
  const run = (command: string) =>
    execFileSync('sh', ['-c', command], { input, encoding: 'utf8', cwd: directory });
  // Nothing of the user's: the line shows nothing, and the input is kept.
  terminalSettings(settings, join(directory, 'terminal.hooks'), undefined, status, user);
  const plain = JSON.parse(readFileSync(settings, 'utf8')).statusLine;
  assert.equal(plain.type, 'command');
  if (process.platform !== 'win32') {
    assert.equal(run(plain.command), '');
    assert.equal(readFileSync(status, 'utf8'), `${input}\n`);
  }
  // The user's own status line, with its padding, gets the same input and prints what it did.
  writeFileSync(
    user,
    JSON.stringify({ statusLine: { type: 'command', command: 'wc -c # count', padding: 2 } }),
  );
  terminalSettings(settings, join(directory, 'terminal.hooks'), undefined, status, user);
  const own = JSON.parse(readFileSync(settings, 'utf8')).statusLine;
  assert.equal(own.padding, 2);
  if (process.platform !== 'win32') {
    rmSync(status);
    assert.equal(run(own.command).trim(), String(input.length));
    assert.equal(readFileSync(status, 'utf8'), `${input}\n`);
  }
});

test('the hooks file is read as it grows, and says what the CLI is doing', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-terminal-hooks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const hooks = join(directory, 'terminal.hooks');
  assert.deepEqual(terminalHooks(hooks), { hooks: [], offset: 0 });
  const line = (hook: object) => `${JSON.stringify({ session_id: session, ...hook })}\n`;
  writeFileSync(
    hooks,
    line({ hook_event_name: 'SessionStart', source: 'resume' }) +
      '\nnot json\n' +
      line({ hook_event_name: 'UserPromptSubmit', prompt: '你好' }) +
      '{"hook_event_name":"Sto',
  );
  const first = terminalHooks(hooks);
  assert.deepEqual(
    first.hooks.map((hook) => [hook.hook_event_name, terminalActivity(hook)]),
    [
      ['SessionStart', 'idle'],
      ['UserPromptSubmit', 'working'],
    ],
  );
  // The line being written is read once it is whole.
  appendFileSync(
    hooks,
    `p"}\n${line({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })}`,
  );
  const second = terminalHooks(hooks, first.offset);
  assert.deepEqual(
    second.hooks.map((hook) => terminalActivity(hook)),
    ['idle', 'waiting'],
  );
  assert.deepEqual(terminalHooks(hooks, second.offset).hooks, []);
  assert.equal(
    terminalActivity({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }),
    'idle',
  );
  assert.equal(terminalActivity({ hook_event_name: 'PostToolUse' }), 'working');
  assert.equal(terminalActivity({ hook_event_name: 'PermissionRequest' }), 'waiting');
});
