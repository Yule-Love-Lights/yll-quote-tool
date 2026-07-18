import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/codex-e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: {
    timeout: 15_000,
  },
  retries: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report/codex-audit', open: 'never' }],
  ],
  use: {
    baseURL: process.env.CODEX_E2E_BASE_URL ?? 'https://quote.yulelovelights.com',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
