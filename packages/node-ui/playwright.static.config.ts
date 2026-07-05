import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;
const ciChromium = CI ? { channel: 'chromium' as const } : {};

export default defineConfig({
  testDir: './e2e/static-specs',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  reporter: CI ? [['github'], ['junit', { outputFile: 'static-results.xml' }]] : [['list']],
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'production-static',
      use: { ...devices['Desktop Chrome'], ...ciChromium },
    },
  ],
});
