import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

// A long session whose replies differ in height: lists, code and tables, so that what the page guesses for a
// reply not yet drawn is off, and the view must keep to its end while the real heights come in.
const turns = 60;

function reply(n: number) {
  const lines = Array.from(
    { length: (n % 7) + 2 },
    (_, i) => `- 第${n}轮的第${i + 1}点，说明写得长一些，好让它在窗口里换行。`,
  );
  const code = Array.from({ length: (n % 5) * 3 }, (_, i) => `echo ${n}-${i}`).join('\n');
  return [
    `第${n}轮的回答。`,
    ...lines,
    code ? '```sh\n' + code + '\n```' : '',
    `| 列 | 值 |\n| --- | --- |\n| ${n} | ${n * 2} |`,
  ].join('\n\n');
}

// Opens the session; what is returned starts a reply streaming into it, fast, and stops it when called.
async function open(page: Page, historyFailure = '') {
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  let stream = (): (() => void) => () => {};
  const session: Session = {
    id: randomUUID(),
    title: '长对话',
    autoTitle: false,
    projectPath: 'D:\\工作\\长对话',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  await page.routeWebSocket('ws://127.0.0.1:18894/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    let sequence = 0;
    const start = Date.now() - 3_600_000;
    const events: unknown[] = [];
    for (let n = 0; n < turns; n++) {
      const runId = randomUUID();
      const event = (payload: unknown) => ({
        sessionId: session.id,
        runId,
        sequence: ++sequence,
        createdAt: new Date(start + sequence * 1000).toISOString(),
        payload,
      });
      events.push(
        event({
          type: 'message.user',
          messageId: randomUUID(),
          text: `第${n}问`,
          scenario: 'chat',
        }),
        event({
          type: 'tool.requested',
          toolId: `t${n}`,
          name: 'Bash',
          input: JSON.stringify({ command: 'ls', description: `看一看${n}` }),
          target: 'Windows',
        }),
        event({
          type: 'tool.result',
          toolId: `t${n}`,
          status: 'completed',
          output: 'a',
          exitCode: 0,
        }),
        event({ type: 'text.delta', messageId: randomUUID(), text: reply(n) }),
        event({ type: 'run.status', status: 'completed', connectionId }),
      );
    }
    stream = () => {
      const messageId = randomUUID();
      let n = 0;
      const timer = setInterval(() => {
        send({
          type: 'session.event',
          event: {
            sessionId: session.id,
            runId: randomUUID(),
            sequence: ++sequence,
            createdAt: new Date().toISOString(),
            payload: {
              type: 'text.delta',
              messageId,
              text: `\n\n流式输出第${++n}段，写得长一些，好让它在窗口里换行，页面跟着变高。`,
            },
          },
        });
      }, 20);
      return () => clearInterval(timer);
    };
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId,
          adapter: 'claude-code',
          sessions: [session],
        });
        return;
      }
      if (message.type === 'session.subscribe')
        send({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: sequence,
          hasEarlier: !!historyFailure,
          events,
        });
      if (message.type === 'session.history' && historyFailure) {
        send({
          type: 'response',
          requestId: message.requestId,
          ok: false,
          message: historyFailure,
        });
        return;
      }
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18894/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-view-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  await expect(page.getByText(`第${turns - 1}轮的回答。`)).toBeVisible();
  return () => stream();
}

// How far the view is from the end of the conversation, once it has stopped moving.
async function fromEnd(page: Page) {
  const conversation = page.locator('.conversation');
  let last = -1;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100);
    const now = await conversation.evaluate((box) => box.scrollTop);
    if (now === last) break;
    last = now;
  }
  return conversation.evaluate((box) => box.scrollHeight - box.scrollTop - box.clientHeight);
}

test('a long conversation opens at its end', async ({ page }) => {
  await open(page);
  expect(await fromEnd(page)).toBeLessThan(2);
});

test.describe('narrow conversation navigation', () => {
  test.use({ viewport: { width: 600, height: 900 }, hasTouch: true });

  test('mouse selection leaves the drawer closed', async ({ page }) => {
    await open(page);
    await page.locator('.conversation').hover();
    await page.mouse.wheel(0, -200);
    await fromEnd(page);
    const text = page.locator('.message.assistant').last().locator('.message-content p').first();
    await text.scrollIntoViewIfNeeded();
    const box = (await text.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 180, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('轮的回答');
    await expect(page.locator('.shell')).toHaveClass(/side-closed/);
  });

  test('touch swipes still open and close the drawer', async ({ page, context }) => {
    await open(page);
    const touch = await context.newCDPSession(page);
    async function swipe(from: number, to: number) {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: from, y: 200 }],
      });
      for (let step = 1; step <= 8; step++)
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: from + ((to - from) * step) / 8, y: 200 }],
        });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await swipe(60, 250);
    await expect(page.locator('.shell')).not.toHaveClass(/side-closed/);
    await expect(page.getByRole('button', { name: '设置与账号', exact: true })).toBeVisible();
    await swipe(250, 60);
    await expect(page.locator('.shell')).toHaveClass(/side-closed/);
  });
});

test('approaching the top preloads history and preserves the actual failure reason', async ({
  page,
}) => {
  const reason = '历史传输连续 30 秒没有收到接收确认，请重试。';
  await open(page, reason);
  await page.locator('.conversation').evaluate((box) => {
    box.scrollTop = 200;
  });
  await expect(page.getByText(reason, { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '加载更早记录', exact: true })).toBeEnabled();
});

test('coming back from the settings, the conversation is at its end again', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await expect(page.getByText(`第${turns - 1}轮的回答。`)).toBeVisible();
  expect(await fromEnd(page)).toBeLessThan(2);
});

test('a resized window keeps to the end, and one read further up stays where it is', async ({
  page,
}) => {
  await open(page);
  await page.setViewportSize({ width: 1000, height: 700 });
  expect(await fromEnd(page)).toBeLessThan(2);
  const conversation = page.locator('.conversation');
  await conversation.hover();
  await page.mouse.wheel(0, -1500);
  const before = await fromEnd(page);
  expect(before).toBeGreaterThan(500);
  await page.setViewportSize({ width: 1100, height: 760 });
  expect(await fromEnd(page)).toBeGreaterThan(300);
});

test('opening the steps of the last turn does not pull them out of sight', async ({ page }) => {
  await open(page);
  expect(await fromEnd(page)).toBeLessThan(2);
  const summary = page.locator('.turn-process > summary').last();
  await summary.click();
  await expect(page.locator('.turn-process').last()).toHaveAttribute('open', '');
  await fromEnd(page);
  await expect(summary).toBeInViewport();
});

test('while output streams in fast, a reader scrolling up a little is not pulled back to the end', async ({
  page,
}) => {
  const stream = await open(page);
  const conversation = page.locator('.conversation');
  const back = page.getByRole('button', { name: '回到底部', exact: true });
  expect(await fromEnd(page)).toBeLessThan(2);
  await expect(back).toHaveCount(0);
  const stop = stream();
  await page.waitForTimeout(300);
  // One notch at a time, slower than the output comes in.
  await conversation.hover();
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -60);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(800);
  const read = await conversation.evaluate((box) => box.scrollTop);
  await page.waitForTimeout(500);
  expect(await conversation.evaluate((box) => box.scrollTop)).toBe(read);
  await expect(back).toBeVisible();
  // The button brings the view down, and it follows the output from there.
  await back.click();
  await expect(back).toHaveCount(0);
  await page.waitForTimeout(500);
  stop();
  expect(await fromEnd(page)).toBeLessThan(2);
  // Scrolling all the way down by hand follows again as well. Each turn of the wheel goes past where the end is as
  // it is taken: a fixed step would never get there on a machine slow enough that the page grows faster than it.
  const again = stream();
  await page.mouse.wheel(0, -400);
  await expect(back).toBeVisible();
  for (let i = 0; i < 20 && (await back.count()); i++) {
    const gap = await conversation.evaluate(
      (box) => box.scrollHeight - box.scrollTop - box.clientHeight,
    );
    await page.mouse.wheel(0, gap + 400);
    await page.waitForTimeout(100);
  }
  await expect(back).toHaveCount(0);
  await page.waitForTimeout(500);
  again();
  expect(await fromEnd(page)).toBeLessThan(2);
});
