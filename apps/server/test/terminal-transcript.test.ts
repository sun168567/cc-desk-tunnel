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
  terminalActivity,
  terminalEvents,
  terminalHooks,
  terminalSettings,
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

test('a compaction is one mark: the summary, notes and kept messages are not shown as turns', () => {
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
      text: '/compact 保留要点',
      scenario: 'chat',
    },
    {
      type: 'text.delta',
      messageId: (events[2] as { messageId: string }).messageId,
      text: '```text\nCompacted\n```',
    },
    {
      type: 'message.user',
      messageId: (events[3] as { messageId: string }).messageId,
      text: '压缩之后',
      scenario: 'chat',
    },
  ]);
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
