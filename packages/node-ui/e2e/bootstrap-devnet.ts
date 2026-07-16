/**
 * One-shot devnet bootstrap, invoked from `playwright.config.ts`'s
 * `webServer.command` so it runs to completion BEFORE Vite tries to
 * read its config (which throws when `.devnet/node${N}/api.port` is
 * missing).
 *
 * Important: Playwright runs `globalSetup` and `webServer` in
 * PARALLEL — the `webServer.command` cannot rely on `globalSetup`
 * having finished. We therefore put the bootstrap on the same command
 * line as `pnpm dev:ui` (`bootstrap && pnpm dev:ui`) so the ordering
 * is guaranteed by the shell.
 *
 * Two modes:
 *   1. Devnet already running  -> reuse, no marker, teardown is a no-op.
 *   2. Nothing running         -> spawn `scripts/devnet.sh start`, write
 *                                 a marker so global-teardown.ts knows
 *                                 it owns the lifecycle.
 *
 * Reuse is a TWO-step probe (api.port file + tcp connect) so a stale
 * port file from a crashed daemon is correctly treated as "down".
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devnetApiFetch } from './helpers/devnet.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const DEVNET_DIR = resolve(REPO_ROOT, '.devnet');
const NODE_NUM = process.env.DEVNET_NODE || process.env.UI_NODE_ID || '1';
const NODE_NUM_INT = parseInt(NODE_NUM, 10) || 1;
const NODE_DIR = resolve(DEVNET_DIR, `node${NODE_NUM}`);
const API_PORT_FILE = resolve(NODE_DIR, 'api.port');
const DAEMON_LOG_FILE = resolve(NODE_DIR, 'daemon.log');
const MARKER_FILE = resolve(DEVNET_DIR, '.playwright-managed');

// 4-node minSig=3 devnet (see playwright.config.ts NUM_NODES): one extra daemon
// boot + a wider libp2p mesh to settle vs the old 3-node default, so give the
// mesh-wait headroom (240s) under the generous 600s CI webServer timeout.
const BOOTSTRAP_TIMEOUT_MS = parseInt(
  process.env.PLAYWRIGHT_DEVNET_TIMEOUT_MS || '240000',
  10,
);

// Default node count must cover the target node — `UI_NODE_ID=5` needs ≥5 nodes.
const NUM_NODES_INT = parseInt(
  process.env.PLAYWRIGHT_DEVNET_NUM_NODES || String(NODE_NUM_INT),
  10,
) || NODE_NUM_INT;
if (NUM_NODES_INT < NODE_NUM_INT) {
  throw new Error(
    `[playwright] PLAYWRIGHT_DEVNET_NUM_NODES=${NUM_NODES_INT} is less than ` +
    `target node${NODE_NUM_INT}. Raise NUM_NODES or point UI_NODE_ID at a ` +
    `node inside the cluster you start.`,
  );
}
const NUM_NODES = String(NUM_NODES_INT);

// Settled connected-peer count the UI's target node must reach. node1 is the
// relay hub every other node dials (sees N-1); a non-hub node sees only the hub
// (1). Mirrors EXPECTED_MIN_PEERS in helpers/real-node.ts — kept inline so this
// pre-test bootstrap stays dependency-light (it runs before the test runner).
const EXPECTED_MIN_PEERS = NODE_NUM_INT === 1 ? Math.max(1, NUM_NODES_INT - 1) : 1;

const API_PORT_BASE =
  process.env.API_PORT_BASE ||
  process.env.PLAYWRIGHT_DEVNET_API_PORT_BASE ||
  '19201';
const LIBP2P_PORT_BASE =
  process.env.LIBP2P_PORT_BASE ||
  process.env.PLAYWRIGHT_DEVNET_LIBP2P_PORT_BASE ||
  '20001';

export interface PlaywrightManagedMarker {
  startedAtMs: number;
  nodeNum: string;
  numNodes: string;
  /** Nodes already reachable before this bootstrap spawned devnet.sh */
  preExistingNodes: number[];
}

function tailFile(path: string, bytes: number): string {
  if (!existsSync(path)) return '';
  try {
    const buf = readFileSync(path);
    const start = Math.max(0, buf.length - bytes);
    return buf.slice(start).toString('utf8');
  } catch {
    return '';
  }
}

function probeTcp(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connect({ host: '127.0.0.1', port, timeout: timeoutMs }, () => {
      socket.end();
      resolveProbe(true);
    });
    socket.on('error', () => resolveProbe(false));
    socket.on('timeout', () => { socket.destroy(); resolveProbe(false); });
  });
}

function readPortFileForNode(nodeIndex: number): number | null {
  const portFile = resolve(DEVNET_DIR, `node${nodeIndex}`, 'api.port');
  if (!existsSync(portFile)) return null;
  const port = parseInt(readFileSync(portFile, 'utf8').trim(), 10);
  return Number.isFinite(port) && port > 0 ? port : null;
}

async function isNodeReachable(nodeIndex: number): Promise<{ reachable: boolean; port: number | null }> {
  const port = readPortFileForNode(nodeIndex);
  if (!port) return { reachable: false, port: null };
  return { reachable: await probeTcp(port), port };
}

async function isReachable(): Promise<{ reachable: boolean; port: number | null }> {
  return isNodeReachable(NODE_NUM_INT);
}

async function probeExistingNodes(numNodes: number): Promise<number[]> {
  const existing: number[] = [];
  for (let i = 1; i <= numNodes; i++) {
    const { reachable } = await isNodeReachable(i);
    if (reachable) existing.push(i);
  }
  return existing;
}

/**
 * Poll until ALL `numNodes` nodes are reachable (the full relay-hub mesh the
 * suite needs), or the deadline passes. `scripts/devnet.sh start` waits for each
 * node internally before returning, so this usually settles immediately; the
 * poll just rides out a peer whose api.port lands a moment after the target.
 * Returns the final reachable-node list so the caller can report the gap.
 */
async function waitForMesh(numNodes: number, timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let reachable: number[] = [];
  while (Date.now() < deadline) {
    reachable = await probeExistingNodes(numNodes);
    if (reachable.length >= numNodes) return reachable;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return reachable;
}

/** Connected libp2p peer count node `nodeNum` reports, or -1 if unreadable. */
async function readConnectedPeers(nodeNum: number): Promise<number> {
  try {
    const res = await devnetApiFetch('/api/status', { nodeNum });
    if (!res.ok) return -1;
    const json = (await res.json()) as { connectedPeers?: number };
    return typeof json.connectedPeers === 'number' ? json.connectedPeers : -1;
  } catch {
    return -1;
  }
}

/**
 * Poll until node `nodeNum` reports at least `minPeers` connected peers (the
 * libp2p mesh has settled), or the deadline passes. All daemons answering their
 * API does NOT prove they're peered — a reused devnet can be fully API-reachable
 * yet libp2p-partitioned. Returns the last observed count so the caller can
 * report the gap.
 */
async function waitForPeers(nodeNum: number, minPeers: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    last = await readConnectedPeers(nodeNum);
    if (last >= minPeers) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

async function waitForReady(label: string): Promise<number> {
  const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS;
  let lastLog = 0;
  while (Date.now() < deadline) {
    const { reachable, port } = await isReachable();
    if (reachable && port) return port;
    if (Date.now() - lastLog > 10_000) {
      const elapsed = Math.round((Date.now() - (deadline - BOOTSTRAP_TIMEOUT_MS)) / 1000);
      console.log(`[playwright] still waiting for ${label} (~${elapsed}s elapsed)...`);
      lastLog = Date.now();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `[playwright] devnet node${NODE_NUM} did not become ready within ${BOOTSTRAP_TIMEOUT_MS}ms. ` +
    `Inspect ${resolve(NODE_DIR, 'daemon.log')} or run \`pnpm devnet:status\`.`,
  );
}

type SpawnResult = { exitCode: number };

function spawnDevnet(): Promise<SpawnResult> {
  mkdirSync(DEVNET_DIR, { recursive: true });
  return new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(
      'bash',
      [resolve(REPO_ROOT, 'scripts/devnet.sh'), 'start', NUM_NODES],
      {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
          ...process.env,
          API_PORT_BASE,
          LIBP2P_PORT_BASE,
        },
      },
    );
    child.on('error', rejectSpawn);
    child.on('exit', (code) => {
      // We deliberately do NOT reject on a non-zero exit. devnet.sh
      // hardens its boot path with a bunch of optional post-boot
      // assertions (context-graph publishPolicy checks, identity
      // registration sanity, etc) that can flake intermittently while
      // leaving the daemon itself perfectly healthy on its API port.
      // Those flakes are useful operator-feedback during a manual
      // bring-up but they should NOT abort our test run when the only
      // thing we need is a reachable api.port. The caller below
      // probes the port and decides for itself.
      resolveSpawn({ exitCode: typeof code === 'number' ? code : 1 });
    });
  });
}

function clearMarker(): void {
  try { rmSync(MARKER_FILE, { force: true }); } catch { /* best-effort */ }
}

function writeMarker(preExistingNodes: number[]): void {
  const marker: PlaywrightManagedMarker = {
    startedAtMs: Date.now(),
    nodeNum: NODE_NUM,
    numNodes: NUM_NODES,
    preExistingNodes,
  };
  writeFileSync(MARKER_FILE, JSON.stringify(marker, null, 2));
}

async function main(): Promise<void> {
  const initial = await isReachable();
  if (initial.reachable && initial.port) {
    // The target node being up is NOT sufficient: this suite needs the full
    // relay-hub mesh — node1 + peers — for VM-publish ACK quorum and the
    // peer-connectivity assertions (global-setup waits for connected peers;
    // peer-connectivity.spec expects the N-node topology).
    const reachableNodes = await probeExistingNodes(NUM_NODES_INT);
    if (reachableNodes.length >= NUM_NODES_INT) {
      // Every daemon answers its API — but that does NOT prove libp2p is meshed.
      // A reused devnet can be fully API-reachable yet partitioned, which would
      // later surface as exactly the publish/peer-count failures this suite
      // exists to prevent. Verify the selected UI node reaches its settled
      // connected-peer count before skipping repair; poll to ride out cold-boot
      // dialing (returns instantly on an already-settled long-running devnet).
      const peers = await waitForPeers(NODE_NUM_INT, EXPECTED_MIN_PEERS, 60_000);
      if (peers >= EXPECTED_MIN_PEERS) {
        console.log(
          `[playwright] reusing healthy ${reachableNodes.length}-node devnet ` +
          `(node${NODE_NUM}: ${peers} connected peer(s) >= ${EXPECTED_MIN_PEERS} @ port ${initial.port})`,
        );
        return;
      }
      // Daemons up but mesh not settled — fall through to repair (and let the
      // post-(re)start mesh check + global-setup's peer wait be the final gate).
      console.log(
        `[playwright] devnet daemons all reachable but node${NODE_NUM} mesh not settled ` +
        `(${peers}/${EXPECTED_MIN_PEERS} connected peers) -- repairing via scripts/devnet.sh start...`,
      );
    } else {
      // Partial cluster — e.g. node1 survived an interrupted run but a peer is
      // down. Rather than abort and force a manual cleanup, REPAIR it: fall
      // through to `scripts/devnet.sh start`, which is idempotent per node (it
      // skips already-running nodes and boots only the missing peers). The
      // post-(re)start mesh check below fails fast only if recovery still leaves
      // the cluster incomplete.
      console.log(
        `[playwright] devnet partially up on node${NODE_NUM} (reachable: ${reachableNodes.join(',') || 'none'}; ` +
        `need ${NUM_NODES_INT}) -- backfilling missing nodes via scripts/devnet.sh start...`,
      );
    }
  }

  const preExistingNodes = await probeExistingNodes(NUM_NODES_INT);

  console.log(
    `[playwright] devnet node${NODE_NUM} not fully up -- bootstrapping ` +
    `(NUM_NODES=${NUM_NODES}, API_PORT_BASE=${API_PORT_BASE}, ` +
    `LIBP2P_PORT_BASE=${LIBP2P_PORT_BASE}` +
    (preExistingNodes.length ? `, pre-existing nodes: ${preExistingNodes.join(',')}` : '') +
    `)...`,
  );

  const spawnResult = await spawnDevnet();

  // The script may have returned non-zero from a post-boot assertion
  // even though the daemon is up and listening on api.port. The
  // canonical signal that we're ready is "TCP-probe-able api.port",
  // not "scripts/devnet.sh exit 0" -- so always probe before deciding
  // whether to fail. If both checks fail we surface the daemon-log
  // tail so operators can diagnose without a second round-trip.
  let port: number;
  try {
    port = await waitForReady(`node${NODE_NUM}`);
  } catch (err) {
    clearMarker();
    const tail = tailFile(DAEMON_LOG_FILE, 4096).trim();
    const detail = tail
      ? `\n\n----- last 4 KiB of ${DAEMON_LOG_FILE} -----\n${tail}\n----- end -----`
      : '';
    throw new Error(
      `[playwright] devnet bootstrap failed ` +
      `(scripts/devnet.sh exit=${spawnResult.exitCode}, ` +
      `API_PORT_BASE=${API_PORT_BASE}, LIBP2P_PORT_BASE=${LIBP2P_PORT_BASE}, ` +
      `NUM_NODES=${NUM_NODES}). ${(err as Error).message}${detail}`,
    );
  }

  // The target node is up — but the suite needs the WHOLE mesh, so confirm every
  // node came up (a fresh boot OR a backfilled partial cluster). Fail fast with a
  // clear message if recovery still left the mesh incomplete, instead of letting
  // the gap resurface later as a confusing QuorumUnmet / peer-connectivity error.
  const meshNodes = await waitForMesh(NUM_NODES_INT, 60_000);
  if (meshNodes.length < NUM_NODES_INT) {
    clearMarker();
    const tail = tailFile(DAEMON_LOG_FILE, 4096).trim();
    const detail = tail
      ? `\n\n----- last 4 KiB of ${DAEMON_LOG_FILE} -----\n${tail}\n----- end -----`
      : '';
    throw new Error(
      `[playwright] devnet mesh incomplete after bootstrap: only node(s) ${meshNodes.join(',') || '(none)'} ` +
      `of ${NUM_NODES_INT} are reachable (scripts/devnet.sh exit=${spawnResult.exitCode}). The suite needs ` +
      `the full relay-hub mesh for VM-publish quorum and peer-connectivity. ${detail}`,
    );
  }

  // Marker is written only after readiness is confirmed so a crashed
  // bootstrap never leaves a stale "we own this devnet" flag behind.
  writeMarker(preExistingNodes);

  if (spawnResult.exitCode !== 0) {
    console.warn(
      `[playwright] scripts/devnet.sh exited non-zero (${spawnResult.exitCode}) ` +
      `but node${NODE_NUM} is reachable on port ${port} -- proceeding. ` +
      `Most often this means a post-boot assertion (e.g. context-graph ` +
      `publishPolicy check) flaked; the daemon itself is healthy.`,
    );
  }
  console.log(`[playwright] devnet ready on port ${port} -- handing off to Vite`);
}

main().catch((err) => {
  clearMarker();
  console.error('[playwright] devnet bootstrap FAILED:', err?.stack || err);
  process.exit(1);
});
