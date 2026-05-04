import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CI = !!process.env.CI;
const PORT = 5173;

export default defineConfig({
  testDir: './e2e/specs',
  globalSetup: './e2e/setup/global-setup.ts',
  globalTeardown: './e2e/setup/global-teardown.ts',
  // The daemon is a singleton on a fixed port — running specs in parallel
  // across workers would race on shared backend state. Force serial.
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  // Live-daemon mode: a few specs do up to ~45s of "wait for first
  // /api/paranet/list refresh" in their beforeEach to escape the daemon
  // bootstrap window. 30s was the old mock-mode budget and is too tight.
  timeout: 60_000,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: `http://localhost:${PORT}/ui/`,
    // Run headed locally so you can see the browser; CI keeps it headless.
    headless: false,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    actionTimeout: CI ? 15_000 : 10_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'pnpm dev:ui',
    cwd: __dirname,
    port: PORT,
    reuseExistingServer: !CI,
    timeout: CI ? 60_000 : 30_000,
  },
});
