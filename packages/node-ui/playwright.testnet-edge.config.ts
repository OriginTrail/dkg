import { defineConfig, devices } from '@playwright/test';

/**
 * QA-only lane (sibling of playwright.testnet-core.config.ts) for the EDGE-role
 * screens — drives the PCA node-UI against the LIVE Base Sepolia EDGE node
 * (Vite :5174 → :9201 via .devnet/node2/api.port=9201 + DEVNET_NODE=2). Used for
 * S6 (get-sponsored) which only renders on a nodeRole==='edge' node. Read-only:
 * `grepInvert:/@mutating/` so it never commits real TRAC. See the QA finding on
 * why the canonical devnet lane is CI-only on Windows.
 */
export default defineConfig({
  testDir: './e2e/specs',
  testMatch: 'publishing-conviction.spec.ts',
  grepInvert: /@mutating/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5174/ui/',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    actionTimeout: 15_000,
    headless: true,
  },
  webServer: {
    command: 'cross-env DEVNET_NODE=2 pnpm dev:ui -- --port 5174',
    url: 'http://localhost:5174/ui/',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [{ name: 'testnet-edge', use: { ...devices['Desktop Chrome'] } }],
});
