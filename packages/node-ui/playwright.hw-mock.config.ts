import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;
const PORT = Number(process.env.PCA_HW_MOCK_PORT) || 5174;

export default defineConfig({
  testDir: './e2e/specs',
  testMatch: /publishing-conviction-hw-mock\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: 1,
  timeout: CI ? 90_000 : 60_000,
  reporter: CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report/hw-mock' }]]
    : [['list'], ['html', { open: 'on-failure', outputFolder: 'playwright-report/hw-mock' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}/ui/`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: CI ? 15_000 : 10_000,
    headless: CI || process.env.PW_HEADLESS === '1',
  },
  projects: [
    {
      name: 'hw-mock',
      use: { ...devices['Desktop Chrome'], ...(CI ? { channel: 'chromium' as const } : {}) },
    },
  ],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: false,
    timeout: CI ? 120_000 : 90_000,
  },
});
