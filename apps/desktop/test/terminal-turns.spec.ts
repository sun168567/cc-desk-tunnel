import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { EventPayload, Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

const folder = resolve(screenshots, '终端轮次');
mkdirSync(folder, { recursive: true });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(folder, `${name}.png`) });

const connectionId = randomUUID();
const started = Date.now() - 20 * 60_000;
const minute = (n: number) => new Date(started + n * 60_000).toISOString();
const session = (title: string, terminal?: string): Session => ({
  id: randomUUID(),
  title,
  autoTitle: false,
  projectPath: 'D:\\工作\\终端',
  permissionMode: 'default',
  model: null,
  effort: null,
  createdAt: minute(0),
  updatedAt: minute(0),
  activeRun: terminal
    ? { id: terminal, status: 'running', connectionId, surface: 'terminal', activity: 'working' }
    : null,
});
// One conversation: a question answered after a look with a tool, the model changed, a compaction, and a question
// still being worked on; as chat runs record it, or as one terminal that continues the session.
function conversation(sessionId: string, terminal?: string) {
  const events: SessionEvent[] = [];
  let runId = terminal ?? randomUUID();
  const add = (at: number, payload: EventPayload) =>
    events.push({ sessionId, runId, sequence: events.length + 1, createdAt: minute(at), payload });
  const status = (at: number, activity: 'working' | 'idle') =>
    terminal
      ? add(at, {
          type: 'run.status',
          status: 'running',
          connectionId,
          surface: 'terminal',
          activity,
        })
      : activity === 'working'
        ? add(at, { type: 'run.status', status: 'running', connectionId })
        : add(at, { type: 'run.status', status: 'completed', connectionId });
  const turn = (at: number, text: string) => {
    if (!terminal) runId = randomUUID();
    status(at, 'working');
    add(at, { type: 'message.user', messageId: randomUUID(), text, scenario: 'chat' });
  };
  const said = (at: number, text: string) =>
    add(at, { type: 'text.delta', messageId: randomUUID(), text });
  const tool = (at: number, toolId: string, done = true) => {
    add(at, {
      type: 'tool.requested',
      toolId,
      name: 'Bash',
      input: '{"command":"ls"}',
      target: 'Linux',
    });
    if (done)
      add(at, { type: 'tool.result', toolId, status: 'completed', output: 'a.txt', exitCode: 0 });
  };
  if (terminal)
    add(0, {
      type: 'run.status',
      status: 'running',
      connectionId,
      surface: 'terminal',
      activity: 'idle',
    });
  turn(1, '看看目录里有什么');
  said(1, '先列一下目录。');
  tool(2, randomUUID());
  said(3, '目录里只有一个文件 a.txt。');
  status(3, 'idle');
  add(3, {
    type: 'native.metrics',
    context: {
      model: 'claude-opus-5-5',
      usedTokens: 150_000,
      windowTokens: 1_000_000,
      percentage: 15,
      measuredAt: minute(3),
      categories: [],
    },
    usage: null,
    rateLimits: null,
    cacheTtl: '1h',
  });
  if (terminal)
    add(4, { type: 'native.notice', text: '在终端里执行了 /model：Set model to Opus 5.5' });
  turn(5, '/compact');
  add(6, { type: 'native.compact', trigger: 'manual', previousTokens: 447294 });
  status(6, 'idle');
  turn(10, '再看看 a.txt 里写了什么');
  said(10, '读一下这个文件。');
  tool(11, 'toolu_live', false);
  return { events, add, said, status };
}

test("a terminal's turns fold as a chat's do, each once its CLI waits for the next prompt", async ({
  page,
}) => {
  const terminal = randomUUID();
  const chat = session('图形界面里的会话');
  const held = session('终端里的会话', terminal);
  const chats = conversation(chat.id);
  const terminals = conversation(held.id, terminal);
  const recorded = { [chat.id]: chats.events, [held.id]: terminals.events };
  let send: (value: unknown) => void = () => {};
  await page.routeWebSocket('ws://127.0.0.1:18898/ws', (route) => {
    send = (value) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth')
        return send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [chat, held],
        });
      if (message.type === 'session.subscribe') {
        const events = recorded[message.sessionId];
        send({
          type: 'session.snapshot',
          requestId: message.requestId,
          session: message.sessionId === chat.id ? chat : held,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: events.length,
          hasEarlier: false,
          events,
        });
      }
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18898/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-terminal-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const transcript = page.locator('.transcript');
  const open = async (title: string) => {
    await page
      .locator('.session-row')
      .filter({ hasText: title })
      .locator('.session-select')
      .click();
    await expect(transcript).toContainText('读一下这个文件。');
  };

  await open('图形界面里的会话');
  await shot(page, '01-图形界面');
  await open('终端里的会话');
  await shot(page, '02-终端');

  // The finished question shows as the chat's does: the question, its time and the answer, with the work folded.
  const folds = page.locator('.turn-process');
  await expect(folds).toHaveCount(1);
  await expect(folds.first()).not.toHaveAttribute('open');
  await expect(folds.first()).toContainText('1 步');
  await expect(transcript).toContainText('目录里只有一个文件 a.txt。');
  await expect(page.getByText('先列一下目录。')).toBeHidden();
  // What the terminal changed is one line under that answer, and the compaction one mark.
  const text = await transcript.innerText();
  const note = text.indexOf('在终端里执行了 /model');
  expect(note).toBeGreaterThan(text.indexOf('目录里只有一个文件 a.txt。'));
  expect(note).toBeLessThan(text.indexOf('/compact'));
  await expect(page.locator('.compact-mark')).toContainText('上下文已压缩');
  // The question still being worked on shows its work; questions asked here are not the run's add-ons.
  await expect(page.getByText('读一下这个文件。')).toBeVisible();
  await expect(page.locator('.message.user.joined')).toHaveCount(0);
  // The turn just ended wrote a one-hour cache: nothing to remind of.
  await expect(page.locator('.idle-reminder')).toHaveCount(0);

  // Its answer comes a moment after the CLI waits for the next prompt, and it folds as well.
  let sequence = terminals.events.length;
  const next = (payload: EventPayload) =>
    send({
      type: 'session.event',
      event: {
        sessionId: held.id,
        runId: terminal,
        sequence: ++sequence,
        createdAt: new Date().toISOString(),
        payload,
      },
    });
  next({
    type: 'tool.result',
    toolId: 'toolu_live',
    status: 'completed',
    output: 'hello',
    exitCode: 0,
  });
  next({
    type: 'run.status',
    status: 'running',
    connectionId,
    surface: 'terminal',
    activity: 'idle',
  });
  next({ type: 'text.delta', messageId: randomUUID(), text: 'a.txt 里写的是 hello。' });
  await expect(transcript).toContainText('a.txt 里写的是 hello。');
  await expect(folds).toHaveCount(2);
  await expect(page.getByText('读一下这个文件。')).toBeHidden();
  await shot(page, '03-终端最后一轮结束');
});
