/**
 * Subscription persistence across a real node restart — devnet coverage for the
 * keyed persist scheduler that now serializes, bounds and DRAINS context-graph
 * subscription store writes (the same scheduler type membership persistence uses).
 *
 * Before that change a subscription write was a bare promise chain: `stop()` did
 * not await it, so a write issued just before shutdown could still be running
 * while the daemon tore the node down around it, and a restarted node reconciled
 * against whatever the store happened to hold. Now `stop()` closes admission and
 * waits for every admitted write, and the daemon keeps its backing stores open if
 * that wait ever times out.
 *
 * What this suite proves on a real devnet (real libp2p, real Hardhat chain, real
 * daemons with the SQLite subscription store):
 *
 *   (1) Subscribe and unsubscribe churn on an EDGE node, acknowledged by the HTTP
 *       API and followed IMMEDIATELY by `devnet.sh restart-node`, is durable: after
 *       the restart the node serves exactly the last acknowledged subscription
 *       state for every context graph the suite created.
 *   (2) The same holds across `stop-node` followed by a start, with a second churn
 *       round layered on the first, so the durable rows are rewritten, not just
 *       created.
 *   (3) The daemon logs no subscription- or membership-persistence drain timeout
 *       and no failed subscription persist during the run. "During the run" is a
 *       byte window of daemon.log recorded before the first action (see
 *       log-window.ts): a log rotated by a daemon restart cannot hide a fresh line.
 *
 * Node roles on the standard 6-node devnet: nodes 1-4 are cores, nodes 5-6 are
 * edges. Node 1 authors the context graphs; node 5 (an edge) churns them.
 *
 * ISOLATION: the suite mutates only context graphs it creates itself
 * (`spr-<stamp>-<n>`), and restarts only the edge node it churns. It never touches
 * the shared devnet-test context graph.
 *
 * HONEST SCOPE: the daemon's SQLite writes are fast, so this suite proves durability
 * and consistency across graceful restarts on the real stack; it cannot hold a write
 * open long enough to prove the drain itself. The drain is pinned by
 * packages/agent/test/e2e-subscription-persist-lifecycle.test.ts (a deliberately slow
 * on-disk store) and by the unit tests next to it.
 *
 * Run: `pnpm test:devnet:subscription-persist-restart` (see the README).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEVNET_DIR,
  REPO_ROOT,
  RPC,
  detectDevnet,
  fetchStatus,
  getJson,
  postJson,
  sleep,
  waitFor,
  type DevnetNode,
  type DevnetState,
} from '../_bootstrap/harness.js';
import { markLog, matchingLinesSince, type LogMark } from './log-window.js';

const AUTHOR_NODE = 1;
const EDGE_NODE = Number(process.env.DEVNET_SPR_EDGE_NODE ?? 5);
const GRAPH_COUNT = 8;
const STAMP = Date.now().toString(36);
const DEVNET_SH = join(REPO_ROOT, 'scripts', 'devnet.sh');

const graphIds = Array.from({ length: GRAPH_COUNT }, (_, index) => `spr-${STAMP}-${index}`);

/** Log lines that mean subscription or membership persistence lost or blocked a write. */
const PERSISTENCE_TROUBLE = [
  /context-graph subscription persistence did not drain/i,
  /context-graph membership persistence did not drain/i,
  /CG_SUBSCRIPTION_PERSIST_SHUTDOWN_TIMEOUT/,
  /Failed to persist context-graph subscription/i,
  /Failed to delete persisted context-graph subscription/i,
  /Context-graph subscription persistence (is closed|reached its)/i,
];

function devnetPortEnv(): Record<string, string> {
  const cfg = JSON.parse(readFileSync(join(DEVNET_DIR, 'node1', 'config.json'), 'utf8'));
  const rpcPort = new URL(RPC).port || '8545';
  return {
    HARDHAT_PORT: rpcPort,
    API_PORT_BASE: String(cfg.apiPort ?? 9201),
    LIBP2P_PORT_BASE: String(cfg.listenPort ?? 10001),
  };
}

function devnetSh(command: 'stop-node' | 'restart-node', num: number): void {
  execFileSync('bash', [DEVNET_SH, command, String(num)], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...devnetPortEnv() },
  });
}

async function reachable(node: DevnetNode): Promise<boolean> {
  try {
    return (await getJson(node, '/api/status')).status === 200;
  } catch {
    return false;
  }
}

async function waitUntilReachable(node: DevnetNode, timeoutMs = 120_000): Promise<void> {
  await waitFor(`node${node.num} API reachable`, timeoutMs, 2_000, async () => ((await reachable(node)) ? true : null));
}

function daemonLogFile(node: DevnetNode): string {
  return join(node.home, 'daemon.log');
}

async function subscribedSpr(node: DevnetNode): Promise<string[]> {
  const res = await getJson(node, '/api/context-graph/subscriptions');
  if (res.status !== 200) return [];
  return (res.json.subscriptions as Array<{ contextGraphId: string; subscribed: boolean }>)
    .filter((row) => row.subscribed && row.contextGraphId.startsWith(`spr-${STAMP}-`))
    .map((row) => row.contextGraphId)
    .sort();
}

async function subscribe(node: DevnetNode, contextGraphId: string): Promise<void> {
  // A subscribe can answer a retryable 503 while its authority read is still
  // resolving; only an acknowledged 200 counts as applied.
  await waitFor(`subscribe ${contextGraphId}`, 60_000, 1_000, async () => {
    const res = await postJson(node, '/api/context-graph/subscribe', { contextGraphId });
    return res.status === 200 ? res : null;
  });
}

async function unsubscribe(node: DevnetNode, contextGraphId: string): Promise<void> {
  const res = await postJson(node, '/api/context-graph/unsubscribe', { contextGraphId });
  expect(res.status, `unsubscribe ${contextGraphId}: ${JSON.stringify(res.json)}`).toBe(200);
}

describe('subscription persistence across a real node restart', () => {
  const state: { v: DevnetState | null } = { v: null };
  let author: DevnetNode;
  let edge: DevnetNode;
  /** Where daemon.log stood before the suite acted; only what is written after it counts. */
  let logMark: LogMark;
  /** Acknowledged subscription intent per graph; the durable state must equal it after every restart. */
  const expected = new Map<string, boolean>();

  beforeAll(async () => {
    state.v = await detectDevnet(6);
    if (!state.v) {
      throw new Error(
        'No devnet detected. Start one first: ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6',
      );
    }
    author = state.v.nodes[AUTHOR_NODE]!;
    edge = state.v.nodes[EDGE_NODE]!;
    const role = (await fetchStatus(edge)).nodeRole;
    expect(role, `node${EDGE_NODE} must be an edge node`).toBe('edge');
    logMark = markLog(daemonLogFile(edge));

    // Self-created, registered public context graphs the edge can subscribe to.
    for (const id of graphIds) {
      const created = await postJson(author, '/api/context-graph/create', {
        id,
        name: id,
        description: 'subscription persistence restart suite',
        accessPolicy: 0,
        publishPolicy: 1,
        register: true,
      });
      expect(created.status, `create ${id}: ${JSON.stringify(created.json)}`).toBe(200);
      expect(created.json.registered, `register ${id}`).toBe(true);
    }
  }, 240_000);

  async function expectDurableState(label: string): Promise<void> {
    const want = [...expected.entries()].filter(([, subscribed]) => subscribed).map(([id]) => id).sort();
    const got = await waitFor(`${label}: node${EDGE_NODE} serves the acknowledged subscription state`, 150_000, 3_000, async () => {
      const live = await subscribedSpr(edge);
      return JSON.stringify(live) === JSON.stringify(want) ? live : null;
    }).catch(async (error) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n`
        + `want ${JSON.stringify(want)}\n got ${JSON.stringify(await subscribedSpr(edge))}`,
      );
    });
    expect(got).toEqual(want);
  }

  it('churns subscribe and unsubscribe on an edge node, then restart-node keeps the acknowledged state', async () => {
    await Promise.all(graphIds.map((id) => subscribe(edge, id)));
    for (const id of graphIds) expected.set(id, true);

    // Drop every even graph, then bring two of them back, so the last write per
    // graph is not the first one issued.
    const evens = graphIds.filter((_, index) => index % 2 === 0);
    await Promise.all(evens.map((id) => unsubscribe(edge, id)));
    for (const id of evens) expected.set(id, false);
    await Promise.all(evens.slice(0, 2).map((id) => subscribe(edge, id)));
    for (const id of evens.slice(0, 2)) expected.set(id, true);

    // No settling time: catch-up jobs and the persistence behind the last
    // acknowledged requests are still in flight when the daemon is bounced.
    devnetSh('restart-node', EDGE_NODE);
    await waitUntilReachable(edge);
    await expectDurableState('after restart-node');
  }, 480_000);

  it('a second churn round survives stop-node followed by a start', async () => {
    // Rewrite rows that already exist: drop two live graphs and revive one dropped graph.
    const live = graphIds.filter((id) => expected.get(id));
    const dropped = graphIds.filter((id) => !expected.get(id));
    expect(live.length).toBeGreaterThanOrEqual(3);
    expect(dropped.length).toBeGreaterThanOrEqual(1);
    const toDrop = live.slice(0, 2);
    const toRevive = dropped.slice(0, 1);
    await Promise.all(toDrop.map((id) => unsubscribe(edge, id)));
    for (const id of toDrop) expected.set(id, false);
    await Promise.all(toRevive.map((id) => subscribe(edge, id)));
    for (const id of toRevive) expected.set(id, true);

    devnetSh('stop-node', EDGE_NODE);
    await waitFor(`node${EDGE_NODE} stopped`, 60_000, 1_000, async () => ((await reachable(edge)) ? null : true));
    devnetSh('restart-node', EDGE_NODE);
    await waitUntilReachable(edge);
    await expectDurableState('after stop-node + start');
  }, 480_000);

  it('a restarted edge still persists new subscription changes', async () => {
    const dropped = graphIds.find((id) => !expected.get(id))!;
    await subscribe(edge, dropped);
    expected.set(dropped, true);
    const live = graphIds.find((id) => id !== dropped && expected.get(id))!;
    await unsubscribe(edge, live);
    expected.set(live, false);
    await sleep(1_000);

    devnetSh('restart-node', EDGE_NODE);
    await waitUntilReachable(edge);
    await expectDurableState('after a third restart');
  }, 480_000);

  it('the edge daemon logged no persistence drain timeout or failed subscription persist', () => {
    // The window is delimited by the byte offset recorded in beforeAll, never by
    // a count of earlier matches: a restart can rotate daemon.log, which drops
    // old matching lines and would let a count-based skip swallow a fresh one.
    // A rotated log has no meaningful offset, so every matching line in it counts.
    const { lines, rotated } = matchingLinesSince(daemonLogFile(edge), logMark, PERSISTENCE_TROUBLE);
    expect(
      lines,
      `new persistence trouble in node${EDGE_NODE} daemon.log`
      + `${rotated ? ' (the log was rotated during the run, so every matching line in it counts as new)' : ''}:\n`
      + lines.join('\n'),
    ).toEqual([]);
  });
});
