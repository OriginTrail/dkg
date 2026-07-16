import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

export interface DevnetNodeConfig {
  num: number;
  apiPort: number;
  authToken: string;
  home: string;
}

function readToken(path: string): string {
  try {
    return (
      readFileSync(path, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith('#')) ?? ''
    );
  } catch {
    return '';
  }
}

/** Returns devnet node config when `.devnet/node{N}` exists, else null. */
export function readDevnetNode(num = 1): DevnetNodeConfig | null {
  const home = join(REPO_ROOT, '.devnet', `node${num}`);
  const portFile = join(home, 'api.port');
  if (!existsSync(portFile)) return null;
  const apiPort = parseInt(readFileSync(portFile, 'utf8').trim(), 10) || 9201;
  return {
    num,
    apiPort,
    authToken: readToken(join(home, 'auth.token')),
    home,
  };
}

export function isDevnetAvailable(num = 1): boolean {
  const node = readDevnetNode(num);
  if (!node) return false;
  try {
    execSync(`curl -sf --max-time 2 http://127.0.0.1:${node.apiPort}/api/status -o /dev/null`, {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export async function devnetApiFetch(
  path: string,
  init: RequestInit & { nodeNum?: number } = {},
): Promise<Response> {
  const node = readDevnetNode(init.nodeNum ?? 1);
  if (!node) {
    throw new Error(`Devnet node${init.nodeNum ?? 1} not running`);
  }
  // UI alias paths that the daemon exposes under a different route.
  const daemonPath = path === '/api/context-graphs' ? '/api/context-graph/list' : path;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string>),
  };
  if (node.authToken) {
    headers.Authorization = `Bearer ${node.authToken}`;
  }
  const { nodeNum: _n, ...rest } = init;
  return fetch(`http://127.0.0.1:${node.apiPort}${daemonPath}`, { ...rest, headers });
}

export async function waitForDevnetStatus(
  nodeNum = 1,
  timeoutMs = 30_000,
): Promise<{ identityId: string; synced: boolean }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await devnetApiFetch('/api/status', { nodeNum });
      if (res.ok) {
        const json = (await res.json()) as { identityId?: string; synced?: boolean };
        if (json.identityId && BigInt(json.identityId) > 0n) {
          return { identityId: json.identityId, synced: !!json.synced };
        }
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Devnet node${nodeNum} did not become ready within ${timeoutMs}ms`);
}

/**
 * Wait until node `nodeNum` reports at least `minPeers` connected peers.
 *
 * `waitForDevnetStatus` only proves the node's API answers; it does NOT prove the
 * other core nodes have joined. The WM → SWM → VM publish pipeline needs ACK
 * quorum from a connected CORE peer, so seeding right after the API comes up can
 * race the cold boot and fail with `QuorumUnmetError`. Callers that publish must
 * gate on this first.
 */
export async function waitForConnectedPeers(
  nodeNum = 1,
  minPeers = 1,
  timeoutMs = 120_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    try {
      const res = await devnetApiFetch('/api/status', { nodeNum });
      if (res.ok) {
        const json = (await res.json()) as { connectedPeers?: number };
        last = json.connectedPeers ?? 0;
        if (last >= minPeers) return last;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `Devnet node${nodeNum} did not reach ${minPeers} connected peer(s) within ${timeoutMs}ms ` +
      `(last=${last}) — the WM→SWM→VM publish needs ACK quorum from a connected CORE peer`,
  );
}

const IS_CI = !!process.env.CI;

// How many devnet nodes the lane booted. Mirrors the default in
// `playwright.config.ts` / `real-node.ts` (read from the same env var) so a
// node-availability gate can tell "node down" (a real failure) apart from "node
// is outside the booted topology" (genuinely not applicable — e.g. node2 on a
// `PLAYWRIGHT_DEVNET_NUM_NODES=1` run). Read from env rather than importing
// real-node.ts to keep this low-level helper dependency-light. The fallback MUST
// match the NUM_NODES default in playwright.config.ts (4): the runner process
// does not always have PLAYWRIGHT_DEVNET_NUM_NODES exported (the webServer
// command sets it only for the bootstrap/Vite subprocess), so a stale `3` here
// would mark node4 as "outside topology" even though the webServer booted 4.
const CONFIGURED_NUM_NODES = Number(process.env.PLAYWRIGHT_DEVNET_NUM_NODES) || 4;

type SkippableTest = { skip: (condition: boolean, description: string) => void };

/**
 * Gate a devnet spec on an ALREADY-RESOLVED boolean precondition (e.g. a
 * just-fetched `cgs.length === 0`).
 *
 * Such preconditions are genuinely OPTIONAL for a local run with no devnet up —
 * there we just skip so `pnpm test:e2e` stays usable without a cluster. But in
 * CI the devnet is bootstrapped by `bootstrap-devnet.ts` and gated to a SETTLED
 * mesh + a registered PRIMARY_CG by `global-setup.ts` BEFORE any spec runs. So a
 * failing precondition in CI is NOT "not applicable" — it's a real, currently
 * MASKED failure (a partitioned mesh, a dropped CG). Skipping it would turn a
 * broken devnet into a false green on the most valuable protocol tests. So in CI
 * we THROW (turning the lane red) instead of skipping.
 *
 * NOTE: for *node liveness* use `requireDevnetNode` instead — `isDevnetAvailable`
 * is a single 2s curl, so feeding `!isDevnetAvailable(n)` straight into this
 * sync gate would turn one transiently-slow `/api/status` into a CI false-red.
 * `requireDevnetNode` retries (via `waitForDevnetStatus`) before failing.
 *
 * Use this for environment/setup preconditions only. Genuine run-state guards
 * (e.g. "a prior serial test in this file didn't produce data") should keep
 * using `test.skip(...)` directly — the upstream failure is already red, and the
 * dependent skip just avoids cascading noise.
 */
export function requireDevnetPrecondition(test: SkippableTest, unmet: boolean, description: string): void {
  if (!unmet) return;
  if (IS_CI) {
    throw new Error(
      `[devnet-precondition] ${description}. In CI the devnet is bootstrapped and gated ` +
        `by global-setup before any spec runs, so an unmet precondition here is a real ` +
        `failure (partitioned mesh / missing context graph), not a skip.`,
    );
  }
  test.skip(true, description);
}

/**
 * Gate a devnet spec on node `nodeNum` being live.
 *
 *   - Node OUTSIDE the booted topology (`nodeNum > CONFIGURED_NUM_NODES`, e.g.
 *     node2 on a 1-node run): genuinely not applicable → skip EVERYWHERE,
 *     including CI. This keeps the node2 messaging specs from hard-failing a
 *     deliberately small `PLAYWRIGHT_DEVNET_NUM_NODES=1` lane.
 *   - Node in-topology but the fast `isDevnetAvailable` probe (one 2s curl)
 *     misses: locally we skip; in CI we DON'T fail on that single probe — we
 *     fall back to `waitForDevnetStatus`, which retries for `timeoutMs` and only
 *     throws (red) on a genuine outage. This avoids turning a transiently-slow
 *     `/api/status` into a false-red while still failing a truly-down node.
 */
export async function requireDevnetNode(test: SkippableTest, nodeNum = 1, timeoutMs = 60_000): Promise<void> {
  if (nodeNum > CONFIGURED_NUM_NODES) {
    test.skip(true, `node${nodeNum} is outside this ${CONFIGURED_NUM_NODES}-node devnet topology — not applicable`);
    return;
  }
  if (isDevnetAvailable(nodeNum)) return;
  if (IS_CI) {
    // Retries internally; throws a clear error (→ red) only on a real outage.
    await waitForDevnetStatus(nodeNum, timeoutMs);
    return;
  }
  test.skip(true, `Devnet node${nodeNum} not running — start with ./scripts/devnet.sh start ${CONFIGURED_NUM_NODES}`);
}

/** Skip helper for devnet-only specs — call at start of test. */
export async function skipUnlessDevnet(test: SkippableTest, nodeNum = 1) {
  await requireDevnetNode(test, nodeNum);
}
