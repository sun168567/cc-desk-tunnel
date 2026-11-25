import { test, expect } from '@playwright/test';

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
