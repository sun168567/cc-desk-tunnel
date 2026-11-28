import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

type Refusal = { release: string | null; preparing: number | null };
type Step = Record<string, unknown>;
declare global {
  interface Window {
    // What the test's stand-in for the main process was asked, and how the test answers for it.
    upgradeTest: {
      calls: unknown[][];
      progress: (step: Step) => void;
      fail: (message: string) => void;
    };
  }
}

// The sign-in window of a client 0.3.19, signing in at once to a service of 9.9.9 that refuses it: `refusal`
// is the installer the service holds and how far it has fetched it, `probe` what it says when asked again.
async function refusedBy(
  page: Page,
  refusal: Refusal,
  probe: unknown = { status: 'unreachable' },
  platform: 'win32' | 'darwin' = 'win32',
) {
  await page.addInitScript(
    ([refusal, probe, platform]) => {
      const calls: unknown[][] = [];
      let signIn = (_report: unknown) => {};
      let progress = (_step: Step) => {};
      let settle = (_value: unknown) => {};
      let reject = (_error: Error) => {};
      window.upgradeTest = {
        calls,
        progress: (step) => progress(step),
        fail: (message) => reject(new Error(message)),
      };
      Object.assign(window, {
        desktop: {
          platform,
          boot: { launcher: true },
          version: async () => '0.3.19',
          device: async () => ({ id: 'device', name: '这台电脑' }),
          onSharedChanged: () => () => {},
          saveShared: async () => {},
          accounts: async () => [],
          releaseNotes: async () => '',
          loadLauncher: async () => ({
            form: {
              url: 'wss://service.test/ws',
              token: 'test-only-upgrade-token-with-enough-length',
              fingerprint: '',
              mode: 'remote',
              remember: false,
              autoLogin: false,
            },
            signIn: true,
          }),
          startSignIn: async () => {
            setTimeout(() =>
              signIn({
                status: 'disconnected',
                error: '客户端与服务端（9.9.9）的版本不一致，需要升级其中一方。',
                mismatch: true,
                service: '9.9.9',
                ...refusal,
              }),
            );
            return {};
          },
          cancelSignIn: async () => {},
          onSignIn: (callback: typeof signIn) => {
            signIn = callback;
            return () => {};
          },
          onUpdateProgress: (callback: typeof progress) => {
            progress = callback;
            return () => {};
          },
          installUpdate: (version?: string) => {
            calls.push(['install', version]);
            return new Promise((resolve, fail) => {
              settle = resolve;
              reject = fail;
            });
          },
          cancelUpdate: async () => {
            calls.push(['cancel']);
            settle({ cancelled: true });
          },
          probeService: async () => {
            calls.push(['probe']);
            return probe;
          },
        },
      });
    },
    [refusal, probe, platform] as const,
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('版本不一致');
}
const calls = (page: Page) => page.evaluate(() => window.upgradeTest.calls);
const progress = (page: Page, step: Step) =>
  page.evaluate((step) => window.upgradeTest.progress(step), step);

test('an upgrade from the service shows each step in place of its buttons, says when the data stops, and can be stopped', async ({
  page,
}) => {
  await page.clock.install();
  await refusedBy(page, { release: '9.9.9', preparing: null });
  const fromService = page.getByRole('button', { name: '升级客户端到 9.9.9' });
  const fromGithub = page.getByRole('button', { name: '改从 GitHub 发布页下载 9.9.9' });
  await expect(fromGithub).toBeVisible();
  await fromService.click();
  const status = page.getByRole('status');
  await expect(status).toContainText('正在连接服务端…');
  await expect(fromService).toHaveCount(0);
  await expect(fromGithub).toHaveCount(0);
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeDisabled();
  await progress(page, {
    source: 'service',
    phase: 'downloading',
    received: 4 * 1048576,
    size: 8 * 1048576,
  });
  await expect(status).toContainText('正在从服务端下载 50%');
  await expect(status).toContainText('4.0 MB / 8.0 MB');
  await page.clock.fastForward(7000);
  await expect(status).toContainText('7 秒没有新数据');
  await page.getByRole('button', { name: '取消' }).click();
  await expect(status).toHaveCount(0);
  await expect(fromService).toBeVisible();
  expect(await calls(page)).toEqual([['install', undefined], ['cancel']]);
});

test('a download from the release page that fails says why, and both ways are offered again', async ({
  page,
}) => {
  await refusedBy(page, { release: '9.9.9', preparing: null });
  await page.getByRole('button', { name: '改从 GitHub 发布页下载 9.9.9' }).click();
  await expect(page.getByRole('status')).toContainText('正在连接 GitHub…');
  await progress(page, {
    source: 'github',
    phase: 'retrying',
    attempt: 2,
    attempts: 5,
    received: 1048576,
    size: 4 * 1048576,
  });
  await expect(page.getByRole('status')).toContainText('网络中断，正在重新连接（第 2/5 次）');
  await page.evaluate(() =>
    window.upgradeTest.fail(
      '从 GitHub 下载安装包中断（15 秒没有收到数据），已下载 1.0 MB / 4.0 MB。',
    ),
  );
  await expect(page.getByRole('alert')).toHaveText(/^从 GitHub 下载安装包中断/);
  await expect(page.getByRole('button', { name: '升级客户端到 9.9.9' })).toBeVisible();
  await expect(page.getByRole('button', { name: '改从 GitHub 发布页下载 9.9.9' })).toBeVisible();
  expect(await calls(page)).toEqual([['install', '9.9.9']]);
});

test('a service still fetching the installer is asked again until it holds it, and the upgrade is offered then', async ({
  page,
}) => {
  await refusedBy(
    page,
    { release: null, preparing: 0.4 },
    { status: 'refused', service: '9.9.9', release: '9.9.9', preparing: null },
  );
  await expect(page.getByRole('alert')).toContainText('服务端正在下载这一版的安装包（40%）');
  await expect(page.getByRole('button', { name: '升级客户端到 9.9.9' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '从 GitHub 发布页下载并升级到 9.9.9' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '升级客户端到 9.9.9' })).toBeVisible();
  await expect(page.getByRole('alert')).not.toContainText('正在下载');
  expect((await calls(page)).filter(([call]) => call === 'probe')).toHaveLength(1);
});

test('a refused Mac downloads the server version from GitHub at sign-in, without waiting for the server', async ({
  page,
}) => {
  await page.clock.install();
  await refusedBy(page, { release: '9.9.9', preparing: null }, undefined, 'darwin');
  await expect(page.getByRole('alert')).toContainText('GitHub 发布页下载与服务端同一版本');
  await expect(page.getByRole('button', { name: '升级客户端到 9.9.9' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查看 9.9.9 的更新内容' })).toBeVisible();
  // The service's installer is for Windows: a Mac does not ask the service again for it.
  await page.clock.fastForward(20000);
  expect(await calls(page)).toEqual([]);
  await page.getByRole('button', { name: '从 GitHub 发布页下载并升级到 9.9.9' }).click();
  await expect(page.getByRole('status')).toContainText('正在连接 GitHub…');
  expect(await calls(page)).toEqual([['install', '9.9.9']]);
});
