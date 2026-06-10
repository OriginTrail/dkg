import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CI = !!process.env.CI;
const PORT = 5173;
// `devices['Desktop Chrome']` defaults to `channel: 'chrome'`, but CI installs
// ONLY Playwright's bundled Chromium (`playwright install chromium`). Pin the
// channel to bundled chromium under CI so the browser executable resolves;
// locally we keep the stock Chrome channel.
const ciChromium = CI ? { channel: 'chromium' as const } : {};

// Which devnet node the Vite dev-server proxies `/api` to. The bootstrap
// chained into `webServer.command` guarantees `.devnet/node${DEVNET_NODE}/api.port`
// exists before Vite reads its config. Operators can repoint with `UI_NODE_ID=5`.
const DEVNET_NODE = process.env.DEVNET_NODE || process.env.UI_NODE_ID || '1';
// How many devnet nodes to boot. The UI only talks to node1, but:
//   - publishing to VM needs ACK quorum from connected CORE peers — a single-node
//     devnet fails every publish with `QuorumUnmetError(collected=0/1)`;
//   - node1 is the relay HUB and every other node dials it (scripts/devnet.sh
//     sets node{2..N}.relay = node1's multiaddr), so node1 — the node the UI
//     reads `connectedPeers` from — reports exactly N-1 connected peers.
// scripts/devnet.sh pins `minimumRequiredSignatures = 3` (the real mainnet
// 3-of-N StorageACK quorum — DO NOT lower it). A publisher collects ACKs from
// its PEERS only (it does not self-sign quorum), so a VM publish needs minSig
// OTHER reachable CORE nodes — i.e. >= minSig + 1 = 4 CORE nodes. We therefore
// boot the standard heterogeneous topology: SIX nodes = FOUR core (nodes 1-4,
// so a publish — from a core OR an edge — always finds its 3 core ACKers) + TWO
// edge (nodes 5-6; NUM_CORE_NODES defaults to 4). This exercises the real
// mixed-fleet shape — edge nodes publishing/sharing THROUGH cores — not an
// all-core devnet. node1 sees 5 peers (satisfies peer-connectivity.spec.ts
// ">1 peer"). Override the count with PLAYWRIGHT_DEVNET_NUM_NODES.
const NUM_NODES = process.env.PLAYWRIGHT_DEVNET_NUM_NODES || '6';
// Thread the chosen count into the RUNNER process. The helpers (real-node.ts,
// devnet.ts) read PLAYWRIGHT_DEVNET_NUM_NODES at import time, but webServer.command
// exports it only to the bootstrap/Vite SUBPROCESS — so without this the runner
// falls back to its default and would treat node5/6 (edges) as outside the
// topology (skipped) and under-count EXPECTED_MIN_PEERS.
process.env.PLAYWRIGHT_DEVNET_NUM_NODES = NUM_NODES;

// Mesh-settle budget for the chained `bootstrap-devnet.ts` (it reads this via
// PLAYWRIGHT_DEVNET_TIMEOUT_MS). Declared here so `webServer.timeout` below can
// be DERIVED from the same value: otherwise a cold 4-node boot can run right up
// to the bootstrap's budget and get killed by a smaller webServer.timeout before
// that headroom is ever usable. Override with PLAYWRIGHT_DEVNET_TIMEOUT_MS.
const DEVNET_BOOTSTRAP_TIMEOUT_MS = Number(process.env.PLAYWRIGHT_DEVNET_TIMEOUT_MS) || 240_000;
// Vite still has to start and bind :5173 AFTER the bootstrap returns, so the
// webServer command (bootstrap && pnpm dev:ui) needs the bootstrap budget plus a
// margin for Vite. CI keeps its generous contract-compile headroom.
const WEB_SERVER_TIMEOUT_MS = CI
  ? Math.max(600_000, DEVNET_BOOTSTRAP_TIMEOUT_MS + 120_000)
  : DEVNET_BOOTSTRAP_TIMEOUT_MS + 120_000;

export default defineConfig({
  testDir: './e2e/specs',
  // Every spec drives the SAME shared real node. Read-only specs parallelise
  // safely; specs that mutate node state guard themselves with
  // `test.describe.configure({ mode: 'serial' })` + uniquely-named data.
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  // The ENTIRE suite drives ONE shared devnet node. CI pins a single worker to
  // keep contention deterministic. Locally Playwright used to default to
  // ~cores/2 workers (e.g. 5 on a 10-core box) — but ~5 workers firing cold
  // `/api` fetches at the one node simultaneously starves each test's
  // context-graph / observability load past its 15–30s setup wait, producing
  // mass timeouts in the shared helpers (`waitForProjectsLoaded`,
  // `openObservability`) that are pure contention, NOT real failures. This bit
  // hard when the suite was launched via `--ui` (which honours this default).
  // Pin a node-friendly local default (serial, like CI); crank it deliberately
  // with `PW_WORKERS=N` once you know the node can take the load.
  workers: CI ? 1 : Number(process.env.PW_WORKERS) || 1,
  // Real-node round-trips (UI boot + live API) are far slower than the old
  // mock lane, which ran in 15–30s. Give every test room to talk to the daemon.
  timeout: CI ? 120_000 : 60_000,
  reporter: CI
    ? [['github'], ['html', { open: 'never' }], ['junit', { outputFile: 'results.xml' }]]
    : [['list'], ['html', { open: 'on-failure' }], ['junit', { outputFile: 'results.xml' }]],

  // globalTeardown stops the devnet ONLY if our bootstrap started it (it leaves
  // a marker — see e2e/global-teardown.ts). A full NUM_NODES devnet an operator
  // already had up is reused and left running; a PARTIAL one (e.g. node1 up but a
  // peer down after an interrupted run) is repaired in place — the bootstrap
  // backfills only the missing nodes (scripts/devnet.sh start is idempotent per
  // node) and tears down just those it added. The suite needs the relay-hub mesh
  // (VM-publish quorum + peer connectivity). Idempotent; safe to re-run.
  //
  // We deliberately do NOT use Playwright's `globalSetup` for the bootstrap:
  // globalSetup and webServer run in PARALLEL, so Vite would race ahead of the
  // devnet boot and crash on the missing `.devnet/node${N}/api.port`. Chaining
  // the bootstrap INTO the webServer command gives deterministic shell ordering.
  // Seeds deterministic WM→SWM→VM content into the primary CG once node1 is up,
  // so data-driven views render real entities. Runs in parallel with webServer
  // but polls for devnet readiness, so it tolerates the bootstrap still booting.
  globalSetup: resolve(__dirname, 'e2e/global-setup.ts'),
  globalTeardown: resolve(__dirname, 'e2e/global-teardown.ts'),

  use: {
    baseURL: `http://localhost:${PORT}/ui/`,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    actionTimeout: CI ? 15_000 : 10_000,
    // Headed locally so you can watch the real UI drive the real node; headless
    // on CI (the runner has no display — a hardcoded `false` would break it).
    // `PW_HEADLESS=1` forces headless locally too (handy for unattended/batch
    // runs so the suite doesn't spawn browser windows across your screen).
    headless: CI || process.env.PW_HEADLESS === '1',
  },

  // A single real-node project. There is no mock lane: every test boots a real
  // devnet, drives the real UI against it, and the node is torn down at the end.
  projects: [
    {
      name: 'real-node',
      use: { ...devices['Desktop Chrome'], ...ciChromium },
    },
  ],

  webServer: {
    // Boot a real devnet, THEN start Vite proxying `/api` to node1. The
    // bootstrap reuses an already-running devnet (fast path for local
    // iteration) and only spawns one when none is reachable.
    command:
      `cross-env PLAYWRIGHT_DEVNET_NUM_NODES=${NUM_NODES} PLAYWRIGHT_DEVNET_TIMEOUT_MS=${DEVNET_BOOTSTRAP_TIMEOUT_MS} pnpm exec tsx e2e/bootstrap-devnet.ts && ` +
      `cross-env DEVNET_NODE=${DEVNET_NODE} pnpm dev:ui`,
    cwd: __dirname,
    port: PORT,
    // Never reuse a server already listening on :5173. `webServer.command` is the
    // ONLY place that boots/validates the real devnet (the chained bootstrap), so
    // reusing a stray `pnpm dev:ui` — which may proxy at the wrong backend, or no
    // devnet at all — would silently produce false passes/failures. Always running
    // the command guarantees the devnet is pinned; the bootstrap itself reuses an
    // already-running devnet cheaply, so a fresh Vite restart is the only cost.
    reuseExistingServer: false,
    // Cold boot = Hardhat (+ Solidity compile when artifacts aren't cached) + 4
    // nodes + on-chain identity/stake/ask + CG registration + cross-node
    // propagation, THEN Vite. Locally (artifacts cached, devnet often reused)
    // that's ~40–90s; a cold CI runner adds the ~2-min contract compile. The CI
    // job pre-compiles contracts in a dedicated step to keep this fast, but we
    // budget generously so a cache miss never trips the webServer timeout.
    // Derived from DEVNET_BOOTSTRAP_TIMEOUT_MS so the chained bootstrap can never
    // out-wait the webServer (a cold 4-node boot used to hit the bootstrap's 240s
    // budget but get killed by a 180s webServer.timeout).
    timeout: WEB_SERVER_TIMEOUT_MS,
  },
});
