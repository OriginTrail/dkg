import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CI = !!process.env.CI;
const PORT = 5173;
/** Only true when launched via `pnpm test:e2e:devnet` (never inherit from shell). */
const DEVNET_UI = process.env.PWTEST_DEVNET === '1';
const DEVNET_NODE = process.env.DEVNET_NODE || process.env.UI_NODE_ID || '1';

export default defineConfig({
  testDir: './e2e/specs',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: CI ? 1 : undefined,
  timeout: CI ? 30_000 : 15_000,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: `http://localhost:${PORT}/ui/`,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    actionTimeout: CI ? 15_000 : 10_000,
  },

  projects: [
    {
      name: 'mock-ui',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/devnet/**', '**/*.devnet.spec.ts'],
    },
    {
      name: 'devnet-ui',
      use: { ...devices['Desktop Chrome'] },
      testMatch: ['**/devnet/**', '**/*.devnet.spec.ts'],
      timeout: CI ? 120_000 : 60_000,
    },
  ],

  webServer: {
    // mock-ui must never point Vite at devnet (~/.dkg or .devnet) — rich routes
    // and the base fixture's status stub rely on a proxy-without-live-daemon setup.
    // devnet-ui opt-in via PWTEST_DEVNET=1 + DEVNET_NODE (see package.json script).
    command: DEVNET_UI
      ? `cross-env DEVNET_NODE=${DEVNET_NODE} pnpm dev:ui`
      : 'cross-env DEVNET_NODE= UI_NODE_ID= pnpm dev:ui',
    cwd: __dirname,
    port: PORT,
    reuseExistingServer: !CI,
    timeout: CI ? 60_000 : 30_000,
  },
});
