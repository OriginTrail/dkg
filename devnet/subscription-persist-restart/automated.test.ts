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
 * daemons with the SQLite subscription store). Each scenario below is one `it`
 * that runs a sequence of named phases (create graphs, churn, bounce the edge,
 * check the durable state, ...) against context graphs of its own, so any one can
 * be selected by its name with `vitest -t` and they can run in any order:
 *
 *   (1) "churns subscribe and unsubscribe ...": subscribe and unsubscribe churn on
 *       an EDGE node, acknowledged by the HTTP API and followed IMMEDIATELY by
 *       `devnet.sh restart-node`, is durable: after the restart the node serves
 *       exactly the last acknowledged subscription state for every context graph
 *       the scenario created.
 *   (2) "a second churn round rewrites rows that already exist ...": the same
 *       holds across `stop-node` followed by a start, with a second churn round
 *       layered on a first one that a restart already proved durable, so the
 *       durable rows are rewritten, not just created.
 *   (3) "a restarted edge still persists new subscription changes": after a
 *       restart, new changes are admitted and persisted, and survive one more
 *       restart.
 *
 * Every scenario also runs inside a log check: the daemon logs no subscription- or
 * membership-persistence drain timeout and no failed subscription persist while
 * the scenario runs, and that holds when the scenario fails midway too (the
 * daemon's trouble is added to the scenario's own failure, never lost behind it).
 * "While it runs" is a byte window of daemon.log recorded before the scenario's
 * first action (see log-window.ts): a log rotated by a daemon restart cannot hide
 * a fresh line. An `afterAll` check over the whole run backs it up for lines logged
 * between two scenarios.
 *
 * Node roles on the standard 6-node devnet: nodes 1-4 are cores, nodes 5-6 are
 * edges. Node 1 authors the context graphs; node 5 (an edge) churns them.
 *
 * ISOLATION: a scenario mutates only context graphs it creates itself
 * (`spr-<stamp>-<scenario>-<n>`, its expected state and its log window are its
 * own), and restarts only the edge node it churns. It never touches the shared
 * devnet-test context graph. The devnet, its nodes and the edge daemon are shared
 * infrastructure: scenarios run one after another and each leaves the edge
 * running, restarting it in its own cleanup if it failed between `stop-node` and
 * the start, and unsubscribes its graphs again (the edge rehydrates every durable
 * subscription on each start, under a cap, so leftovers from many runs would slow
 * the next scenario's restart down). What is NOT isolated: a scenario that hangs
 * the daemon or the devnet fails the ones after it, and the cleanup is best
 * effort.
 *
 * HONEST SCOPE: the daemon's SQLite writes are fast, so this suite proves durability
 * and consistency across graceful restarts on the real stack; it cannot hold a write
 * open long enough to prove the drain itself. The drain is pinned by
 * packages/agent/test/e2e-subscription-persist-lifecycle.test.ts (a deliberately slow
 * on-disk store) and by the unit tests next to it.
 *
 * Run: `pnpm test:devnet:subscription-persist-restart` (see the README).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
} from '../_bootstrap/harness.js';
import { markLog, matchingLinesSince, withLogTroubleCheck, type LogMark } from './log-window.js';

const AUTHOR_NODE = 1;
const EDGE_NODE = Number(process.env.DEVNET_SPR_EDGE_NODE ?? 5);
const GRAPH_COUNT = 8;
const STAMP = Date.now().toString(36);
const DEVNET_SH = join(REPO_ROOT, 'scripts', 'devnet.sh');

/**
 * Test-level budgets. Setting up a scenario's graphs used to be a 240 s hook and
 * every restart-and-check test had 480 s; a scenario that runs those phases in one
 * `it` gets their sum (each phase still has its own, shorter `waitFor` timeouts,
 * so a stuck phase fails with its own message long before this backstop).
 */
const SETUP_BUDGET_MS = 240_000;
const BOUNCE_BUDGET_MS = 480_000;

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

/** The graphs of one scenario that the edge serves as subscribed, by the scenario's own id prefix. */
async function subscribedSpr(node: DevnetNode, prefix: string): Promise<string[]> {
  const res = await getJson(node, '/api/context-graph/subscriptions');
  if (res.status !== 200) return [];
  return (res.json.subscriptions as Array<{ contextGraphId: string; subscribed: boolean }>)
    .filter((row) => row.subscribed && row.contextGraphId.startsWith(prefix))
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

/** What one scenario owns: its own context graphs and its own acknowledged-state map. */
interface Scenario {
  /** `spr-<stamp>-<scenario>-`: the trailing dash keeps one scenario's prefix from matching another's. */
  readonly prefix: string;
  readonly graphIds: readonly string[];
  /** Acknowledged subscription intent per graph; the durable state must equal it after every bounce. */
  readonly expected: Map<string, boolean>;
}

function newScenario(key: string): Scenario {
  const prefix = `spr-${STAMP}-${key}-`;
  return {
    prefix,
    graphIds: Array.from({ length: GRAPH_COUNT }, (_, index) => `${prefix}${index}`),
    expected: new Map(),
  };
}

describe('subscription persistence across a real node restart', () => {
  let author: DevnetNode;
  let edge: DevnetNode;
  /** Where daemon.log stood before the suite acted; the `afterAll` check reads what came after it. */
  let suiteMark: LogMark | undefined;

  beforeAll(async () => {
    const devnet = await detectDevnet(6);
    if (!devnet) {
      throw new Error(
        'No devnet detected. Start one first: ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6',
      );
    }
    author = devnet.nodes[AUTHOR_NODE]!;
    edge = devnet.nodes[EDGE_NODE]!;
    const role = (await fetchStatus(edge)).nodeRole;
    expect(role, `node${EDGE_NODE} must be an edge node`).toBe('edge');
    suiteMark = markLog(daemonLogFile(edge));
  });

  afterAll(() => {
    // A second net under the per-scenario windows, over the whole run: it also
    // covers what the edge logged between two scenarios, where no window is open.
    // The window is delimited by the byte offset recorded in beforeAll, never by
    // a count of earlier matches: a restart can rotate daemon.log, which drops
    // old matching lines and would let a count-based skip swallow a fresh one.
    // A rotated log has no meaningful offset, so every matching line in it
    // counts as new.
    if (!suiteMark) return;
    const { lines, rotated } = matchingLinesSince(daemonLogFile(edge), suiteMark, PERSISTENCE_TROUBLE);
    expect(
      lines,
      `new persistence trouble in node${EDGE_NODE} daemon.log over the whole run`
      + `${rotated ? ' (the log was rotated during the run, so every matching line in it counts as new)' : ''}:\n`
      + lines.join('\n'),
    ).toEqual([]);
  });

  /** A running edge, restarting it when an earlier phase (or scenario) left it stopped. */
  async function ensureEdgeUp(): Promise<void> {
    if (await reachable(edge)) return;
    devnetSh('restart-node', EDGE_NODE);
    await waitUntilReachable(edge);
  }

  /**
   * Drop every graph the scenario may have subscribed, best effort, so the edge is
   * left as the scenario found it. The subscriptions are durable rows that the
   * daemon rehydrates on every start, under an activation cap and a startup
   * authority budget: scenarios (and repeated runs) that leave theirs behind pile
   * them up until a restarted edge serves the next scenario's graphs late.
   */
  async function releaseGraphs(s: Scenario): Promise<void> {
    await Promise.allSettled(s.graphIds.map((id) => postJson(edge, '/api/context-graph/unsubscribe', { contextGraphId: id })));
  }

  /**
   * One scenario: a named `it` that runs `run` over a fresh {@link Scenario}, inside
   * the log check. The edge is up when `run` starts and again when it ends, however
   * it ends, so a failed scenario cannot take the following ones down with it, and
   * the scenario's subscriptions are dropped again; the log window is read whether
   * `run` passed or failed.
   */
  function scenario(name: string, key: string, bounces: number, run: (s: Scenario) => Promise<void>): void {
    it(name, async () => {
      await withLogTroubleCheck(daemonLogFile(edge), PERSISTENCE_TROUBLE, `node${EDGE_NODE} daemon.log`, async () => {
        await ensureEdgeUp();
        const s = newScenario(key);
        try {
          await run(s);
        } finally {
          try {
            await ensureEdgeUp();
            await releaseGraphs(s);
          } catch (error) {
            console.error(`scenario "${key}": cleanup of node${EDGE_NODE} failed: ${String(error)}`);
          }
        }
      });
    }, SETUP_BUDGET_MS + bounces * BOUNCE_BUDGET_MS);
  }

  // ---- phases ------------------------------------------------------------

  /** Self-created, registered public context graphs the edge can subscribe to. */
  async function createGraphs(s: Scenario): Promise<void> {
    for (const id of s.graphIds) {
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
  }

  async function subscribeGraphs(s: Scenario, ids: readonly string[]): Promise<void> {
    await Promise.all(ids.map((id) => subscribe(edge, id)));
    for (const id of ids) s.expected.set(id, true);
  }

  async function unsubscribeGraphs(s: Scenario, ids: readonly string[]): Promise<void> {
    await Promise.all(ids.map((id) => unsubscribe(edge, id)));
    for (const id of ids) s.expected.set(id, false);
  }

  /** Subscribe every graph, drop the even ones, bring two of them back: a mix of live and dropped rows. */
  async function firstChurnRound(s: Scenario): Promise<void> {
    await subscribeGraphs(s, s.graphIds);
    // Drop every even graph, then bring two of them back, so the last write per
    // graph is not the first one issued.
    const evens = s.graphIds.filter((_, index) => index % 2 === 0);
    await unsubscribeGraphs(s, evens);
    await subscribeGraphs(s, evens.slice(0, 2));
  }

  /** Rewrite rows that already exist: drop two live graphs and revive one dropped graph. */
  async function secondChurnRound(s: Scenario): Promise<void> {
    const live = s.graphIds.filter((id) => s.expected.get(id));
    const dropped = s.graphIds.filter((id) => !s.expected.get(id));
    expect(live.length).toBeGreaterThanOrEqual(3);
    expect(dropped.length).toBeGreaterThanOrEqual(1);
    await unsubscribeGraphs(s, live.slice(0, 2));
    await subscribeGraphs(s, dropped.slice(0, 1));
  }

  /** New changes on a restarted edge: revive one dropped graph and drop one live graph. */
  async function changeAfterRestart(s: Scenario): Promise<void> {
    const dropped = s.graphIds.find((id) => !s.expected.get(id))!;
    await subscribeGraphs(s, [dropped]);
    const live = s.graphIds.find((id) => id !== dropped && s.expected.get(id))!;
    await unsubscribeGraphs(s, [live]);
  }

  /** `devnet.sh restart-node`: stop the daemon and start it again, then wait for its API. */
  async function restartEdge(): Promise<void> {
    devnetSh('restart-node', EDGE_NODE);
    await waitUntilReachable(edge);
  }

  /** `stop-node`, wait until it is really down, then start it again. */
  async function stopThenStartEdge(): Promise<void> {
    devnetSh('stop-node', EDGE_NODE);
    await waitFor(`node${EDGE_NODE} stopped`, 60_000, 1_000, async () => ((await reachable(edge)) ? null : true));
    devnetSh('restart-node', EDGE_NODE);
    await waitUntilReachable(edge);
  }

  async function expectDurableState(s: Scenario, label: string): Promise<void> {
    const want = [...s.expected.entries()].filter(([, subscribed]) => subscribed).map(([id]) => id).sort();
    const got = await waitFor(`${label}: node${EDGE_NODE} serves the acknowledged subscription state`, 150_000, 3_000, async () => {
      const live = await subscribedSpr(edge, s.prefix);
      return JSON.stringify(live) === JSON.stringify(want) ? live : null;
    }).catch(async (error) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n`
        + `want ${JSON.stringify(want)}\n got ${JSON.stringify(await subscribedSpr(edge, s.prefix))}`,
      );
    });
    expect(got).toEqual(want);
  }

  // ---- scenarios ---------------------------------------------------------

  scenario('churns subscribe and unsubscribe on an edge node, then restart-node keeps the acknowledged state', 'churn', 1, async (s) => {
    await createGraphs(s);
    await firstChurnRound(s);
    // No settling time: catch-up jobs and the persistence behind the last
    // acknowledged requests are still in flight when the daemon is bounced.
    await restartEdge();
    await expectDurableState(s, 'after restart-node');
  });

  scenario('a second churn round rewrites rows that already exist and survives stop-node followed by a start', 'rewrite', 2, async (s) => {
    await createGraphs(s);
    await firstChurnRound(s);
    await restartEdge();
    // The restart shows the first round's rows are durable, so the second round rewrites rows that exist.
    await expectDurableState(s, 'after restart-node');
    await secondChurnRound(s);
    await stopThenStartEdge();
    await expectDurableState(s, 'after stop-node + start');
  });

  scenario('a restarted edge still persists new subscription changes', 'restarted', 2, async (s) => {
    await createGraphs(s);
    await firstChurnRound(s);
    await restartEdge();
    await expectDurableState(s, 'after restart-node');
    // From here the edge is a restarted one: its persistence must admit and keep new writes.
    await changeAfterRestart(s);
    await sleep(1_000);
    await restartEdge();
    await expectDurableState(s, 'after a second restart');
  });
});
