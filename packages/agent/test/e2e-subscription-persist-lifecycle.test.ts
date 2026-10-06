/**
 * E2E: shutdown and restart of context-graph subscription persistence with
 * REAL components: two real DKGAgents over real libp2p, a real Hardhat chain,
 * and a real on-disk subscription and membership store whose writes take real
 * time (a slow disk).
 *
 * What only real components can show:
 *  - `stop()` waits for subscription writes that are still in flight against a
 *    slow store, so the files on disk are final when `stop()` resolves (a write
 *    used to be abandoned mid-flight while the node tore down around it).
 *  - A curated-join approval, which writes membership and, from inside that
 *    write, subscription state on a different key, persists both halves during
 *    a `stop()` that lands while the slow store is mid-write.
 *  - The same agent restarts with subscription admission reopened, and a fresh
 *    agent on the same stores rehydrates exactly the durable subscriptions.
 *  - A core-host recording that a real chain read has paused when `stop()` begins
 *    still writes its host row: recordings retire before subscription admission
 *    closes, so the row is on disk when `stop()` returns.
 *
 * Structure: three scenarios, each one `it` that runs a sequence of named phases
 * over agents, stores and context-graph ids it creates itself and tears down in
 * its own `finally`. Each can be selected by its name (`vitest -t`), in any order,
 * and a failure in one leaves nothing behind that the others read:
 *  1. a join approval whose subscription write is in flight when `stop()` lands
 *     (boot a joiner node, request the join, approve it and stop mid-write,
 *     check both halves on disk);
 *  2. one workflow on one set of stores (churn and `stop()`, restart the same
 *     agent and `stop()` again, then a fresh agent rehydrates the stores). The
 *     phases are sequential by nature, so they are one test and the order is in
 *     the code;
 *  3. a core-host recording paused on a chain read while `stop()` runs.
 * Only infrastructure is shared between scenarios: the Hardhat snapshot with its
 * minted balance, and the curator node that every connected agent dials. No
 * scenario reads what another one wrote: each hosts its own context graph on the
 * curator under an id of its own, and stops every agent it started. A scenario
 * that broke the curator itself would fail the ones after it; none does.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { TEST_SNAPSHOT_CONFIG } from '../../../scripts/testing/snapshot-storage.js';
import { installHardhatACKProvider } from './_helpers/v10-acks.js';
import { DKGAgent } from '../src/index.js';
import type {
  ContextGraphMembershipRecord,
  ContextGraphMembershipStore,
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionStore,
} from '../src/index.js';
import {
  createEVMAdapter,
  getSharedContext,
  createProvider,
  takeSnapshot,
  revertSnapshot,
  HARDHAT_KEYS,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';

const CG = 'subscription-persist-join-e2e';
const HOSTED_ID = 'e2e-subpersist-core-host';
const WRITE_DELAY_MS = 60;
/** The one write after a restart is slower than the rest of stop() (well under the 5 s drain budget). */
const RESTART_WRITE_DELAY_MS = 1_000;

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function makeSharedChainConfig() {
  const { rpcUrl, hubAddress } = getSharedContext();
  return {
    rpcUrl,
    hubAddress,
    operationalKeys: [HARDHAT_KEYS.CORE_OP],
    chainId: 'evm:31337',
  };
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 20_000,
  stepMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!pred(last) && Date.now() < deadline) {
    await sleep(stepMs);
    last = await fn();
  }
  return last;
}

/** JSON-file rows written atomically (tmp + rename) after a real delay per write. */
class SlowFileRows<T extends { }> {
  inFlight = 0;
  started = 0;
  completed = 0;
  onWriteStarted: (() => void) | undefined;

  /** `delayMs` can be raised for a while, to be certain a write is still in flight when a test acts. */
  constructor(readonly dir: string, public delayMs: number) {}

  private path(key: string): string {
    return join(this.dir, `${encodeURIComponent(key)}.json`);
  }

  async put(key: string, row: T): Promise<void> {
    await this.slow(async () => {
      const file = this.path(key);
      await writeFile(`${file}.tmp`, JSON.stringify(row));
      await rename(`${file}.tmp`, file);
    });
  }

  async remove(key: string): Promise<void> {
    await this.slow(() => rm(this.path(key), { force: true }));
  }

  async readAll(): Promise<T[]> {
    const names = (await readdir(this.dir)).filter((name) => name.endsWith('.json'));
    return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(this.dir, name), 'utf8')) as T));
  }

  private async slow(work: () => Promise<void>): Promise<void> {
    this.inFlight += 1;
    this.started += 1;
    this.onWriteStarted?.();
    try {
      await sleep(this.delayMs);
      await work();
    } finally {
      this.inFlight -= 1;
      this.completed += 1;
    }
  }
}

type MembershipRow = ContextGraphMembershipRecord & { firstSeenAt?: number; updatedAt: number };

async function createSlowStores(root: string) {
  const subscriptionDir = join(root, 'subscriptions');
  const membershipDir = join(root, 'memberships');
  await mkdir(subscriptionDir, { recursive: true });
  await mkdir(membershipDir, { recursive: true });
  const subscriptions = new SlowFileRows<ContextGraphSubscriptionRecord>(subscriptionDir, WRITE_DELAY_MS);
  const memberships = new SlowFileRows<MembershipRow>(membershipDir, WRITE_DELAY_MS);
  const memberKey = (cg: string, type: string, principal: string) => `${cg}|${type}|${principal}`;
  const subscriptionStore: ContextGraphSubscriptionStore = {
    loadAll: () => subscriptions.readAll(),
    save: (record) => subscriptions.put(record.id, { ...record }),
    delete: (id) => subscriptions.remove(id),
  };
  const membershipStore: ContextGraphMembershipStore = {
    loadAll: () => memberships.readAll(),
    upsert: (record) => memberships.put(
      memberKey(record.contextGraphId, record.principalType, record.principalId),
      { ...record },
    ),
    delete: (cg, type, principal) => memberships.remove(memberKey(cg, type, principal)),
  };
  return { subscriptions, memberships, subscriptionStore, membershipStore };
}

type SlowStores = Awaited<ReturnType<typeof createSlowStores>>;

const sharedChain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);

/**
 * Everything one scenario creates and has to tear down: agents (stopped in the
 * reverse order they were created) and temp dirs (removed). `dispose()` is
 * idempotent and never throws, so a scenario that failed midway still cleans up
 * after itself, and `afterAll` can dispose a scope whose own `finally` never ran.
 */
class Scope {
  private readonly agents: DKGAgent[] = [];
  private readonly dirs: string[] = [];

  agent(agent: DKGAgent): DKGAgent {
    this.agents.push(agent);
    return agent;
  }

  async tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    this.dirs.push(dir);
    return dir;
  }

  async dispose(): Promise<void> {
    for (const agent of this.agents.splice(0).reverse()) {
      try { await agent.stop(); } catch { /* ignore */ }
    }
    await Promise.all(this.dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
  }
}

// ---- shared phases: an edge agent on slow stores, connected to the curator ----

interface EdgeOptions {
  name: string;
  stores: SlowStores;
  /** Omit for an in-memory triple store, so the same object can be stopped and started again. */
  dataDir?: string;
}

async function createEdgeAgent(scope: Scope, options: EdgeOptions): Promise<DKGAgent> {
  return scope.agent(await DKGAgent.create({
    ...TEST_SNAPSHOT_CONFIG,
    kaNumberAllocator: makeTestKaNumberAllocator(),
    name: options.name,
    listenPort: 0,
    skills: [],
    chainAdapter: sharedChain,
    nodeRole: 'edge',
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    contextGraphSubscriptionStore: options.stores.subscriptionStore,
    contextGraphMembershipStore: options.stores.membershipStore,
    chainConfig: makeSharedChainConfig(),
  }));
}

/** Start `edge`, connect it to the curator over real libp2p, and check both ends see the link and admission is open. */
async function startAndConnect(edge: DKGAgent, curator: DKGAgent, label: string): Promise<void> {
  await edge.start();
  await sleep(800);
  const curatorAddr = curator.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
  await edge.connectTo(curatorAddr);
  await sleep(1500);
  expect(curator.node.libp2p.getPeers().length, 'curator has no peers').toBeGreaterThanOrEqual(1);
  expect(
    curator.node.libp2p.getPeers().map((peer) => peer.toString()),
    `curator is not connected to ${label}`,
  ).toContain(edge.peerId);
  expect(edge.node.libp2p.getPeers().length, `${label} has no peers`).toBeGreaterThanOrEqual(1);
  expect((edge as any).contextGraphSubscriptionPersistence.status().closed, `${label} admits subscription writes after start`).toBe(false);
}

/** `label` is how the agent is called in assertion messages. */
async function bootEdge(scope: Scope, curator: DKGAgent, label: string, options: EdgeOptions): Promise<DKGAgent> {
  const edge = await createEdgeAgent(scope, options);
  await startAndConnect(edge, curator, label);
  return edge;
}

// ---- scenario 1: a curated-join approval that a stop() lands in the middle of ----

async function bootJoinerNode(scope: Scope, curator: DKGAgent) {
  const nodeDataDir = await scope.tempDir('dkg-e2e-subpersist-node-');
  const stores = await createSlowStores(await scope.tempDir('dkg-e2e-subpersist-stores-'));
  const node = await bootEdge(scope, curator, 'node', { name: 'SubPersistNode', stores, dataDir: nodeDataDir });
  const joinAddr = (await node.registerAgent('subpersist-joiner', { framework: 'test' })).agentAddress;
  expect(joinAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  return { node, stores, joinAddr };
}

/** The curator creates a curated graph; the node's agent asks to join it and the request reaches the curator. */
async function requestJoin(curator: DKGAgent, node: DKGAgent, joinAddr: string): Promise<void> {
  await curator.createContextGraph({ id: CG, name: 'Subscription Persist Join', description: '', accessPolicy: 1 });
  await curator.registerContextGraph(CG);
  expect(await curator.isCuratorOf(CG)).toBe(true);

  const delegation = await node.signJoinRequest(CG, joinAddr);
  const forwarded = await node.forwardJoinRequest(CG, delegation, 'subpersist-joiner', curator.peerId);
  expect(forwarded.delivered, `forward result: ${JSON.stringify(forwarded)}`).toBeGreaterThanOrEqual(1);
  await pollUntil(
    () => curator.listPendingJoinRequests(CG),
    (rows) => rows.some((row: any) => String(row.agentAddress).toLowerCase() === joinAddr.toLowerCase()),
  );
}

async function approveAndStopMidWrite(curator: DKGAgent, node: DKGAgent, stores: SlowStores, joinAddr: string): Promise<void> {
  // Stop the node the moment the approval's subscription row starts writing:
  // by then the membership write that encloses it has begun too.
  let subscriptionWriteStarted!: () => void;
  const subscriptionWriting = new Promise<void>((resolve) => { subscriptionWriteStarted = resolve; });
  const rowsBefore = stores.subscriptions.started;
  stores.subscriptions.onWriteStarted = () => {
    if (stores.subscriptions.started > rowsBefore) subscriptionWriteStarted();
  };
  await curator.approveJoinRequest(CG, joinAddr);
  await Promise.race([
    subscriptionWriting,
    sleep(30_000).then(() => { throw new Error('the approval never reached the node\'s subscription store'); }),
  ]);
  expect(stores.subscriptions.inFlight, 'the write must still be in flight when stop() is called').toBeGreaterThan(0);

  await node.stop();
}

async function expectApprovalDurable(node: DKGAgent, stores: SlowStores, joinAddr: string): Promise<void> {
  // Nothing is left mid-write, and both halves of the approval are on disk.
  expect(stores.subscriptions.inFlight).toBe(0);
  expect(stores.memberships.inFlight).toBe(0);
  const subscriptionRows = await stores.subscriptions.readAll();
  const membershipRows = await stores.memberships.readAll();
  expect(subscriptionRows.find((row) => row.id === CG)).toMatchObject({ id: CG, subscribed: true });
  expect(membershipRows.find((row) =>
    row.contextGraphId === CG && String(row.principalId).toLowerCase() === joinAddr.toLowerCase()))
    .toMatchObject({ contextGraphId: CG, status: 'active' });
  expect((node as any).contextGraphSubscriptionPersistence.status()).toEqual({
    closed: true, lanes: 0, active: 0, pending: 0,
  });
}

// ---- scenario 2: one workflow on one set of stores: churn, stop, restart, stop, rehydrate ----

const churnIds = Array.from({ length: 12 }, (_, index) => `e2e-subpersist-churn-${index}`);
const unsubscribed = new Set(churnIds.filter((_, index) => index % 3 === 0 && index !== 0 && index !== 6));
const flipFlopped = new Set([churnIds[0]!, churnIds[6]!]);
const restartId = 'e2e-subpersist-after-restart';

async function bootChurner(scope: Scope, curator: DKGAgent) {
  const churnStores = await createSlowStores(await scope.tempDir('dkg-e2e-subpersist-churn-stores-'));
  // An in-memory triple store (no dataDir), so the same object can be stopped and started again below.
  const churner = await bootEdge(scope, curator, 'churner', { name: 'SubPersistChurner', stores: churnStores });
  const churnerPeerId = churner.peerId; // unreadable once the node has stopped
  return { churner, churnStores, churnerPeerId };
}

/** Subscription churn that is still in flight against the slow store when stop() is called; stop() must drain it. */
async function churnThenStop(churner: DKGAgent, churnStores: SlowStores, churnerPeerId: string): Promise<void> {
  const startedBefore = churnStores.subscriptions.started;
  for (const id of churnIds) churner.subscribeToContextGraph(id);
  for (const [index, id] of churnIds.entries()) {
    if (index % 2 === 0) {
      churner.markContextGraphSubscriptionState(id, { synced: true, sharedMemorySynced: true, metaSynced: true });
    }
  }
  // Unsubscribe every third graph, and flip-flop two of them back on, so the
  // last write per graph is not the first one issued.
  for (const [index, id] of churnIds.entries()) {
    if (index % 3 === 0) churner.unsubscribeFromContextGraph(id);
  }
  for (const id of flipFlopped) churner.subscribeToContextGraph(id);

  // Writes are admitted, and most have not reached the slow store yet, when stop() is called.
  expect(
    (churner as any).contextGraphSubscriptionPersistence.status().lanes,
    'subscription writes must be outstanding when stop() is called',
  ).toBeGreaterThan(0);
  await churner.stop();

  expect(churnStores.subscriptions.inFlight, 'a subscription write was abandoned by stop()').toBe(0);
  expect(churnStores.memberships.inFlight).toBe(0);
  const completedAtStop = {
    subscriptions: churnStores.subscriptions.completed,
    memberships: churnStores.memberships.completed,
  };
  expect(churnStores.subscriptions.started).toBeGreaterThan(startedBefore);

  const rows = new Map((await churnStores.subscriptions.readAll()).map((row) => [row.id, row]));
  for (const [index, id] of churnIds.entries()) {
    if (unsubscribed.has(id)) {
      expect(rows.has(id), `${id} was unsubscribed and must have no durable row`).toBe(false);
      continue;
    }
    expect(rows.get(id), `${id} must have a durable row`).toMatchObject({ id, subscribed: true });
    if (!flipFlopped.has(id)) {
      expect(rows.get(id)!.synced, `${id} synced flag`).toBe(index % 2 === 0);
    }
  }
  const members = await churnStores.memberships.readAll();
  for (const id of churnIds) {
    const row = members.find((member) =>
      member.contextGraphId === id && member.principalType === 'node' && member.principalId === churnerPeerId);
    expect(Boolean(row), `${id} node membership row`).toBe(!unsubscribed.has(id));
  }
  expect((churner as any).contextGraphSubscriptionPersistence.status()).toEqual({
    closed: true, lanes: 0, active: 0, pending: 0,
  });

  // Nothing writes after stop() has returned.
  await sleep(WRITE_DELAY_MS * 3);
  expect(churnStores.subscriptions.completed).toBe(completedAtStop.subscriptions);
  expect(churnStores.memberships.completed).toBe(completedAtStop.memberships);
}

/** The same agent restarts with admission reopened, and stop() drains its first write too. */
async function restartThenStop(churner: DKGAgent, churnStores: SlowStores): Promise<void> {
  await churner.start();
  expect((churner as any).contextGraphSubscriptionPersistence.status().closed, 'the restarted agent admits subscription writes').toBe(false);

  // One write is all there is, and the rest of stop() takes longer than a
  // fast write does, so a stop() that did not wait for it would still look
  // drained. A slow disk for this one write keeps it in flight past that.
  churnStores.subscriptions.delayMs = RESTART_WRITE_DELAY_MS;
  churner.subscribeToContextGraph(restartId);
  expect(
    (churner as any).contextGraphSubscriptionPersistence.status().lanes,
    'the first write after the restart must be outstanding when stop() is called',
  ).toBeGreaterThan(0);
  try {
    await churner.stop();
  } finally {
    churnStores.subscriptions.delayMs = WRITE_DELAY_MS;
  }

  expect(churnStores.subscriptions.inFlight, 'the first write after the restart was abandoned by stop()').toBe(0);
  const rows = new Map((await churnStores.subscriptions.readAll()).map((row) => [row.id, row]));
  expect(rows.get(restartId)).toMatchObject({ id: restartId, subscribed: true });
  // The rows written before the restart are untouched by it.
  for (const id of churnIds.filter((candidate) => !unsubscribed.has(candidate))) {
    expect(rows.get(id), `${id} survives the restart`).toMatchObject({ id, subscribed: true });
  }
}

/** A fresh agent on the same stores rehydrates exactly the durable subscriptions. */
async function rehydrateOnSameStores(scope: Scope, churnStores: SlowStores): Promise<void> {
  const readerDataDir = await scope.tempDir('dkg-e2e-subpersist-reader-');
  const reader = await createEdgeAgent(scope, { name: 'SubPersistReader', stores: churnStores, dataDir: readerDataDir });
  for (const row of await churnStores.subscriptions.readAll()) {
    (reader as any).localContextGraphProvenance.recordLocalCreate(row.id);
  }
  // These ids are not registered on chain; the authority answer is the only
  // thing stubbed. The persistence path under test is fully real.
  vi.spyOn(reader as any, 'resolveLiveOnChainAccessPolicyState').mockResolvedValue({ kind: 'available', accessPolicy: 0 });
  try {
    await reader.start();
    const live = reader.getSubscribedContextGraphs();
    for (const id of churnIds) {
      expect(live.get(id)?.subscribed === true, `${id} rehydrated`).toBe(!unsubscribed.has(id));
    }
    expect(live.get(restartId)?.subscribed, 'the post-restart subscription rehydrated').toBe(true);
    expect((reader as any).contextGraphSubscriptionPersistence.status().closed).toBe(false);
  } finally {
    await reader.stop().catch(() => {});
  }
}

// ---- scenario 3: a core-host recording paused on a chain read when stop() begins ----

async function createHostedGraph(curator: DKGAgent): Promise<string> {
  await curator.createContextGraph({ id: HOSTED_ID, name: 'Subscription Persist Core Host', description: '', accessPolicy: 0 });
  const { onChainId } = await curator.registerContextGraph(HOSTED_ID);
  expect(onChainId).toMatch(/^\d+$/);
  return onChainId;
}

async function bootHost(scope: Scope) {
  const hostStores = await createSlowStores(await scope.tempDir('dkg-e2e-subpersist-host-'));
  // Not connected to the curator: the recording under test needs the chain, not the network,
  // and a peer could sync into these stores while the test asserts they are empty.
  const host = await createEdgeAgent(scope, { name: 'SubPersistCoreHost', stores: hostStores });
  await host.start();
  expect((host as any).contextGraphSubscriptionPersistence.status().closed, 'host admits subscription writes after start').toBe(false);
  return { host, hostStores };
}

/** Pause the recording on its access-policy read, the last step before its strict persist. */
async function pauseRecordingOnPolicyRead(host: DKGAgent, hostStores: SlowStores, onChainId: string) {
  // Let the real chain answer once it is released.
  const internals = host as any;
  const realRead = internals.readCoreHostedPublicCgAccessPolicy.bind(host);
  let readReached!: () => void;
  const reached = new Promise<void>((resolve) => { readReached = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  internals.readCoreHostedPublicCgAccessPolicy = async (id: string) => {
    readReached();
    await released;
    return realRead(id);
  };
  const recording: Promise<string> = internals.awaitTrackedCoreHostRecording(
    internals.recordCoreHostedPublicCg(onChainId, HOSTED_ID, { durable: true, nudge: false }),
  );
  await Promise.race([
    reached,
    sleep(30_000).then(() => { throw new Error('the recording never reached its policy read'); }),
  ]);
  expect(await hostStores.subscriptions.readAll(), 'nothing is durable while the recording is paused').toEqual([]);
  return { recording, release };
}

async function stopWhileRecordingPaused(host: DKGAgent, release: () => void): Promise<void> {
  const internals = host as any;
  const stopping = host.stop();
  expect(
    await pollUntil(async () => internals.coreHostRecordingsClosed === true, (closed) => closed, 10_000, 20),
    'stop() fences new core-host recordings',
  ).toBe(true);
  await sleep(WRITE_DELAY_MS);
  // stop() waits on the tracked recording, and the queue still takes its write.
  expect(internals.contextGraphSubscriptionPersistence.status().closed).toBe(false);
  release();
  await stopping;
}

async function expectHostRowDurable(
  host: DKGAgent,
  hostStores: SlowStores,
  recording: Promise<string>,
  onChainId: string,
): Promise<void> {
  expect(await recording).toBe('recorded');
  expect(hostStores.subscriptions.inFlight).toBe(0);
  const rows = await hostStores.subscriptions.readAll();
  expect(rows.find((row) => row.id === HOSTED_ID)).toMatchObject({
    id: HOSTED_ID,
    coreHosted: true,
    onChainId,
  });
  expect((host as any).contextGraphSubscriptionPersistence.status()).toEqual({
    closed: true, lanes: 0, active: 0, pending: 0,
  });
}

// ---- the suite ----

let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

describe('E2E: subscription persistence across stop and restart (real libp2p, slow on-disk store)', () => {
  /** Owns the curator, the one node every scenario's agents connect to. */
  const suiteScope = new Scope();
  /** Scenario scopes whose own `finally` has not finished, so `afterAll` can still tear them down. */
  const openScopes = new Set<Scope>();
  let curator: DKGAgent;

  beforeAll(async () => {
    const curatorDataDir = await suiteScope.tempDir('dkg-e2e-subpersist-curator-');
    curator = suiteScope.agent(await DKGAgent.create({
      ...TEST_SNAPSHOT_CONFIG,
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'SubPersistCurator',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
      nodeRole: 'core',
      dataDir: curatorDataDir,
      chainConfig: makeSharedChainConfig(),
    }));
    await curator.start();
    await installHardhatACKProvider(curator, sharedChain);
  }, 60_000);

  afterAll(async () => {
    for (const scope of openScopes) await scope.dispose();
    await suiteScope.dispose();
  });

  /** One scenario: a named `it` over a fresh {@link Scope}, torn down by its own `finally` whatever happens. */
  function scenario(name: string, timeoutMs: number, run: (scope: Scope) => Promise<void>): void {
    it(name, async () => {
      const scope = new Scope();
      openScopes.add(scope);
      try {
        await run(scope);
      } finally {
        await scope.dispose();
        openScopes.delete(scope);
      }
    }, timeoutMs);
  }

  scenario('a stop that lands mid-write of a curated-join approval persists membership and subscription together', 150_000, async (scope) => {
    const { node, stores, joinAddr } = await bootJoinerNode(scope, curator);
    await requestJoin(curator, node, joinAddr);
    await approveAndStopMidWrite(curator, node, stores, joinAddr);
    await expectApprovalDurable(node, stores, joinAddr);
  });

  scenario('stop drains a churn of in-flight subscription writes, the restarted agent admits writes again, and a fresh agent rehydrates the durable rows', 270_000, async (scope) => {
    const { churner, churnStores, churnerPeerId } = await bootChurner(scope, curator);
    await churnThenStop(churner, churnStores, churnerPeerId);
    await restartThenStop(churner, churnStores);
    await rehydrateOnSameStores(scope, churnStores);
  });

  scenario('stop lets a core-host recording that is paused on a chain read write its host row first', 90_000, async (scope) => {
    const onChainId = await createHostedGraph(curator);
    const { host, hostStores } = await bootHost(scope);
    const { recording, release } = await pauseRecordingOnPolicyRead(host, hostStores, onChainId);
    try {
      await stopWhileRecordingPaused(host, release);
    } finally {
      // A failed assertion must not leave the recording paused: stop() waits for it.
      release();
    }
    await expectHostRowDurable(host, hostStores, recording, onChainId);
  });
});
