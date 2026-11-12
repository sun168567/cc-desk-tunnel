import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';

async function fixture(page: Page) {
  const session = {
    id: randomUUID(),
    title: '历史读取测试',
    projectPath: 'D:\\demo',
    permissionMode: 'auto',
    activeRun: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const requests: any[] = [];
  let send = (_value: unknown) => {};
  await page.routeWebSocket('ws://127.0.0.1:18895/ws', (route) => {
    send = (value) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      requests.push(command);
      if (command.type === 'auth')
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.14',
          connectionId: randomUUID(),
          adapter: 'simulation',
          sessions: [session],
        });
    });
  });
  await page.route('**/history-progress-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>
      <script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => (type) => type;
        window.__vite_plugin_react_preamble_installed__ = true;
      </script>
      <script type="module" src="/test/history-progress.fixture.jsx"></script></body></html>`,
    }),
  );
  await page.goto('/history-progress-fixture');
  const status = page.locator('.history-read-status');
  await expect(status).toContainText('等待服务器返回历史');
  const progress = (received: number, processing = false, request = requests.at(-1)) =>
    send({
      type: 'client.history.progress',
      requestId: request.requestId,
      sessionId: session.id,
      received,
      historyReceived: received,
      processing,
    });
  const snapshot = (sequence: number, hasEarlier: boolean, mode = 'replace', payloads?: any[]) => {
    const requestId = requests.at(-1).requestId;
    send({
      type: 'session.snapshot',
      requestId,
      session,
      mode,
      firstSequence: sequence,
      lastSequence: sequence + (payloads?.length ?? 1) - 1,
      hasEarlier,
      events: (
        payloads ?? [{ type: 'text.delta', messageId: randomUUID(), text: `历史记录 ${sequence}` }]
      ).map((payload, index) => ({
        sessionId: session.id,
        runId: randomUUID(),
        sequence: sequence + index,
        createdAt: new Date().toISOString(),
        payload,
      })),
    });
    send({ type: 'response', requestId, ok: true });
  };
  return { status, requests, progress, snapshot, send, session };
}

const nativeStatus = [
  { type: 'native.capabilities', models: [], account: {}, commands: [] },
  { type: 'native.metrics', context: null, usage: null, rateLimits: null },
];

test('one upward scroll skips status-only pages without stopping or counting them as dialogue', async ({
  page,
}) => {
  const { status, requests, snapshot } = await fixture(page);
  const answer = {
    type: 'text.delta',
    messageId: randomUUID(),
    text: Array.from({ length: 40 }, (_, i) => `原有对话第 ${i + 1} 段。`).join('\n\n'),
  };
  snapshot(100, true, 'replace', [
    { type: 'message.user', messageId: randomUUID(), text: '当前问题', scenario: 'chat' },
    answer,
  ]);
  const scroller = page.locator('.conversation');
  await expect(status).toContainText('历史记录已加载');
  await expect(page.getByText('原有对话第 1 段。', { exact: true })).toHaveCount(1);
  await scroller.hover();
  await page.mouse.wheel(0, -100000);
  await expect(page.getByText('原有对话第 1 段。', { exact: true })).toBeVisible();
  await expect
    .poll(() => requests.filter((command) => command.type === 'session.history').length)
    .toBe(1);
  const initialY = await page
    .getByText('原有对话第 1 段。', { exact: true })
    .evaluate((element) => element.getBoundingClientRect().top);
  for (const sequence of [80, 60]) {
    const previous = requests.at(-1);
    snapshot(sequence, true, 'prepend', nativeStatus);
    await expect.poll(() => requests.at(-1).requestId).not.toBe(previous.requestId);
    expect(requests.at(-1).beforeSequence).toBe(sequence);
    await expect(status).toContainText('等待服务器返回历史');
    await expect(page.getByRole('button', { name: '加载中', exact: true })).toBeDisabled();
    await expect(status).not.toContainText('条记录');
  }
  snapshot(40, true, 'prepend', [
    { type: 'message.user', messageId: randomUUID(), text: '更早问题', scenario: 'chat' },
    {
      type: 'text.delta',
      messageId: randomUUID(),
      text:
        '历史记录 40\n\n' +
        Array.from({ length: 10 }, (_, i) => `更早对话第 ${i + 1} 段。`).join('\n\n'),
    },
  ]);
  await expect(status).toContainText('历史记录已加载');
  await expect(page.getByText('历史记录 40', { exact: true })).toHaveCount(1);
  await expect
    .poll(() =>
      page
        .getByText('原有对话第 1 段。', { exact: true })
        .evaluate((element) => element.getBoundingClientRect().top),
    )
    .toBeCloseTo(initialY, 0);
  expect(
    requests
      .filter((command) => command.type === 'session.history')
      .map((command) => command.beforeSequence),
  ).toEqual([100, 80, 60]);
});

test('a status-only page at the beginning says so without suggesting new messages were loaded', async ({
  page,
}) => {
  const { status, requests, snapshot } = await fixture(page);
  snapshot(100, true);
  await page.getByRole('button', { name: '加载更早记录', exact: true }).click();
  snapshot(1, false, 'prepend', nativeStatus);
  await expect(status).toContainText('已到最早记录');
  await expect(status).not.toContainText('条记录');
  await expect(page.getByRole('button', { name: '加载更早记录', exact: true })).toHaveCount(0);
  await expect(page.getByText('历史记录 100', { exact: true })).toBeVisible();
  expect(requests.filter((command) => command.type === 'session.history')).toHaveLength(1);
});

test('reopening a cached session with two status events does not claim two new dialogue records', async ({
  page,
}) => {
  const { status, requests, snapshot, session } = await fixture(page);
  snapshot(100, true);
  await page.evaluate((id) => (window as any).historyClient.select(id), session.id);
  await expect(status).toContainText('等待服务器返回历史');
  snapshot(101, false, 'append', nativeStatus);
  await expect(status).toContainText('已更新会话状态，尚未加载更早对话');
  await expect(status).not.toContainText('2 条记录');
  await expect(page.getByText('历史记录 100', { exact: true })).toBeVisible();
  expect(requests.filter((command) => command.type === 'session.history')).toHaveLength(0);
});

test('history loading shows real counters, only completes after a snapshot, and resets for an earlier page', async ({
  page,
}) => {
  const { status, requests, progress, snapshot } = await fixture(page);
  progress(256 * 1024);
  await expect(status).toContainText('连接已接收 256.0 KB');
  await expect(status).not.toContainText('历史记录已加载');
  progress(4.5 * 1024 * 1024);
  await expect(status).toContainText('连接已接收 4.5 MB');
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(status).toBeVisible();
    expect(await status.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  }
  progress(4.5 * 1024 * 1024, true);
  await expect(status).toContainText('历史数据已收到，正在处理记录');
  snapshot(100, true);
  await expect(status).toContainText('历史记录已加载');
  await expect(page.getByText('历史记录 100', { exact: true })).toBeVisible();
  const previous = requests.at(-1);
  await page.getByRole('button', { name: '加载更早记录', exact: true }).click();
  await expect(status).toContainText('等待服务器返回历史');
  await expect(status).not.toContainText('4.5 MB');
  progress(99999999, false, previous);
  await expect(status).not.toContainText('连接已接收');
  progress(128 * 1024);
  await expect(status).toContainText('连接已接收 128.0 KB');
  snapshot(50, false, 'prepend');
  await expect(status).toContainText('历史记录已加载');
  await expect(page.getByText('历史记录 50', { exact: true })).toBeVisible();
  expect(requests.map((command) => command.type)).toEqual([
    'auth',
    'device',
    'session.subscribe',
    'session.history',
  ]);
});

test('a history timeout keeps its last received amount and elapsed time on screen', async ({
  page,
}) => {
  const { status, requests, progress } = await fixture(page);
  await page.clock.install();
  // Start a fresh read after installing the clock so its deadline is controlled by this test.
  await page.evaluate(() => {
    const client = (window as any).historyClient;
    client.select(client.state.selectedId);
  });
  await expect
    .poll(() => requests.filter((command) => command.type === 'session.subscribe').length)
    .toBe(2);
  progress(16 * 1024);
  await expect(status).toContainText('16.0 KB');
  await page.clock.fastForward(60_000);
  await expect(status).toContainText('历史读取超时（连续 60 秒无进展）');
  await expect(status).toContainText('连接已接收 16.0 KB');
  await expect(status).toContainText('用时 60 秒');
  await page.clock.fastForward(10_000);
  await expect(status).toContainText('用时 60 秒');
  await expect(status).not.toContainText('历史记录已加载');
});

test('a long history read stays active past 60 seconds and only expires after payload progress stops', async ({
  page,
}) => {
  const { status, requests, progress, send } = await fixture(page);
  await page.clock.install();
  await page.evaluate(() => {
    const client = (window as any).historyClient;
    client.select(client.state.selectedId);
  });
  await expect
    .poll(() => requests.filter((command) => command.type === 'session.subscribe').length)
    .toBe(2);
  for (let part = 1; part <= 2; part++) {
    await page.clock.fastForward(55_000);
    progress(part * 1024 * 1024);
    await expect(status).toContainText(`连接已接收 ${part}.0 MB`);
    await expect(status).not.toContainText('超时');
  }
  await expect(status).toContainText('已等待 110 秒');
  const requestId = requests.at(-1).requestId;
  await page.clock.fastForward(55_000);
  // Heartbeats or unrelated state can increase the connection counter without advancing this snapshot.
  send({
    type: 'client.history.progress',
    requestId,
    sessionId: requests.at(-1).sessionId,
    received: 3 * 1024 * 1024,
    historyReceived: 2 * 1024 * 1024,
  });
  await expect(status).toContainText('连接已接收 3.0 MB');
  await expect(status).not.toContainText('超时');
  await page.clock.fastForward(5000);
  await expect(status).toContainText('连续 60 秒无进展');
  await expect(status).toContainText('用时 170 秒');
});

test('an immediate history rejection shows its actual reason and scrolling does not repeatedly retry it', async ({
  page,
}) => {
  const { status, requests, snapshot, send } = await fixture(page);
  snapshot(100, true);
  await expect(status).toContainText('历史记录已加载');
  const conversation = page.locator('.conversation');
  await conversation.hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => requests.at(-1).type).toBe('session.history');
  send({
    type: 'response',
    requestId: requests.at(-1).requestId,
    ok: false,
    code: 'session_busy',
    message: '会话正在更新，请稍后重试。',
  });
  await expect(status).toContainText('会话正在更新，请稍后重试。');
  await expect(page.locator('.history-status')).toHaveCount(1);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -100000);
  expect(requests.filter((command) => command.type === 'session.history')).toHaveLength(1);
  await page.getByRole('button', { name: '加载更早记录', exact: true }).click();
  await expect(status).toContainText('等待服务器返回历史');
  snapshot(1, false, 'prepend');
  await expect(status).toContainText('历史记录已加载');
  await expect(status).not.toContainText('会话正在更新');
});

test('a previous session history rejection does not put its failure notice on the newly selected session', async ({
  page,
}) => {
  const { status, requests, snapshot, send, session } = await fixture(page);
  snapshot(100, true);
  await page.getByRole('button', { name: '加载更早记录', exact: true }).click();
  const previous = requests.at(-1);
  const next = { ...session, id: randomUUID(), title: '另一条会话' };
  send({ type: 'session.updated', session: next });
  await page.evaluate((id) => (window as any).historyClient.select(id), next.id);
  await expect.poll(() => requests.at(-1).sessionId).toBe(next.id);
  send({
    type: 'response',
    requestId: previous.requestId,
    ok: false,
    code: 'session_busy',
    message: '上一条会话读取失败',
  });
  await expect(status).toContainText('等待服务器返回历史');
  await expect(page.getByText('上一条会话读取失败', { exact: true })).toHaveCount(0);
  await expect(page.getByText('更早记录加载失败，请重试', { exact: true })).toHaveCount(0);
});

test('scrolling up after the first page waits for its automatic native status read before requesting earlier history', async ({
  page,
}) => {
  const now = new Date().toISOString();
  const session = {
    id: randomUUID(),
    title: '首次加载后向上翻页',
    projectPath: 'D:\\demo',
    permissionMode: 'auto',
    activeRun: null,
    createdAt: now,
    updatedAt: now,
  };
  const commands: any[] = [];
  let statusRequest: any;
  let readingStatus = false;
  let send = (_value: unknown) => {};
  await page.routeWebSocket('ws://127.0.0.1:18895/ws', (route) => {
    send = (value) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      commands.push(command);
      if (command.type === 'device') return;
      if (command.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.14',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [session],
        });
        return;
      }
      if (command.type === 'session.status') {
        statusRequest = command;
        readingStatus = true;
        return;
      }
      if (command.type === 'session.history' && readingStatus) {
        // This is the real service's response while readStatus holds the session mutation lock.
        send({
          type: 'response',
          requestId: command.requestId,
          ok: false,
          code: 'session_busy',
          message: '会话正在更新，请稍后重试。',
        });
        return;
      }
      if (command.type === 'session.subscribe' || command.type === 'session.history') {
        const earlier = command.type === 'session.history';
        const sequence = earlier ? 1 : 100;
        send({
          type: 'session.snapshot',
          requestId: command.requestId,
          session,
          mode: earlier ? 'prepend' : 'replace',
          firstSequence: sequence,
          lastSequence: sequence,
          hasEarlier: !earlier,
          events: [
            {
              sessionId: session.id,
              runId: randomUUID(),
              sequence,
              createdAt: now,
              payload: {
                type: 'text.delta',
                messageId: randomUUID(),
                text: earlier
                  ? '更早的完整历史'
                  : Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 段历史内容。`).join(
                      '\n\n',
                    ),
              },
            },
          ],
        });
      }
      send({ type: 'response', requestId: command.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18895/ws');
  await page.getByLabel('服务凭据', { exact: true }).fill('test-only-history-status-wait-token');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  await expect.poll(() => !!statusRequest).toBe(true);
  await expect(page.getByText('第 60 段历史内容。', { exact: true })).toBeVisible();
  const conversation = page.locator('.conversation');
  await conversation.hover();
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100000);
  await expect(page.locator('.history-status')).toContainText(
    '正在读取会话状态，完成后加载更早记录',
  );
  expect(commands.filter((command) => command.type === 'session.history')).toHaveLength(0);
  await expect(page.getByText('更早记录加载失败，请重试', { exact: true })).toHaveCount(0);

  readingStatus = false;
  send({ type: 'response', requestId: statusRequest.requestId, ok: true });
  await expect(page.getByText('更早的完整历史', { exact: true })).toBeVisible();
  expect(commands.filter((command) => command.type === 'session.history')).toHaveLength(1);
  await expect(page.locator('.history-read-status')).toContainText('历史记录已加载');
  expect(
    commands.filter((command) =>
      ['message.send', 'run.continue', 'session.compact'].includes(command.type),
    ),
  ).toHaveLength(0);
});
