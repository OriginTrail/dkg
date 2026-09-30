/**
 * agent-restart-gossip - devnet validation.
 *
 * A subscribed node that restarts must keep receiving the graph's Shared
 * Working Memory (SWM) gossip. `DKGAgent.stop()` followed by `start()` on the
 * SAME instance builds a brand-new GossipSubManager on a brand-new libp2p
 * node; the agent used to keep its "already subscribed" registries across that
 * swap, so the restarted node never subscribed anything and went deaf.
 *
 * Two real-network checks against the live devnet, both on a context graph the
 * suite creates itself (nothing shared or pre-existing is mutated):
 *
 *  A. REGRESSION (real daemon, process restart). Edge node5 subscribes to a
 *     fresh public graph; a core shares; node5 restarts through
 *     `devnet.sh restart-node` (a NEW PROCESS: startup rehydration re-subscribes
 *     it, so this passes without the fix too); the core shares again and node5
 *     must still receive it.
 *
 *  B. DISCRIMINATING (real devnet, in-place restart). The daemon has no
 *     in-process agent restart, so an SDK `DKGAgent` joins the devnet as an
 *     edge (real libp2p, real Hardhat chain adapter, real core daemons). It
 *     subscribes, receives a core's share over gossip, is stopped and started
 *     again on the SAME instance, and must receive the next share over gossip.
 *     Automatic catch-up is off for the SDK agent, so a write that arrives
 *     after its one explicit metadata sync can only have come over gossip.
 *     This is the check that fails without the fix.
 *
 * Run (see README.md):
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *   pnpm test:devnet:agent-restart-gossip
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DKGAgent } from '../../packages/agent/dist/index.js';
import { EVMChainAdapter } from '../../packages/chain/dist/index.js';
import { DKGEvent, contextGraphSharedMemoryTopic } from '../../packages/core/dist/index.js';
import {
  REPO_ROOT,
  DEVNET_DIR,
  sleep,
  readNodeConfig,
  fetchStatus,
  postJson,
  queryNode,
  waitFor,
  type DevnetNode,
} from '../_bootstrap/harness';

const CORE = 1;
const EDGE = 5;
const DEVNET_SH = join(REPO_ROOT, 'scripts/devnet.sh');
const STAMP = Date.now().toString(36);
const CG_ID = `devnet-restart-gossip-${STAMP}`;
const CG_GRAPH = `did:dkg:context-graph:${CG_ID}`;
const GOSSIP_GRACE_MS = 3_000;
const RECEIVE_TIMEOUT_MS = 90_000;

let core: DevnetNode;
let edge: DevnetNode;

/** Port env for `devnet.sh restart-node`, derived from node1's config so the
 *  restart matches whatever (possibly non-default) ports this devnet uses. */
function devnetPortEnv(): Record<string, string> {
  const cfg = JSON.parse(readFileSync(join(DEVNET_DIR, 'node1', 'config.json'), 'utf8'));
  return {
    HARDHAT_PORT: new URL(cfg.chain.rpcUrl).port || '8545',
    API_PORT_BASE: String(cfg.apiPort ?? 9201),
    LIBP2P_PORT_BASE: String(cfg.listenPort ?? 10001),
  };
}

async function nodeReachable(node: DevnetNode): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${node.apiPort}/api/status`, {
      headers: node.authToken ? { Authorization: `Bearer ${node.authToken}` } : {},
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Share one fresh entity to the graph's SWM from the core; returns its subject. */
async function shareOnCore(label: string): Promise<string> {
  const subject = `urn:devnet:restart-gossip:${STAMP}:${label}`;
  const res = await postJson(core, '/api/knowledge-assets', {
    name: `restart-gossip-${STAMP}-${label}`,
    contextGraphId: CG_ID,
    alsoShareSwm: true,
    quads: [
      { subject, predicate: 'https://schema.org/name', object: `"restart gossip ${label}"`, graph: CG_GRAPH },
    ],
  });
  expect(res.status, `share ${label} on node${core.num}: ${JSON.stringify(res.json)}`).toBeLessThan(300);
  return subject;
}

/** How many rows a daemon node holds for the subject in the graph's SWM. */
async function rowsOnDaemon(node: DevnetNode, subject: string): Promise<number> {
  const rows = await queryNode(node, `SELECT ?p ?o WHERE { <${subject}> ?p ?o }`, {
    contextGraphId: CG_ID,
    view: 'shared-working-memory',
  });
  return rows.length;
}

beforeAll(async () => {
  core = readNodeConfig(CORE);
  edge = readNodeConfig(EDGE);
  const coreStatus = await fetchStatus(core);
  const edgeStatus = await fetchStatus(edge);
  expect(coreStatus.nodeRole, `node${CORE} must be a core`).toBe('core');
  expect(edgeStatus.nodeRole, `node${EDGE} must be an edge`).toBe('edge');

  const created = await postJson(core, '/api/context-graph/create', {
    id: CG_ID,
    name: `Restart gossip ${STAMP}`,
    description: 'devnet agent-restart-gossip suite graph',
    accessPolicy: 0,
    publishPolicy: 1,
    register: true,
  });
  expect(created.status, `create ${CG_ID}: ${JSON.stringify(created.json)}`).toBeLessThan(300);
  expect(created.json?.registered, `register ${CG_ID}: ${JSON.stringify(created.json)}`).toBe(true);
}, 180_000);

describe('A. a subscribed daemon edge keeps receiving SWM after a process restart (regression)', () => {
  it('receives a core share, is restarted, and receives the next one', async () => {
    const subscribed = await postJson(edge, '/api/context-graph/subscribe', { contextGraphId: CG_ID });
    expect(subscribed.status, `subscribe node${EDGE}: ${JSON.stringify(subscribed.json)}`).toBeLessThan(300);
    await sleep(GOSSIP_GRACE_MS);

    const before = await shareOnCore('daemon-before');
    await waitFor(`node${EDGE} receives ${before}`, RECEIVE_TIMEOUT_MS, 2_000, async () =>
      (await rowsOnDaemon(edge, before)) > 0 ? true : null,
    );

    execFileSync('bash', [DEVNET_SH, 'restart-node', String(EDGE)], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...devnetPortEnv() },
    });
    await waitFor(`node${EDGE} back online`, 120_000, 2_000, async () =>
      (await nodeReachable(edge)) ? true : null,
    );
    await sleep(GOSSIP_GRACE_MS);

    const after = await shareOnCore('daemon-after');
    await waitFor(`restarted node${EDGE} receives ${after}`, RECEIVE_TIMEOUT_MS, 2_000, async () =>
      (await rowsOnDaemon(edge, after)) > 0 ? true : null,
    );
  }, 480_000);
});

describe('B. an SDK agent on the devnet keeps receiving SWM after an in-place stop()/start()', () => {
  let agent: InstanceType<typeof DKGAgent>;
  let swmTopic: string;
  let coreAddr: string;
  const gossipOnAgent: Array<{ topic: string; from: string }> = [];

  const rowsOnAgent = async (subject: string): Promise<number> => {
    const result = await agent.query(
      `SELECT ?p ?o WHERE { <${subject}> ?p ?o }`,
      { contextGraphId: CG_ID, includeSharedMemory: true },
    );
    return result.bindings.length;
  };

  afterAll(async () => {
    await agent?.stop().catch(() => undefined);
  });

  it('subscribes, and receives a core share over gossip', async () => {
    const cfg = JSON.parse(readFileSync(join(core.home, 'config.json'), 'utf8'));
    coreAddr = readFileSync(join(core.home, 'multiaddr'), 'utf8').trim();
    agent = await DKGAgent.create({
      name: `restart-gossip-sdk-${STAMP}`,
      listenHost: '127.0.0.1',
      listenPort: 0,
      nodeRole: 'edge',
      chainAdapter: new EVMChainAdapter({
        rpcUrl: cfg.chain.rpcUrl,
        hubAddress: cfg.chain.hubAddress,
        chainId: cfg.chain.chainId,
        privateKey: `0x${randomBytes(32).toString('hex')}`,
      }),
      // No catch-up on connect or by timer: after the one explicit sync below,
      // a write can only reach this agent through gossip.
      syncOnConnectEnabled: false,
      syncReconcilerEnabled: false,
    });
    await agent.start();
    agent.eventBus.on(DKGEvent.GOSSIP_MESSAGE, (evt) => {
      const { topic, from } = evt as { topic: string; from: string };
      gossipOnAgent.push({ topic, from });
    });
    await agent.connectTo(coreAddr);

    agent.subscribeToContextGraph(CG_ID);
    await agent.syncContextGraphFromConnectedPeers(CG_ID, { includeSharedMemory: true });
    swmTopic = contextGraphSharedMemoryTopic(
      (agent as unknown as { gossipWireIdFor(id: string): string }).gossipWireIdFor(CG_ID),
    );
    await waitFor('the SDK agent joins the SWM topic', 60_000, 500, async () =>
      agent.gossip.subscribedTopics.includes(swmTopic) ? true : null,
    );
    await sleep(GOSSIP_GRACE_MS);

    const before = await shareOnCore('sdk-before');
    await waitFor(`the SDK agent receives ${before}`, RECEIVE_TIMEOUT_MS, 1_000, async () =>
      (await rowsOnAgent(before)) > 0 ? true : null,
    );
    expect(gossipOnAgent.some((m) => m.topic === swmTopic)).toBe(true);
  }, 240_000);

  it('after stop() then start() on the same instance, the next core share still arrives over gossip', async () => {
    const managerBeforeRestart = agent.gossip;
    await agent.stop();
    await agent.start();
    expect(agent.gossip).not.toBe(managerBeforeRestart);
    // A new libp2p node: dial the core again. Nothing re-subscribes the graph
    // except the restart itself: no subscribe() call, no sync, no catch-up.
    await agent.connectTo(coreAddr);
    await waitFor('the restarted SDK agent rejoins the SWM topic', 60_000, 500, async () =>
      agent.gossip.subscribedTopics.includes(swmTopic) ? true : null,
    );
    await sleep(GOSSIP_GRACE_MS);
    gossipOnAgent.length = 0;
    const handleSpy = vi.spyOn(
      (agent as unknown as {
        getOrCreateSharedMemoryHandler(): { handle(data: Uint8Array, from: string): Promise<{ applied: boolean }> };
      }).getOrCreateSharedMemoryHandler(),
      'handle',
    );

    const after = await shareOnCore('sdk-after');
    await waitFor(`the restarted SDK agent receives ${after}`, RECEIVE_TIMEOUT_MS, 1_000, async () =>
      (await rowsOnAgent(after)) > 0 ? true : null,
    );
    expect(gossipOnAgent.some((m) => m.topic === swmTopic)).toBe(true);
    const outcomes = await Promise.all(
      handleSpy.mock.results.map((result) => result.value as Promise<{ applied: boolean }>),
    );
    expect(outcomes.some((outcome) => outcome.applied)).toBe(true);
    handleSpy.mockRestore();
  }, 240_000);
});
