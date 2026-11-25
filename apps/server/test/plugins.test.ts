import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EventPayload, Session } from '@cc-desk-tunnel/protocol';
import { matches } from '../src/plugin-hooks.ts';
import { Plugins } from '../src/plugins.ts';
import { EVENTS_VERSION, ServiceEvents } from '../src/service-events.ts';
import type { ServiceEvent } from '../src/service-events.ts';

test('a matcher is names or a regular expression, as in Claude Code', () => {
  assert.ok(matches(undefined, 'Bash') && matches('*', 'Bash') && matches('Edit | Bash', 'Bash'));
  assert.ok(!matches('Bash', 'BashOutput'));
  assert.ok(matches('^mcp__.*', 'mcp__memory__read') && !matches('^mcp__.*', 'Bash'));
  assert.throws(() => matches('^(\\w+)+!$', 'a'.repeat(60)), /timed out/);
});

test('a broken plugin and one that does not end leave the others alone, and each log says how it went', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-plugins-'));
  const plugins = new Plugins(directory);
  t.after(() => {
    plugins.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const add = (name: string, text: string) => {
    mkdirSync(join(directory, 'plugins', name, 'hooks'), { recursive: true });
    writeFileSync(join(directory, 'plugins', name, 'hooks', 'hooks.json'), text);
  };
  const script = (code: string, timeout: number) =>
    JSON.stringify({
      hooks: {
        RunEnded: [
          {
            hooks: [{ type: 'command', command: process.execPath, args: ['-e', code], timeout }],
          },
        ],
      },
    });
  add('t.a-broken', '{');
  add('t.b-hangs', script('setInterval(() => {}, 1000)', 0.5));
  add('t.c-fails', script('console.error("no token"); process.exit(3)', 10));
  add('t.d-works', script('console.log("sent")', 10));
  const logged = (name: string) => {
    try {
      return readFileSync(join(directory, 'plugin-logs', `${name}.log`), 'utf8');
    } catch {
      return '';
    }
  };
  await plugins.start();
  plugins.dispatch({
    version: EVENTS_VERSION,
    hook_event_name: 'RunEnded',
    timestamp: new Date().toISOString(),
    status: 'completed',
  });
  const all = ['t.a-broken', 't.b-hangs', 't.c-fails', 't.d-works'];
  for (const deadline = Date.now() + 10_000; !all.every(logged) && Date.now() < deadline;)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(logged('t.a-broken'), /加载失败：/);
  assert.match(logged('t.b-hangs'), /RunEnded → 超时 0\.5s，已结束 \d+ms\n$/);
  assert.match(logged('t.c-fails'), /RunEnded → 退出 3 \d+ms\n    no token\n$/);
  assert.match(logged('t.d-works'), /RunEnded → 成功 \d+ms\n    sent\n$/);
});

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
