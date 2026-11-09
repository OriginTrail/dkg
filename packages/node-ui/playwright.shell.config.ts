import { defineConfig } from '@playwright/test';

const CI = !!process.env.CI;
const PORT = Number(process.env.SHELL_BROWSER_PORT) || 5187;

// The real app with a mocked node (browser-regressions/shell/mock-node.ts):
// no devnet bootstrap, daemon proxy, chain RPC or external mutation, so it
// also runs on machines that can't boot the devnet.
export default defineConfig({
  testDir: './browser-regressions/shell',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  forbidOnly: CI,
  workers: 1,
  retries: CI ? 1 : 0,
  // The first page load waits for Vite to optimise the app's dependencies.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report/shell' }]]
    : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec vite --config browser-regressions/shell/vite.config.ts --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/ui/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
