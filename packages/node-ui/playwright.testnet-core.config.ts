import { defineConfig, devices } from '@playwright/test';

/**
 * QA-only lane: drive the PCA node-UI against the LIVE Base Sepolia CORE node
 * (Vite proxies /api → :9200 via .devnet/node1/api.port=9200 + DEVNET_NODE=1).
 *
 * Why this exists: the canonical devnet Playwright lane (playwright.config.ts)
 * boots a 4-node Hardhat devnet, but `npx hardhat deploy` CANNOT complete on
 * this Windows box — @typechain/hardhat's glob@7.1.7 throws "Cannot convert a
 * Symbol value to a string" during typings generation. So the devnet lane is
 * CI-only here. This lane gives real-network browser evidence of the read-only
 * P0 surfaces (mount / 503-gate / S1 / authed probe) with ZERO spend — it does
 * NOT run the mutating create/approve tests (those stay test.fixme and belong
 * to the lead-directed P0 capstone). NO globalSetup (that seeds a devnet CG).
 */
export default defineConfig({
  testDir: './e2e/specs',
  testMatch: 'publishing-conviction.spec.ts',
  // SAFETY: never run @mutating tests against the LIVE testnet (they commit real
  // TRAC). They run only on the auto-staked CI devnet (the default config). This
  // lane is read-only.
  grepInvert: /@mutating/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173/ui/',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    actionTimeout: 15_000,
    headless: true,
  },
  // Vite is started out-of-band (DEVNET_NODE=1 pnpm dev:ui) and left running for
  // UXUI; reuse it so this run doesn't tear it down.
  webServer: {
    command: 'cross-env DEVNET_NODE=1 pnpm dev:ui',
    url: 'http://localhost:5173/ui/',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [{ name: 'testnet-core', use: { ...devices['Desktop Chrome'] } }],
});
