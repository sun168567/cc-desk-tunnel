import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import { login, createSession, send, settled } from './helpers.ts';

// Pictures of the plan card for a review, when asked for.
const shot = async (page: Page, name: string) => {
  if (process.env.PLAN_SHOTS)
    await page.screenshot({ path: resolve(process.env.PLAN_SHOTS, `${name}.png`) });
};

test("Claude's plan is read as a document and carried out in a mode chosen, as written or changed, or sent back", async ({
  page,
}) => {
  test.slow();
  await page.goto('/');
  await login(page);
  await createSession(page, '计划');

  // Claude goes into plan mode by itself, and asks to carry out the plan it wrote.
  await send(page, '整理一下设置页', 'plan');
  await expect(page.getByText('Claude 进入了计划模式', { exact: false })).toBeVisible();
  const card = page.getByRole('region', { name: 'Claude 的计划' }).last();
  await expect(card).toContainText('整理设置页');
  await expect(card).toContainText('simulated-plan.md');
  await expect(page.getByRole('button', { name: '允许', exact: true })).toHaveCount(0);
  const modes = card.getByRole('radiogroup', { name: '执行时的审批模式' });
  // The mode the session was in before it planned is offered first.
  await expect(modes.getByRole('radio', { name: '自动审批' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await shot(page, '1-等待批准');

  // Read whole in a window of its own.
  await card.getByRole('button', { name: '全屏阅读', exact: true }).click();
  const reader = page.getByRole('dialog');
  await expect(reader).toContainText('补上说明文字和界面测试');
  await shot(page, '2-全屏阅读');
  await reader.getByRole('button', { name: '关闭', exact: true }).click();

  // Approved in another mode: the session works in it from then on.
  await modes.getByRole('radio', { name: '接受编辑' }).click();
  await card.getByRole('button', { name: '开始执行', exact: true }).click();
  await settled(page);
  await expect(page.locator('.message.assistant').last()).toContainText('按批准的计划开始执行');
  const first = page.getByRole('region', { name: 'Claude 的计划' }).first();
  await expect(first.locator('.plan-outcome')).toHaveText('已批准 · 接受编辑');
  // What Claude Code changed is told among the steps, folded away with them.
  await page
    .getByText(/用时 .* 步/)
    .first()
    .click();
  await expect(page.getByText('审批模式改为「接受编辑」')).toBeVisible();
  // The turn over, the plan stays in view by its heading, outside the steps folded away.
  await expect(first.locator('.plan-body')).toHaveCount(0);
  await first.getByRole('button', { name: /计划/ }).first().click();
  await expect(first.locator('.plan-body')).toContainText('整理设置页');
  await shot(page, '3-已批准');

  // Changed before it is carried out; the mode before planning was the one just chosen.
  await send(page, '再计划一次', 'plan');
  const second = page.getByRole('region', { name: 'Claude 的计划' }).last();
  await expect(second.getByRole('radio', { name: '接受编辑' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await second.getByRole('button', { name: '修改计划', exact: true }).click();
  const editor = second.getByRole('textbox', { name: '修改计划' });
  await editor.fill('# 改过的计划\n\n1. 只拆分“常规”\n');
  await shot(page, '4-修改计划');
  await second.getByRole('button', { name: '按修改后的计划执行', exact: true }).click();
  await settled(page);
  const changed = page.getByRole('region', { name: 'Claude 的计划' }).nth(1);
  await expect(changed.locator('.plan-outcome')).toHaveText('已批准 · 接受编辑 · 已修改');
  await changed.getByRole('button', { name: /计划/ }).first().click();
  await expect(changed.locator('.plan-body')).toContainText('只拆分“常规”');

  // Sent back with what to change: Claude plans further.
  await send(page, '第三次', 'plan');
  const third = page.getByRole('region', { name: 'Claude 的计划' }).last();
  await third.getByRole('button', { name: '继续规划', exact: true }).click();
  await third.getByRole('textbox', { name: '哪里要改' }).fill('第二步先别做');
  await shot(page, '5-退回意见');
  await third.getByRole('button', { name: '退回，继续规划', exact: true }).click();
  await settled(page);
  await expect(page.locator('.message.assistant').last()).toContainText('按你的意见继续规划');
  const returned = page.getByRole('region', { name: 'Claude 的计划' }).last();
  await expect(returned.locator('.plan-outcome')).toHaveText('已退回，继续规划');
  await returned.getByRole('button', { name: /计划/ }).first().click();
  await expect(returned).toContainText('你的意见：第二步先别做');
  await shot(page, '6-已退回');

  // A long plan is read in part, and opened whole in place.
  await send(page, '来个长计划', 'plan');
  const long = page.getByRole('region', { name: 'Claude 的计划' }).last();
  const more = long.getByRole('button', { name: '展开全文', exact: true });
  await expect(more).toBeVisible();
  await expect(long.getByText('细节 30')).not.toBeInViewport();
  await shot(page, '7-长计划');
  await more.click();
  await long.getByText('细节 30').scrollIntoViewIfNeeded();
  await expect(long.getByText('细节 30')).toBeInViewport();
  await expect(long.getByRole('button', { name: '收起', exact: true })).toBeVisible();
  await long.getByRole('button', { name: '开始执行', exact: true }).click();
  await settled(page);
});

test('the shortcut goes through the modes; a session put in plan mode offers the mode it was in before', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  await createSession(page, '快捷键');
  // 自动审批 → 手动审批 → 接受编辑 → 计划模式.
  for (let press = 0; press < 3; press++) {
    await page.keyboard.press('Alt+Shift+KeyM');
    await page.waitForTimeout(300);
  }
  await send(page, '按计划来', 'plan');
  const card = page.getByRole('region', { name: 'Claude 的计划' }).last();
  await expect(card.getByRole('radio', { name: '接受编辑' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByText('Claude 进入了计划模式', { exact: false })).toHaveCount(0);
  await card.getByRole('button', { name: '开始执行', exact: true }).click();
  await settled(page);
});

test('in a window of the default size a long plan shows its heading and its decision together', async ({
  page,
}) => {
  // The content of the program's default window, 1240 × 850.
  await page.setViewportSize({ width: 1224, height: 811 });
  await page.goto('/');
  await login(page);
  await createSession(page, '默认窗口');
  await send(page, '来个长计划', 'plan');
  const card = page.getByRole('region', { name: 'Claude 的计划' }).last();
  const start = card.getByRole('button', { name: '开始执行', exact: true });
  await expect(start).toBeEnabled();
  await page.waitForTimeout(500);
  await expect(card.getByText('计划', { exact: true })).toBeInViewport();
  await expect(start).toBeInViewport();
  await expect(page.getByRole('textbox', { name: '消息' })).toBeInViewport();
  await shot(page, '6-默认窗口');
  await start.click();
  await settled(page);
});
