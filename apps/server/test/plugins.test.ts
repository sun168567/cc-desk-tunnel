import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { EventPayload, Session } from '@cc-desk-tunnel/protocol';
import { Plugins } from '../src/plugins.ts';
import { EVENTS_VERSION, ServiceEvents } from '../src/service-events.ts';
import type { ServiceEvent } from '../src/service-events.ts';

test('every wait is resolved by the end of its run, and a failed run says why and how the quota stands', () => {
  const heard: ServiceEvent[] = [];
  const window = { name: 'five_hour', utilization: 42, resetsAt: '2026-11-25T08:00:00.000Z' };
  const quota = { rateLimits: { available: true, windows: [window] } };
  const device = { id: randomUUID(), name: '电脑' };
  const session = { id: randomUUID(), title: '会话', projectPath: 'D:\\p', device } as Session;
  const events = new ServiceEvents(
    () => ({ session, metrics: null, quota }),
    () => true,
    (event) => heard.push(event),
  );
  const connectionId = randomUUID();
  const observe = (runId: string, payload: EventPayload) =>
    events.observe({
      sessionId: session.id,
      runId,
      sequence: 1,
      createdAt: new Date().toISOString(),
      payload,
    });
  const [run, terminal, approvalId] = [randomUUID(), randomUUID(), randomUUID()];
  observe(run, {
    type: 'tool.requested',
    toolId: 't',
    name: 'AskUserQuestion',
    input: '{}',
    target: 'Linux',
  });
  observe(run, { type: 'approval.requested', approvalId, toolId: 't' });
  observe(run, { type: 'run.status', status: 'running', waiting: 'background', connectionId });
  observe(run, { type: 'run.status', status: 'cancelled', reason: '用户停止', connectionId });
  // Recorded after the run: its wait is resolved already.
  observe(run, { type: 'approval.resolved', approvalId, allowed: false });
  for (const activity of ['waiting', 'working'] as const)
    observe(terminal, {
      type: 'run.status',
      status: 'running',
      surface: 'terminal',
      activity,
      connectionId,
    });
  assert.deepEqual(
    heard.map((event) => [event.hook_event_name, event.wait_id ?? event.status]),
    [
      ['QuestionAsked', approvalId],
      ['BackgroundOnly', undefined],
      ['WaitResolved', approvalId],
      ['RunEnded', 'cancelled'],
      ['TerminalWaiting', terminal],
      ['WaitResolved', terminal],
    ],
  );
  const failing = randomUUID();
  observe(failing, { type: 'run.error', code: 'cli_process_failed', message: 'boom' });
  observe(failing, { type: 'run.status', status: 'failed', connectionId });
  const ended = heard.at(-1)!;
  assert.deepEqual(ended.device, { ...device, platform: 'win32' });
  assert.deepEqual(ended.error, { code: 'cli_process_failed', message: 'boom' });
  assert.deepEqual(ended.quota, [
    { name: window.name, utilization: 42, resets_at: window.resetsAt },
  ]);
});

test('an event is not made while no plugin is there, and one that cannot be made leaves the run alone', (t) => {
  let wanted = false;
  let asked = 0;
  const events = new ServiceEvents(
    () => {
      asked++;
      throw new Error('no such session');
    },
    () => wanted,
    () => assert.fail('nothing to emit'),
  );
  const failed = {
    sessionId: randomUUID(),
    runId: randomUUID(),
    sequence: 1,
    createdAt: new Date().toISOString(),
    payload: { type: 'run.error', code: 'c', message: 'm' } as const,
  };
  t.mock.method(console, 'error', () => {});
  events.observe(failed);
  assert.equal(asked, 0);
  wanted = true;
  events.observe(failed);
  assert.equal(asked, 1);
});

// A plugin's directory under <data>/plugins: its manifest, if any, its hooks, and files of its own.
function plugin(
  data: string,
  id: string,
  {
    manifest,
    hooks,
    files = {},
  }: { manifest?: object; hooks: object | string; files?: Record<string, string> },
) {
  const root = join(data, 'plugins', id);
  mkdirSync(join(root, 'hooks'), { recursive: true });
  if (manifest) {
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest));
  }
  writeFileSync(
    join(root, 'hooks', 'hooks.json'),
    typeof hooks === 'string' ? hooks : JSON.stringify({ hooks }),
  );
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
}
// A hook that runs a script of the plugin with Node, wherever the tests run.
const node = (script: string, more: object = {}) => [
  { hooks: [{ type: 'command', command: process.execPath, args: [script], ...more }] },
];
async function until<T>(read: () => T | undefined, what: string) {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Never: ${what}`);
}
function fixture(t: TestContext) {
  const data = mkdtempSync(join(tmpdir(), 'ccdt-plugins-'));
  t.mock.method(console, 'error', () => {});
  let told = 0;
  const plugins = new Plugins(data, () => told++);
  t.after(() => {
    plugins.close();
    rmSync(data, { recursive: true, force: true });
  });
  return { data, plugins, told: () => told };
}
const event = (name: ServiceEvent['hook_event_name'], fields: object = {}): ServiceEvent => ({
  version: EVENTS_VERSION,
  hook_event_name: name,
  timestamp: new Date().toISOString(),
  ...fields,
});

test('a plugin is read from its files: a manifest is optional, and one whose files are wrong says which', (t) => {
  const { data, plugins } = fixture(t);
  plugin(data, 'acme.push', {
    manifest: {
      name: 'push',
      displayName: 'Push',
      version: '1.2.0',
      author: { name: 'Acme', email: 'a@example.com' },
      userConfig: {
        token: { type: 'string', title: 'Token', sensitive: true, required: true },
        mode: { type: 'string', title: 'Mode', options: ['card', 'text'], default: 'card' },
      },
      somethingElse: true,
    },
    hooks: { RunEnded: node('x.mjs') },
  });
  plugin(data, 'bare', { hooks: { DeviceOnline: node('x.mjs') } });
  plugin(data, 'broken', { hooks: '{ not json' });
  plugin(data, 'wrong.default', {
    manifest: { userConfig: { n: { type: 'number', title: 'N', default: 'ten' } } },
    hooks: {},
  });
  plugin(data, '.hidden', { hooks: {} });
  plugins.start();
  const [push, bare, broken, wrong] = plugins.list();
  assert.deepEqual(
    plugins.list().map(({ id }) => id),
    ['acme.push', 'bare', 'broken', 'wrong.default'].sort(),
  );
  assert.equal(push!.id, 'acme.push');
  assert.deepEqual(
    [push!.title, push!.version, push!.author, push!.events, Object.keys(push!.options)],
    ['Push', '1.2.0', { name: 'Acme' }, ['RunEnded'], ['token', 'mode']],
  );
  // Its required token has no value yet.
  assert.deepEqual(push!.problem, {
    key: 'service:plugins.unset',
    params: { titles: ['Token'] },
  });
  assert.deepEqual(
    [bare!.title, bare!.problem, bare!.events],
    ['bare', undefined, ['DeviceOnline']],
  );
  assert.ok(
    typeof broken!.problem === 'object' && broken!.problem.key === 'service:plugins.broken',
  );
  assert.equal(broken!.problem.params!.file, 'hooks/hooks.json');
  assert.ok(typeof wrong!.problem === 'object');
  assert.deepEqual(wrong!.problem.params!.file, '.claude-plugin/plugin.json');
  assert.equal(plugins.any(), true);
});

test('settings are checked and kept, a secret is never listed, and commands are given them as Claude Code gives its hooks', async (t) => {
  const { data, plugins } = fixture(t);
  plugin(data, 'acme.push', {
    manifest: {
      userConfig: {
        token: { type: 'string', title: 'Token', sensitive: true, required: true },
        mode: { type: 'string', title: 'Mode', options: ['card', 'text'], default: 'card' },
        retries: { type: 'number', title: 'Retries', min: 0, max: 5 },
      },
    },
    hooks: {
      RunEnded: node('${CLAUDE_PLUGIN_ROOT}/say.mjs', {
        args: ['${CLAUDE_PLUGIN_ROOT}/say.mjs', '${user_config.mode}'],
      }),
    },
    files: {
      'say.mjs':
        "import { readFileSync } from 'node:fs';\n" +
        "const event = JSON.parse(readFileSync(0, 'utf8'));\n" +
        'console.log(event.hook_event_name, process.argv[2], process.env.CLAUDE_PLUGIN_OPTION_TOKEN, process.env.CLAUDE_PLUGIN_OPTION_RETRIES);\n',
    },
  });
  plugins.start();
  const fails = (values: Record<string, string | number | boolean | null>, code: string) =>
    assert.throws(() => plugins.configure('acme.push', values), { code });
  fails({ retries: 9 }, 'plugin_value_invalid');
  fails({ retries: 'two' }, 'plugin_value_invalid');
  fails({ mode: 'html' }, 'plugin_value_invalid');
  fails({ colour: 'red' }, 'plugin_option_unknown');
  assert.throws(() => plugins.configure('nobody', {}), { code: 'plugin_unknown' });
  await assert.rejects(plugins.attempt('acme.push', 'RunEnded'), { code: 'plugin_unset' });
  plugins.configure('acme.push', { token: 'secret-value', mode: 'text', retries: 2 });
  // An empty secret keeps the one there is.
  plugins.configure('acme.push', { token: '' });
  const [listed] = plugins.list();
  assert.deepEqual(
    [listed!.values, listed!.secrets, listed!.problem],
    [{ mode: 'text', retries: 2 }, ['token'], undefined],
  );
  const [run] = await plugins.attempt('acme.push', 'RunEnded');
  assert.equal(run!.result, 'ok');
  assert.equal(run!.trial, true);
  // The secret is masked in what the command printed.
  assert.equal(run!.output, 'RunEnded text *** 2');
  assert.deepEqual(plugins.logOf('acme.push'), [run]);
  assert.deepEqual(plugins.logOf('acme.push', true), []);
  await assert.rejects(plugins.attempt('acme.push', 'DeviceOnline'), {
    code: 'plugin_event_unhandled',
  });
  await assert.rejects(plugins.attempt('acme.push', 'Nothing'), { code: 'plugin_event_unknown' });
});

test('an event reaches the enabled plugins whose matchers it meets, and a command that fails or overruns is marked', async (t) => {
  const { data, plugins } = fixture(t);
  plugin(data, 'a', {
    hooks: {
      RunEnded: [
        { matcher: 'completed', hooks: node('${CLAUDE_PLUGIN_ROOT}/ok.mjs')[0]!.hooks },
        { matcher: 'fail.*', hooks: node('${CLAUDE_PLUGIN_ROOT}/fail.mjs')[0]!.hooks },
      ],
      DeviceOnline: node('${CLAUDE_PLUGIN_ROOT}/slow.mjs', { timeout: 0.3 }),
    },
    files: {
      'ok.mjs': 'process.stdin.resume();\n',
      'fail.mjs': "console.error('no luck');\nprocess.exit(3);\n",
      'slow.mjs': 'setTimeout(() => {}, 30_000);\n',
    },
  });
  plugins.start();
  const runs = (count: number) => {
    const log = plugins.logOf('a');
    return log.length >= count ? log : undefined;
  };
  plugins.dispatch(event('RunEnded', { status: 'completed', session_id: 's' }));
  const [ok] = await until(() => runs(1), 'a run');
  assert.deepEqual([ok!.result, ok!.sessionId, ok!.trial], ['ok', 's', undefined]);
  assert.equal(plugins.list()[0]!.failure, undefined);
  plugins.dispatch(event('RunEnded', { status: 'failed' }));
  const failed = (await until(() => runs(2), 'a failure'))[1]!;
  assert.deepEqual([failed.result, failed.exitCode, failed.output], ['failed', 3, 'no luck']);
  assert.equal(plugins.list()[0]!.failure?.result, 'failed');
  plugins.dispatch(event('DeviceOnline'));
  assert.equal((await until(() => runs(3), 'a timeout'))[2]!.result, 'timeout');
  plugins.enable('a', false);
  assert.equal(plugins.any(), false);
  plugins.dispatch(event('RunEnded', { status: 'completed' }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(plugins.logOf('a').length, 3);
});

test('a plugin put in place while the service runs is read a moment later', async (t) => {
  const { data, plugins, told } = fixture(t);
  plugins.start();
  assert.deepEqual(plugins.list(), []);
  const before = told();
  const late = () => plugin(data, 'late', { hooks: { RunEnded: node('x.mjs') } });
  late();
  // On macOS the watch starts a moment after it is asked for, and a change made in that moment goes unheard: the
  // plugin is written again until it is read. Nothing but the watch reads it after the start.
  const again = setInterval(late, 1000);
  try {
    await until(() => (plugins.list().length ? true : undefined), 'the plugin read');
  } finally {
    clearInterval(again);
  }
  assert.ok(told() > before);
});
