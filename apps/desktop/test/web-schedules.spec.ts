import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ScheduleSnapshot } from '../src/browser-schedules.ts';

async function mount(page: Page, remote: boolean) {
  // Use the real hooks and shared panel, without a proxy service or the rest of App.
  await page.route(/\/src\/main\.tsx(?:\?.*)?$/, (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
  await page.goto('/');
  await page.evaluate(
    async ({ remote, path }) => {
      localStorage.setItem('proxy-schedule-progress', remote ? 'browser-progress-sentinel' : '{}');
      const fixture = await import(path);
      const root = document.getElementById('root');
      if (!root || root.childNodes.length !== 0)
        throw new Error('The schedule fixture requires an empty root; App must not be mounted.');
      fixture.mount(remote);
    },
    { remote, path: '/test/schedule-fixture.tsx' },
  );
  await expect(page.getByText('示例任务', { exact: true })).toBeVisible();
}

test('the browser has no automatic scheduler or progress writer and reads only while the panel is open', async ({
  page,
}) => {
  await mount(page, true);
  await page.clock.runFor(16_000);
  const running = await page.evaluate(() => ({
    reads: window.scheduleFixture.reads,
    sends: window.scheduleFixture.sends,
    intervals: window.scheduleFixture.intervals,
    progress: localStorage.getItem('proxy-schedule-progress'),
  }));
  expect(running.reads).toBeGreaterThan(1);
  expect(running.sends).toEqual([]);
  expect(running.intervals).not.toContain(15_000);
  expect(running.progress).toBe('browser-progress-sentinel');
  await page.getByRole('button', { name: '立即运行 示例任务', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scheduleFixture.runNow)).toEqual(['example']);
  await page.evaluate(() => window.scheduleFixture.showPanel(false));
  await expect(page.getByText('其他页面', { exact: true })).toBeVisible();
  const reads = await page.evaluate(() => window.scheduleFixture.reads);
  await page.clock.runFor(16_000);
  expect(await page.evaluate(() => window.scheduleFixture.reads)).toBe(reads);
  expect(await page.evaluate(() => localStorage.getItem('proxy-schedule-progress'))).toBe(
    'browser-progress-sentinel',
  );
});

test('the original desktop scheduler still runs with Web disabled and browser run-now uses its progress', async ({
  page,
}) => {
  await mount(page, false);
  expect(await page.evaluate(() => window.scheduleFixture.reads)).toBe(0);
  await page.clock.runFor(315_000);
  await expect.poll(() => page.evaluate(() => window.scheduleFixture.sends.length)).toBe(1);
  const first = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('proxy-schedule-progress')!),
  );
  expect(first.example.last.status).toBe('sent');
  await page.evaluate(() => window.scheduleFixture.enable(true));
  await page.clock.runFor(1_000);
  await page.evaluate(() => window.scheduleFixture.request('schedules:run-now', 'example'));
  await expect.poll(() => page.evaluate(() => window.scheduleFixture.sends.length)).toBe(2);
  const snapshot = (await page.evaluate(() =>
    window.scheduleFixture.request('schedules:state'),
  )) as ScheduleSnapshot;
  expect(snapshot.timing.example.last?.status).toBe('sent');
  expect(snapshot.timing.example.last!.at).toBeGreaterThan(first.example.last.at);
  expect(snapshot.timing.example.next).toBe(snapshot.timing.example.last!.at + 300_000);
  await page.evaluate(() => window.scheduleFixture.enable(false));
  await page.clock.runFor(315_000);
  await expect.poll(() => page.evaluate(() => window.scheduleFixture.sends.length)).toBe(3);
});

test('a browser schedule draft survives host timezone loss and recovery', async ({ page }) => {
  await mount(page, true);
  await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
  await page.getByLabel('任务名称', { exact: true }).fill('保留未保存名称');
  await page.getByLabel('提示词', { exact: true }).fill('保留未保存提示词');
  await page.getByLabel('重复规则', { exact: true }).selectOption('once');
  await page.getByLabel('运行时间', { exact: true }).fill('2030-06-15T12:34');
  const snapshot = await page.evaluate(() => window.scheduleFixture.snapshot);
  await page.evaluate(async () => {
    window.scheduleFixture.snapshot = null;
    await window.scheduleFixture.refresh();
  });
  await expect(page.getByRole('button', { name: '保存任务', exact: true })).toBeDisabled();
  await page.evaluate(async (snapshot) => {
    window.scheduleFixture.snapshot = { ...snapshot!, timeZone: 'Asia/Tokyo' };
    await window.scheduleFixture.refresh();
  }, snapshot);
  await expect(page.getByRole('status')).toContainText('Asia/Tokyo');
  await expect(page.getByLabel('任务名称', { exact: true })).toHaveValue('保留未保存名称');
  await expect(page.getByLabel('提示词', { exact: true })).toHaveValue('保留未保存提示词');
  await expect(page.getByLabel('运行时间', { exact: true })).toHaveValue('2030-06-15T12:34');
  await expect(page.getByRole('button', { name: '保存任务', exact: true })).toBeEnabled();
});

test('browser file edits immediately update the original desktop scheduler', async ({ page }) => {
  await mount(page, false);
  await page.evaluate(async () => {
    window.scheduleFixture.enable(true);
    const snapshot = (await window.scheduleFixture.request('schedules:state')) as ScheduleSnapshot;
    const task = {
      ...snapshot.tasks[0],
      name: '远程更新任务',
      schedule: { type: 'interval', minutes: 10 },
    };
    await window.scheduleFixture.request(
      'schedules:save',
      JSON.stringify({ tasks: [task] }),
      snapshot.revision,
    );
  });
  await expect(page.getByText('远程更新任务', { exact: true })).toBeVisible();
  await page.clock.runFor(315_000);
  expect(await page.evaluate(() => window.scheduleFixture.sends)).toEqual([]);
  await page.clock.runFor(300_000);
  await expect
    .poll(() => page.evaluate(() => window.scheduleFixture.sends.map((task) => task.name)))
    .toEqual(['远程更新任务']);
});

test('a draft opened from unavailable state never inherits the recovered snapshot revision', async ({
  page,
}) => {
  await mount(page, true);
  const snapshot = await page.evaluate(() => window.scheduleFixture.snapshot!);
  await page.evaluate(async () => {
    window.scheduleFixture.snapshot = null;
    await window.scheduleFixture.refresh();
  });
  await page.getByRole('button', { name: '编辑 示例任务', exact: true }).click();
  await page.getByLabel('提示词', { exact: true }).fill('离线时编辑的草稿');
  await page.evaluate(async (snapshot) => {
    window.scheduleFixture.snapshot = {
      ...snapshot,
      revision: 'changed-while-unavailable',
      tasks: snapshot.tasks.map((task) => ({ ...task, prompt: '另一个页面已更新' })),
    };
    await window.scheduleFixture.refresh();
  }, snapshot);
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('草稿已保留');
  await expect(page.getByLabel('提示词', { exact: true })).toHaveValue('离线时编辑的草稿');
  expect(await page.evaluate(() => window.scheduleFixture.saves)).toEqual([]);
  expect(await page.evaluate(() => window.scheduleFixture.snapshot!.tasks[0].prompt)).toBe(
    '另一个页面已更新',
  );
});

test('a shared desktop draft cannot restore a task deleted by a browser', async ({ page }) => {
  await mount(page, false);
  await page.evaluate(() => window.scheduleFixture.enable(true));
  await expect.poll(() => page.evaluate(() => window.scheduleFixture.revision)).toBe('0');
  await page.getByRole('button', { name: '编辑 示例任务', exact: true }).click();
  await page.getByLabel('提示词', { exact: true }).fill('桌面未保存的草稿');
  await page.evaluate(async () => {
    const snapshot = (await window.scheduleFixture.request('schedules:state')) as ScheduleSnapshot;
    await window.scheduleFixture.request('schedules:save', '{"tasks":[]}', snapshot.revision);
  });
  await expect(page.getByText('暂无已安排的任务', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('草稿已保留');
  await expect(page.getByLabel('提示词', { exact: true })).toHaveValue('桌面未保存的草稿');
  expect(await page.evaluate(() => window.scheduleFixture.snapshot!.tasks)).toEqual([]);
  expect(
    await page.evaluate(() => window.scheduleFixture.saves.map(({ revision }) => revision)),
  ).toEqual(['0', '0']);
});

test('a draft keeps its original revision across polling and cannot restore a deleted task', async ({
  page,
}) => {
  await mount(page, true);
  await page.getByRole('button', { name: '编辑 示例任务', exact: true }).click();
  await page.getByLabel('任务名称', { exact: true }).fill('尚未保存的名称');
  await page.getByLabel('提示词', { exact: true }).fill('保留我的草稿');
  await page.evaluate(async () => {
    window.scheduleFixture.snapshot = {
      ...window.scheduleFixture.snapshot!,
      tasks: [],
      revision: 'deleted-by-another-view',
      timing: {},
    };
    await window.scheduleFixture.refresh();
  });
  await expect(page.getByText('暂无已安排的任务', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('草稿已保留');
  await expect(page.getByLabel('任务名称', { exact: true })).toHaveValue('尚未保存的名称');
  await expect(page.getByLabel('提示词', { exact: true })).toHaveValue('保留我的草稿');
  expect(
    await page.evaluate(() => window.scheduleFixture.saves.map(({ revision }) => revision)),
  ).toEqual(['0']);
  expect(await page.evaluate(() => window.scheduleFixture.snapshot!.tasks)).toEqual([]);
});

test('an unshared desktop draft cannot restore a browser deletion after Web is enabled then disabled', async ({
  page,
}) => {
  await mount(page, false);
  await page.getByRole('button', { name: '编辑 示例任务', exact: true }).click();
  await page.getByLabel('提示词', { exact: true }).fill('启用 Web 前留下的草稿');
  await page.evaluate(() => window.scheduleFixture.enable(true));
  await expect.poll(() => page.evaluate(() => window.scheduleFixture.revision)).toBe('0');
  await page.evaluate(async () => {
    const snapshot = (await window.scheduleFixture.request('schedules:state')) as ScheduleSnapshot;
    await window.scheduleFixture.request('schedules:save', '{"tasks":[]}', snapshot.revision);
    window.scheduleFixture.enable(false);
  });
  await expect(page.getByText('暂无已安排的任务', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scheduleFixture.revision)).toBeUndefined();
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('共享状态已更改');
  await expect(page.getByLabel('提示词', { exact: true })).toHaveValue('启用 Web 前留下的草稿');
  expect(await page.evaluate(() => window.scheduleFixture.snapshot!.tasks)).toEqual([]);
  expect(await page.evaluate(() => window.scheduleFixture.saves.length)).toBe(1);

  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
  await page.getByLabel('任务名称', { exact: true }).fill('关闭共享后新建');
  await page.getByLabel('提示词', { exact: true }).fill('新的桌面编辑仍可保存');
  await page.getByLabel('项目目录', { exact: true }).fill('/project');
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(page.getByText('关闭共享后新建', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.scheduleFixture.saves.length)).toBe(1);
  await page.evaluate(() => window.scheduleFixture.enable(true));
  await expect.poll(() => page.evaluate(() => window.scheduleFixture.revision)).toBe('2');
  const snapshot = (await page.evaluate(() =>
    window.scheduleFixture.request('schedules:state'),
  )) as ScheduleSnapshot;
  expect(snapshot.tasks.map((task) => task.name)).toEqual(['关闭共享后新建']);
  expect(snapshot.tasks[0].prompt).toBe('新的桌面编辑仍可保存');
  await page.getByRole('button', { name: '编辑 关闭共享后新建', exact: true }).click();
  await page.getByLabel('提示词', { exact: true }).fill('再次共享后仍可保存');
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.scheduleFixture.snapshot!.tasks[0].prompt))
    .toBe('再次共享后仍可保存');
  expect(
    await page.evaluate(() => window.scheduleFixture.saves.map(({ revision }) => revision)),
  ).toEqual(['0', '2']);
});

test('a complete Web toggle batched in one turn still invalidates an old desktop draft', async ({
  page,
}) => {
  await mount(page, false);
  await page.getByRole('button', { name: '编辑 示例任务', exact: true }).click();
  await page.getByLabel('提示词', { exact: true }).fill('批处理启停前的草稿');
  await page.evaluate(() => {
    window.scheduleFixture.enable(true);
    window.scheduleFixture.enable(false);
  });
  await expect.poll(() => page.evaluate(() => window.scheduleFixture.editGeneration)).toBe(2);
  expect(await page.evaluate(() => window.scheduleFixture.revision)).toBeUndefined();
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('草稿已保留');
  await expect(page.getByLabel('提示词', { exact: true })).toHaveValue('批处理启停前的草稿');
  expect(await page.evaluate(() => window.scheduleFixture.snapshot!.tasks[0].prompt)).toBe(
    '检查项目',
  );
  expect(await page.evaluate(() => window.scheduleFixture.saves)).toEqual([]);

  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '编辑 示例任务', exact: true }).click();
  await page.getByLabel('提示词', { exact: true }).fill('启停后新打开的草稿');
  await page.evaluate(() => window.scheduleFixture.enable(false));
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.scheduleFixture.snapshot!.tasks[0].prompt))
    .toBe('启停后新打开的草稿');
  expect(await page.evaluate(() => window.scheduleFixture.editGeneration)).toBe(2);
  expect(await page.evaluate(() => window.scheduleFixture.saves)).toEqual([]);
});

test('restarting Web cannot reuse a revision read in the previous sharing generation', async ({
  page,
}) => {
  await mount(page, false);
  await page.evaluate(() => window.scheduleFixture.enable(true));
  await expect.poll(() => page.evaluate(() => window.scheduleFixture.revision)).toBe('0');
  await page.evaluate(() => {
    const read = window.desktop!.readRemoteSchedules!;
    const release = new Promise<void>((resolve) =>
      window.addEventListener('release-schedule-read', () => resolve(), { once: true }),
    );
    window.desktop!.readRemoteSchedules = async () => {
      await release;
      return read();
    };
    window.scheduleFixture.enable(false);
    window.scheduleFixture.enable(true);
  });
  await expect.poll(() => page.evaluate(() => window.scheduleFixture.editGeneration)).toBe(3);
  expect(await page.evaluate(() => window.scheduleFixture.revision)).toBeNull();
  await page.getByRole('button', { name: '编辑 示例任务', exact: true }).click();
  await page.getByLabel('提示词', { exact: true }).fill('重新共享但版本尚未就绪时的草稿');
  await page.evaluate(() => window.dispatchEvent(new Event('release-schedule-read')));
  await expect.poll(() => page.evaluate(() => window.scheduleFixture.revision)).toBe('0');
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('版本尚未就绪');
  await expect(page.getByLabel('提示词', { exact: true })).toHaveValue(
    '重新共享但版本尚未就绪时的草稿',
  );
  expect(await page.evaluate(() => window.scheduleFixture.saves)).toEqual([]);
  expect(await page.evaluate(() => window.scheduleFixture.snapshot!.tasks[0].prompt)).toBe(
    '检查项目',
  );
});
