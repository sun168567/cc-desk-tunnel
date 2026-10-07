import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './apps/desktop/test',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 10000 },
  use: {
    baseURL: 'http://127.0.0.1:15173',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHANNEL,
    viewport: { width: 1280, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/dev.mjs',
    url: 'http://127.0.0.1:15173',
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      PROXY_PORT: '18887',
      UI_PORT: '15173',
      PROXY_RUNTIME_DIR: resolve('.local/ui-test'),
    },
  },
});
