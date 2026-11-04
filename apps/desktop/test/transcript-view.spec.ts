import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

// Two turns, each with a thought, a command and an answer. The second is the latest; with `running` it is still going,
// with a note said between two commands.
async function open(
  page: import('@playwright/test').Page,
  view: Record<string, string> | undefined,
  running = false,
  // The second question is put in while the run of the first goes on: one run, two turns.
  joined = false,
  // How the last run ends.
  ending = 'completed',
  // With `joined`: Claude answers the first question and only background tasks go on when the second is put in.
  background = false,
) {
  await page.addInitScript(
    (saved) => localStorage.setItem('proxy-prefs', JSON.stringify(saved)),
    view ? { view } : {},
  );
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  // Each turn is a run of its own: one run's end must not end the other turn.
  const first = randomUUID();
  const runs = [first, joined ? first : randomUUID()];
  const questions = [randomUUID(), randomUUID()];
  const session: Session = {
    id: randomUUID(),
    title: '步骤展示',
    autoTitle: false,
    projectPath: 'D:\\工作\\步骤',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  await page.routeWebSocket('ws://127.0.0.1:18894/ws', (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    let sequence = 0;
    let runId = runs[0];
    const event = (createdAt: Date, payload: unknown) => ({
      sessionId: session.id,
      runId,
      sequence: ++sequence,
      createdAt: createdAt.toISOString(),
      payload,
    });
    const turn = (n: number, at: number, done: boolean, status = 'completed', waiting = false) => {
      const thought = randomUUID();
      runId = runs[n];
      return [
        event(minutesAgo(at), {
          type: 'message.user',
          messageId: questions[n],
          text: `第${n + 1}问`,
          scenario: 'chat',
        }),
        event(minutesAgo(at - 0.1), {
          type: 'thinking.delta',
          messageId: thought,
          text: `**${n + 1} 号目录先看看**\n再决定怎么做`,
        }),
        event(minutesAgo(at - 0.2), {
          type: 'tool.requested',
          toolId: `t${n}a`,
          name: 'Bash',
          input: JSON.stringify({ command: 'ls', description: `列目录${n + 1}` }),
          target: 'Windows',
        }),
        ...(true
          ? [
              event(minutesAgo(at - 0.3), {
                type: 'tool.result',
                toolId: `t${n}a`,
                status: 'completed',
                output: 'a b',
                exitCode: 0,
              }),
            ]
          : []),
        ...(done
          ? [
              event(minutesAgo(at - 0.4), {
                type: 'text.delta',
                messageId: randomUUID(),
                text: `第${n + 1}答。`,
              }),
              event(minutesAgo(at - 0.5), {
                type: 'run.status',
                status,
                connectionId,
                ...(waiting ? { waiting: 'background' } : {}),
              }),
            ]
          : [
              event(minutesAgo(at - 0.35), {
                type: 'text.delta',
                messageId: randomUUID(),
                text: '中途说明',
              }),
              event(minutesAgo(at - 0.4), {
                type: 'tool.requested',
                toolId: `t${n}b`,
                name: 'Bash',
                input: JSON.stringify({ command: 'pwd', description: '看当前目录' }),
                target: 'Windows',
              }),
            ]),
      ];
    };
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth') {
        reply({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId,
          adapter: 'claude-code',
          sessions: [session],
        });
        return;
      }
      if (message.type === 'session.subscribe') {
        reply({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: sequence,
          hasEarlier: false,
          events: [
            ...turn(0, 40, !joined || background, background ? 'running' : 'completed', background),
            ...turn(1, 10, !running, ending),
          ],
        });
      }
      reply({ type: 'response', requestId: message.requestId, ok: true });
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
  await expect(page.locator('.message.user')).toHaveCount(2);
}

test('by default each finished turn folds into one line and its calls are grouped as before', async ({
  page,
}) => {
  await open(page, undefined);
  await expect(page.locator('.turn-process')).toHaveCount(2);
  await expect(page.locator('.turn-process[open]')).toHaveCount(0);
  await expect(page.locator('.work-flat')).toHaveCount(0);
  await expect(page.locator('.thinking-preview')).toHaveCount(0);
});

test('standard keeps one group per run of calls while a turn runs', async ({ page }) => {
  await open(page, { mode: 'standard' }, true);
  await expect(page.locator('.work')).toHaveCount(2);
});

test('expanded folds nothing and groups nothing', async ({ page }) => {
  await open(page, { mode: 'expanded' });
  await expect(page.locator('.turn-process')).toHaveCount(0);
  await expect(page.locator('.work')).toHaveCount(0);
  await expect(page.locator('.work-flat')).toHaveCount(2);
  await expect(page.locator('.work-flat .tool-subject')).toHaveText(['列目录1', '列目录2']);
  // The first line of each thought, without its Markdown; a number it starts with stays.
  await expect(page.locator('.thinking-preview')).toHaveText(['1 号目录先看看', '2 号目录先看看']);
});

test('the settings choose how much of the work is shown', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '本机设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '外观', exact: true })
    .click();
  const mode = page.getByRole('radiogroup', { name: '工作步骤展示' });
  await expect(mode.getByRole('radio', { name: '标准' })).toBeChecked();
  await mode.getByRole('radio', { name: '全部展开' }).click();
  await expect(mode.getByRole('radio', { name: '全部展开' })).toBeChecked();
  // Checked is not enough: the one chosen must also look chosen.
  const colorOf = (name: string) =>
    mode.getByRole('radio', { name }).evaluate((el) => getComputedStyle(el).color);
  expect(await colorOf('全部展开')).not.toBe(await colorOf('标准'));
  await expect(page.getByText('也不自动收起')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('proxy-prefs')!).view)).toEqual({
    mode: 'expanded',
  });
});
test('a question put in while the run goes on does not fold what came before it', async ({
  page,
}) => {
  await open(page, { mode: 'standard' }, true, true);
  // The first turn is closed by the second question, but the run is not over.
  await expect(page.locator('.turn-process')).toHaveCount(0);
  await expect(page.locator('.work > summary').first()).toBeVisible();
});

test('once that run is over, both turns fold as usual', async ({ page }) => {
  await open(page, { mode: 'standard' }, false, true);
  await expect(page.locator('.turn-process')).toHaveCount(2);
  // The first turn took until the second question, not until the end of the run.
  await expect(page.locator('.turn-process > summary').nth(0)).toContainText('用时 30 分 0 秒');
});

test('a question put in while only background tasks go on ends the turn before it where Claude stopped', async ({
  page,
}) => {
  await open(page, { mode: 'standard' }, false, true, 'completed', true);
  await expect(page.locator('.turn-process > summary').nth(0)).toContainText('用时 30 秒');
});
test('a turn that was stopped, or failed, says so on its folded line', async ({ page }) => {
  await open(page, undefined, false, false, 'cancelled');
  const lines = page.locator('.turn-process > summary');
  await expect(lines.nth(0)).not.toContainText('已停止');
  await expect(lines.nth(1)).toContainText('已停止 · 用时');
  await page.goto('about:blank');
  await open(page, undefined, false, false, 'failed');
  await expect(page.locator('.turn-process > summary').nth(1)).toContainText('处理失败 · 用时');
});

test('a question put in while the run goes on does not make the turn before it stopped', async ({
  page,
}) => {
  // One run, two turns; the run is stopped during the second.
  await open(page, undefined, false, true, 'cancelled');
  const lines = page.locator('.turn-process > summary');
  await expect(lines.nth(0)).not.toContainText('已停止');
  await expect(lines.nth(1)).toContainText('已停止');
});
