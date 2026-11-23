import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

// The commands Claude Code reported for the session, a skill of the user's among them.
const commands = [
  { name: 'compact', description: 'Clear history but keep a summary', argumentHint: '' },
  { name: 'review', description: 'Review a pull request', argumentHint: '<pr>' },
  { name: 'security-review', description: 'Security review', argumentHint: '' },
  { name: 'context', description: 'Show context usage', argumentHint: '' },
  { name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost', 'stats'] },
  { name: 'clear', description: 'Clear conversation history', argumentHint: '' },
  { name: 'model', description: 'Set the model', argumentHint: '[model]' },
  { name: 'my-skill', description: 'Run my own skill', argumentHint: '' },
  // Controls of their own here, and the CLI's internal ones, as Claude Code 2.1.293 lists them.
  { name: 'effort', description: 'Set effort level', argumentHint: '<low|medium|high>' },
  { name: 'rename', description: 'Rename the current conversation', argumentHint: '[name]' },
  { name: '__remote-workflow', description: 'Run the workflow script', argumentHint: '' },
  { name: 'workflow-launch-exec', description: 'Execute a workflow handoff', argumentHint: '' },
];

async function open(page: Page) {
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '命令',
    autoTitle: false,
    projectPath: 'D:\\工作\\命令',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const sent: string[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18895/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
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
          projects: [],
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
          lastSequence: 1,
          hasEarlier: false,
          events: [
            {
              sessionId: session.id,
              runId: randomUUID(),
              sequence: 1,
              createdAt: now,
              payload: {
                type: 'native.capabilities',
                account: {},
                models: [],
                commands: commands.map((command) => command.name),
                commandDetails: commands,
              },
            },
          ],
        });
      if (message.type === 'message.send') sent.push(message.text);
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18895/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-slash-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  return sent;
}

const box = (page: Page) => page.getByRole('textbox', { name: '消息' });
const menu = (page: Page) => page.getByRole('listbox', { name: '会话命令' });
// Each option's name, without its argument hint and its description.
const names = (page: Page) =>
  menu(page)
    .getByRole('option')
    .evaluateAll((options) =>
      options.map((option) =>
        [...option.querySelector('span')!.childNodes]
          .filter((node) => !['SMALL', 'EM'].includes((node as Element).tagName))
          .map((node) => node.textContent)
          .join(''),
      ),
    );

test('a slash lists this window’s actions, then the everyday commands, then the rest', async ({
  page,
}) => {
  await open(page);
  await box(page).fill('/');
  await expect(menu(page)).toBeVisible();
  // Commands with a control of their own here, or that would change the CLI's session, are left to its terminal.
  expect(await names(page)).toEqual([
    '压缩上下文',
    '刷新原生状态',
    '/review',
    '/security-review',
    '/context',
    '/usage',
    '/my-skill',
  ]);
  await expect(menu(page).getByRole('option', { name: /\/review/ })).toContainText('<pr>');
  await expect(menu(page).getByRole('option', { name: /\/review/ })).toContainText('审查代码改动');
  await expect(menu(page).getByRole('option', { name: /\/my-skill/ })).toContainText(
    'Run my own skill',
  );
  await page.screenshot({ path: resolve('.local/screenshots/slash-commands.png') });
});

test('what follows the slash narrows the list, other names of a command included', async ({
  page,
}) => {
  await open(page);
  await box(page).fill('/co');
  expect(await names(page)).toEqual(['压缩上下文', '/context', '/usage']);
  await box(page).fill('/zz');
  await expect(menu(page)).toHaveCount(0);
});

test('Tab puts the picked command in the box without sending it', async ({ page }) => {
  const sent = await open(page);
  await box(page).fill('/rev');
  await box(page).press('Tab');
  await expect(box(page)).toHaveValue('/review ');
  await expect(box(page)).toBeFocused();
  await expect(menu(page)).toHaveCount(0);
  expect(sent).toEqual([]);
});

test('Enter sends the picked command; the arrow keys pick another', async ({ page }) => {
  const sent = await open(page);
  await box(page).fill('/con');
  await box(page).press('Enter');
  await expect.poll(() => sent).toEqual(['/context']);
  await expect(box(page)).toHaveValue('');
  await box(page).fill('/');
  // Compacting needs a context to compact, which this session has none of yet: the first usable one is picked.
  await expect(menu(page).getByRole('option', { name: '压缩上下文' })).toBeDisabled();
  await expect(menu(page).getByRole('option', { selected: true })).toContainText('刷新原生状态');
  await box(page).press('ArrowDown');
  await expect(menu(page).getByRole('option', { selected: true })).toContainText('/review');
  await box(page).press('ArrowUp');
  await box(page).press('ArrowUp');
  await box(page).press('ArrowUp');
  await expect(menu(page).getByRole('option', { selected: true })).toContainText('/my-skill');
  await box(page).press('Enter');
  await expect.poll(() => sent).toEqual(['/context', '/my-skill']);
});

test('a click puts a command in the box, to be given its arguments', async ({ page }) => {
  const sent = await open(page);
  await box(page).fill('/');
  await menu(page)
    .getByRole('option', { name: /\/usage/ })
    .click();
  await expect(box(page)).toHaveValue('/usage ');
  await expect(box(page)).toBeFocused();
  expect(sent).toEqual([]);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('Enter starts a new line, and still picks a command from the menu', async ({ page }) => {
    const sent = await open(page);
    await box(page).fill('第一行');
    await box(page).press('Enter');
    await box(page).pressSequentially('第二行');
    await expect(box(page)).toHaveValue('第一行\n第二行');
    expect(sent).toEqual([]);
    await box(page).fill('/con');
    await box(page).press('Enter');
    await expect.poll(() => sent).toEqual(['/context']);
  });
});
