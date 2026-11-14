import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const planText = `# 计划阅读与执行流程

让最终计划在聊天中清晰可读，并让批准后的执行模式与会话状态保持一致。

## 阅读体验

- 按原文展示标题、列表、表格和代码，不改写计划内容。
- 长计划可以在聊天中展开，也可以放大阅读；复制时保留完整 Markdown。
- 阅读期间保持当前位置，审批操作始终清楚可见。

## 批准后如何执行

| 执行方式 | 验收条件 |
| --- | --- |
| 自动审批 | 由 Claude 判断风险，必要时询问 |
| 手动审批 | 对需要授权的操作逐项确认 |
| 接受编辑 | 文件编辑直接通过，命令仍按原生规则审批 |

选择执行模式后点击 **批准并执行**。需要调整计划时，选择 **继续规划**。

## 接口与状态同步

模式选择通过 SDK 的官方审批结果传递，仅作用于当前会话：

\`\`\`ts
updatedPermissions: [
  { type: 'setMode', mode: selectedMode, destination: 'session' }
]
\`\`\`

提交审批后先等待原生确认。收到实际模式更新，再同步输入框底部的模式和保存的会话设置。

## 验证范围

1. 使用模拟数据检查长短计划、复制、搜索和放大阅读。
2. 检查批准、拒绝、重复点击及断线重连后的显示。
3. 检查深浅色、窄屏和键盘操作，确保内容与按钮不溢出。

所有验证使用本地测试与模拟数据，不运行真实模型或 Claude CLI。

计划末尾唯一词。`;

async function openPlan(
  page: import('@playwright/test').Page,
  input = JSON.stringify({ plan: planText }),
) {
  const now = new Date().toISOString();
  const connectionId = randomUUID(),
    runId = randomUUID(),
    approvalId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '计划阅读',
    autoTitle: false,
    projectPath: '/tmp/plan-test',
    permissionMode: 'plan',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: { id: runId, status: 'awaiting_approval', connectionId, waiting: 'approval' },
  };
  let sequence = 0;
  const event = (payload: unknown) => ({
    sessionId: session.id,
    runId,
    sequence: ++sequence,
    createdAt: now,
    payload,
  });
  const events = [
    event({
      type: 'message.user',
      messageId: randomUUID(),
      text: '给出执行计划',
      scenario: 'chat',
    }),
    event({
      type: 'tool.requested',
      toolId: 'plan-tool',
      name: 'ExitPlanMode',
      input,
      target: 'Linux',
    }),
    event({ type: 'approval.requested', approvalId, toolId: 'plan-tool' }),
    event({ type: 'run.status', ...session.activeRun }),
  ];
  const replies: { allowed: boolean; executionMode?: 'auto' | 'default' | 'acceptEdits' }[] = [];
  let send: (message: unknown) => void;
  const publish = (payload: unknown) => {
    const next = event(payload);
    events.push(next);
    send({ type: 'session.event', event: next });
  };
  await page.routeWebSocket('ws://127.0.0.1:18913/ws', (route) => {
    send = (value) => route.send(JSON.stringify(value));
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
          hasEarlier: false,
          events,
        });
      if (message.type === 'approval.reply') replies.push(message);
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18913/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-plan-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  return {
    replies,
    resolve(allowed: boolean, executionMode?: 'auto' | 'default' | 'acceptEdits') {
      publish({ type: 'approval.resolved', approvalId, allowed, executionMode });
      session.activeRun = { id: runId, status: 'running', connectionId };
      send({ type: 'session.updated', session });
    },
    confirm(mode: 'auto' | 'default' | 'acceptEdits') {
      publish({ type: 'native.permission', permissionMode: mode });
      session.permissionMode = mode;
      send({ type: 'session.updated', session });
      publish({
        type: 'tool.result',
        toolId: 'plan-tool',
        status: 'completed',
        output: 'Plan approved.',
        exitCode: null,
      });
    },
    publish,
  };
}

test('plans render as documents, expand without a nested scroller, and support copy, search and enlarged reading', async ({
  page,
}) => {
  await openPlan(page);
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: async (text: string) => {
        (window as unknown as { copied: string }).copied = text;
      },
    }),
  );
  const card = page.locator('.plan-card');
  await expect(card.getByRole('heading', { name: '计划阅读与执行流程' })).toBeVisible();
  await expect(card.locator('table')).toContainText('验收条件');
  await expect(card.getByRole('button', { name: '展开全文', exact: true })).toBeVisible();
  await expect
    .poll(() => card.locator('.plan-preview').evaluate((el) => el.clientHeight))
    .toBe(480);
  await card.getByRole('button', { name: '复制计划', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(
    planText,
  );
  const conversation = page.locator('.conversation');
  await card.getByRole('button', { name: '展开全文', exact: true }).click();
  const top = await conversation.evaluate((el) => el.scrollTop);
  await expect
    .poll(() => card.locator('.plan-preview').evaluate((el) => el.clientHeight > 480))
    .toBe(true);
  await expect.poll(() => conversation.evaluate((el) => el.scrollTop)).toBeCloseTo(top, 0);
  await card.getByRole('button', { name: '收起', exact: true }).click();
  await page.getByRole('button', { name: '打开对话查找', exact: true }).click();
  await page.getByRole('textbox', { name: '查找对话内容' }).fill('计划末尾唯一词');
  await expect(page.locator('.find-count')).toHaveText('1 / 1');
  await expect(card.locator('.plan-preview')).toHaveClass(/expanded/);
  await page.getByRole('button', { name: '关闭查找（Esc）' }).click();
  mkdirSync(resolve('.local/screenshots'), { recursive: true });
  await card.screenshot({ path: resolve('.local/screenshots/plan-card.png') });
  await card.getByRole('button', { name: '放大阅读', exact: true }).click();
  const reader = page.getByRole('dialog', { name: '执行计划' });
  await expect(reader).toBeVisible();
  await expect(reader.getByRole('button', { name: '批准并执行', exact: true })).toBeInViewport();
  await reader.locator('.plan-reader-body').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(reader.getByText('计划末尾唯一词。', { exact: true })).toBeInViewport();
  await expect(reader.getByRole('button', { name: '批准并执行', exact: true })).toBeInViewport();
  mkdirSync(resolve('.local/screenshots'), { recursive: true });
  await reader.locator('.plan-reader-body').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: resolve('.local/screenshots/plan-reader-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: resolve('.local/screenshots/plan-reader-dark.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(reader.getByRole('button', { name: '批准并执行', exact: true })).toBeInViewport();
  expect(await reader.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: resolve('.local/screenshots/plan-reader-mobile.png') });
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);
  await expect(card.getByRole('button', { name: '放大阅读', exact: true })).toBeFocused();
});

test('plan selection, approval and native confirmation share state across the card, reader and reconnect', async ({
  page,
}) => {
  const plan = await openPlan(page, JSON.stringify({ plan: '# 小计划\n\n确认后执行。' }));
  const card = page.locator('.plan-card');
  await expect(card.getByRole('button', { name: '展开全文', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: '计划执行模式' })).toHaveText('自动审批');
  await card.getByRole('button', { name: '放大阅读', exact: true }).click();
  const reader = page.getByRole('dialog', { name: '执行计划' });
  await reader.getByRole('button', { name: '计划执行模式' }).click();
  const modes = reader.getByRole('menu', { name: '计划执行模式' });
  await expect(modes.getByRole('menuitemradio')).toHaveCount(3);
  await modes.getByRole('menuitemradio', { name: '手动审批', exact: true }).click();
  expect(plan.replies).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(card.getByRole('button', { name: '计划执行模式' })).toHaveText('手动审批');
  const approve = card.getByRole('button', { name: '批准并执行', exact: true });
  await approve.evaluate((el) => {
    (el as HTMLButtonElement).click();
    (el as HTMLButtonElement).click();
  });
  await expect.poll(() => plan.replies.length).toBe(1);
  expect(plan.replies[0]).toMatchObject({ allowed: true, executionMode: 'default' });
  await expect(approve).toBeDisabled();
  await expect(card).toContainText('已提交，等待原生确认');
  await expect(page.getByRole('button', { name: '审批模式', exact: true })).toHaveText('计划模式');
  plan.resolve(true, 'default');
  await expect(card).toContainText('已提交，等待原生确认');
  plan.confirm('default');
  await expect(page.getByRole('button', { name: '审批模式', exact: true })).toHaveText('手动审批');
  await expect(card).toContainText('已批准 · 原生模式：手动审批');
  await page.reload();
  // Browser simulation does not save a service token; reconnect with it as the user does.
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-plan-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator('.session-row')
    .filter({ hasText: '计划阅读' })
    .locator('.session-select')
    .click();
  await expect(page.locator('.plan-card')).toContainText('已批准 · 原生模式：手动审批');
  await expect(page.getByRole('button', { name: '审批模式', exact: true })).toHaveText('手动审批');
});

test('continuing to plan sends a denial without changing mode; incomplete input remains inspectable', async ({
  page,
}) => {
  const plan = await openPlan(page, '{"plan":');
  await expect(page.locator('.plan-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '复制工具输入', exact: true })).toBeVisible();
  plan.publish({
    type: 'tool.input',
    toolId: 'plan-tool',
    input: JSON.stringify({ plan: '# 继续调研\n\n还需讨论。' }),
  });
  const card = page.locator('.plan-card');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '继续规划', exact: true }).click();
  await expect.poll(() => plan.replies.length).toBe(1);
  expect(plan.replies[0].allowed).toBe(false);
  expect(plan.replies[0].executionMode).toBeUndefined();
  plan.resolve(false);
  await expect(card).toContainText('已拒绝');
  await expect(page.getByRole('button', { name: '审批模式', exact: true })).toHaveText('计划模式');
});

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
