import { defineConfig, devices } from '@playwright/test';
import { NODES, PORTS, UI } from './e2e/marketplace/topology.js';

// The NeuroSymbolic Marketplace lane (OT-RFC-27): its own config, so the
// default suite (`playwright.config.ts`, specs in e2e/specs) neither boots
// this lane's devnet nor runs its specs, and this lane never sees theirs.
// A separate config rather than an environment switch on the default one:
// the lane needs a devnet built differently (a registered Marketplace Context
// Graph, a seller and a buyer restarted with the marketplace, a stub model),
// three UI servers instead of one, and specs that run in order against one
// chain, none of which the default config should carry. Run it with
//   pnpm --filter @origintrail-official/dkg-node-ui test:e2e:marketplace
//
// What it starts, in order (Playwright starts web servers one after another):
//   1. the stub model (e2e/marketplace/stub-backend.ts);
//   2. a fresh devnet and the marketplace setup (e2e/marketplace/bootstrap.ts),
//      then Vite for the buyer node's UI;
//   3. Vite for the seller node's UI;
//   4. Vite for the UI of a node without the marketplace.
// The ports are the lane's own (e2e/marketplace/topology.ts), away from the
// default suite's.
const CI = !!process.env.CI;
// CI installs only Playwright's bundled Chromium; locally the installed Chrome
// runs the lane, or another channel MKT_E2E_BROWSER_CHANNEL names (`chromium`
// once `playwright install chromium` has fetched it).
const channel = CI ? 'chromium' : process.env.MKT_E2E_BROWSER_CHANNEL || 'chrome';

const vite = (node: number, port: number) =>
  `cross-env DEVNET_NODE=${node} pnpm exec vite --config e2e/marketplace/vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`;

export default defineConfig({
  metadata: {
    subject: process.env.DKG_CI_SUBJECT ?? process.env.GITHUB_SHA,
    lane: 'marketplace',
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    node: process.version,
    platform: process.platform,
  },
  testDir: './e2e/marketplace/specs',
  // One chain, one journey: each spec builds on what the one before it left
  // (a funded plan, a key, a served call), so they run one at a time, in
  // file order, and a failed one is not retried: a second funding of the same
  // epoch is refused, so a retry would only add noise.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: CI,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: CI
    ? [['github'], ['json', { outputFile: 'playwright-report/results.json' }], ['html', { outputFolder: 'playwright-report/html', open: 'never' }], ['junit', { outputFile: 'results.xml' }]]
    : [['list'], ['html', { outputFolder: 'playwright-report/marketplace', open: 'never' }]],
  globalSetup: './e2e/marketplace/global-setup.ts',
  globalTeardown: './e2e/marketplace/global-teardown.ts',
  use: {
    baseURL: UI.buyer,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: CI ? 20_000 : 15_000,
    headless: CI || process.env.PW_HEADLESS === '1',
  },
  projects: [{ name: 'marketplace', use: { ...devices['Desktop Chrome'], channel } }],
  webServer: [
    {
      command: 'pnpm exec tsx e2e/marketplace/stub-backend.ts',
      url: `http://127.0.0.1:${PORTS.stub}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Cold: Hardhat with its contracts, four nodes with their stakes, the
      // graph's registration, two restarts and the offers' first trip to the
      // buyer. The setup has its own deadlines inside this one.
      command: `pnpm exec tsx e2e/marketplace/bootstrap.ts && ${vite(NODES.buyer, PORTS.buyerUi)}`,
      url: UI.buyer,
      reuseExistingServer: false,
      stdout: 'pipe',
      timeout: 1_200_000,
    },
    { command: vite(NODES.seller, PORTS.sellerUi), url: UI.seller, reuseExistingServer: false, timeout: 120_000 },
    { command: vite(NODES.plain, PORTS.plainUi), url: UI.plain, reuseExistingServer: false, timeout: 120_000 },
  ],
});
