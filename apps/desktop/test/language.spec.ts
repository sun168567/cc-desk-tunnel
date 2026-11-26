import { test, expect, _electron } from '@playwright/test';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectionArgs, signInWindow } from './helpers.ts';

// A system in English, where the window has not been told a language.
test.use({ locale: 'en-US' });

test('the window takes the system’s language until one is chosen, and changes language at once', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  // The sign-in page is in English already.
  await expect(page.getByText('Connect to the proxy service', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Local settings', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const english = page.getByRole('radiogroup', { name: 'Display language' });
  await expect(english.getByRole('radio', { name: 'Use system setting' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // Each language is named in itself, whatever the window's language.
  await expect(english.getByRole('radio')).toHaveText([
    'Use system setting',
    '简体中文',
    'English',
  ]);
  await english.getByRole('radio', { name: '简体中文' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  const chinese = page.getByRole('radiogroup', { name: '界面语言' });
  await expect(chinese.getByRole('radio', { name: '简体中文' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // The choice is kept: the window opens in it again.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
});

// The program outside the page speaks the window's language too: its menus and tray follow a change at once.
test('Electron: the menus follow the language chosen in the window', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop smoke test');
  test.slow();
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
  const profile = resolve('.local/ui-test/profile-language');
  rmSync(profile, { recursive: true, force: true });
  const application = await _electron.launch({
    args: [resolve('apps/desktop'), '--smoke-test', '--lang=zh-CN', ...connectionArgs(profile)],
    env,
  });
  // Not packaged, the program's menu is the one for development.
  const menu = () =>
    application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => item.label));
  try {
    const page = await signInWindow(application);
    await expect.poll(menu).toEqual(['开发']);
    await page.getByRole('button', { name: '设置与账号', exact: true }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '外观', exact: true })
      .click();
    await page
      .getByRole('radiogroup', { name: '界面语言' })
      .getByRole('radio', { name: 'English' })
      .click();
    await expect.poll(menu).toEqual(['Develop']);
    await page
      .getByRole('radiogroup', { name: 'Display language' })
      .getByRole('radio', { name: 'Use system setting' })
      .click();
    await expect.poll(menu).toEqual(['开发']);
  } finally {
    await application.close();
  }
});
