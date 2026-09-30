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
const WRITE_DELAY_MS = 60;

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

  constructor(readonly dir: string, private readonly delayMs: number) {}

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

describe('E2E: subscription persistence across stop() and restart (real libp2p, slow on-disk store)', () => {
  const sharedChain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  let curator: DKGAgent;
  let node: DKGAgent;
  let churner: DKGAgent;
  let stores: Awaited<ReturnType<typeof createSlowStores>>;
  let churnStores: Awaited<ReturnType<typeof createSlowStores>>;
  let joinAddr: string;
  const tempDirs: string[] = [];

  afterAll(async () => {
    try { await curator?.stop(); } catch { /* ignore */ }
    try { await node?.stop(); } catch { /* ignore */ }
    try { await churner?.stop(); } catch { /* ignore */ }
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('boots a curator and an edge node with slow file stores and connects them over libp2p', async () => {
    const curatorDataDir = await mkdtemp(join(tmpdir(), 'dkg-e2e-subpersist-curator-'));
    const nodeDataDir = await mkdtemp(join(tmpdir(), 'dkg-e2e-subpersist-node-'));
    const storeRoot = await mkdtemp(join(tmpdir(), 'dkg-e2e-subpersist-stores-'));
    tempDirs.push(curatorDataDir, nodeDataDir, storeRoot);
    stores = await createSlowStores(storeRoot);

    curator = await DKGAgent.create({
      ...TEST_SNAPSHOT_CONFIG,
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'SubPersistCurator',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
      nodeRole: 'core',
      dataDir: curatorDataDir,
      chainConfig: makeSharedChainConfig(),
    });
    node = await DKGAgent.create({
      ...TEST_SNAPSHOT_CONFIG,
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'SubPersistNode',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
      nodeRole: 'edge',
      dataDir: nodeDataDir,
      contextGraphSubscriptionStore: stores.subscriptionStore,
      contextGraphMembershipStore: stores.membershipStore,
      chainConfig: makeSharedChainConfig(),
    });

    await curator.start();
    await installHardhatACKProvider(curator, sharedChain);
    await node.start();
    await sleep(800);

    const curatorAddr = curator.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await node.connectTo(curatorAddr);
    await sleep(1500);
    expect(curator.node.libp2p.getPeers().length, 'curator has no peers').toBeGreaterThanOrEqual(1);
    expect(node.node.libp2p.getPeers().length, 'node has no peers').toBeGreaterThanOrEqual(1);

    joinAddr = (await node.registerAgent('subpersist-joiner', { framework: 'test' })).agentAddress;
    expect(joinAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect((node as any).contextGraphSubscriptionPersistence.status().closed).toBe(false);
  }, 60_000);

  it('a stop() that lands mid-write of a curated-join approval persists membership and subscription together', async () => {
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
  }, 90_000);

  const churnIds = Array.from({ length: 12 }, (_, index) => `e2e-subpersist-churn-${index}`);
  const unsubscribed = new Set(churnIds.filter((_, index) => index % 3 === 0 && index !== 0 && index !== 6));
  const flipFlopped = new Set([churnIds[0]!, churnIds[6]!]);
  const restartId = 'e2e-subpersist-after-restart';

  it('stop() drains a churn of subscription writes that are still in flight against the slow store', async () => {
    const churnRoot = await mkdtemp(join(tmpdir(), 'dkg-e2e-subpersist-churn-stores-'));
    tempDirs.push(churnRoot);
    churnStores = await createSlowStores(churnRoot);
    // An in-memory triple store, so the same object can be stopped and started again below.
    churner = await DKGAgent.create({
      ...TEST_SNAPSHOT_CONFIG,
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'SubPersistChurner',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
      nodeRole: 'edge',
      contextGraphSubscriptionStore: churnStores.subscriptionStore,
      contextGraphMembershipStore: churnStores.membershipStore,
      chainConfig: makeSharedChainConfig(),
    });
    await churner.start();
    await churner.connectTo(curator.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!);
    await sleep(1000);
    expect(churner.node.libp2p.getPeers().length, 'churner has no peers').toBeGreaterThanOrEqual(1);

    const churnerPeerId = churner.peerId; // unreadable once the node has stopped
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
  }, 90_000);

  it('restarts the same agent with subscription admission reopened, and stop() drains its first write too', async () => {
    await churner.start();
    expect((churner as any).contextGraphSubscriptionPersistence.status().closed).toBe(false);

    churner.subscribeToContextGraph(restartId);
    expect(
      (churner as any).contextGraphSubscriptionPersistence.status().lanes,
      'the first write after the restart must be outstanding when stop() is called',
    ).toBeGreaterThan(0);
    await churner.stop();

    expect(churnStores.subscriptions.inFlight).toBe(0);
    const rows = new Map((await churnStores.subscriptions.readAll()).map((row) => [row.id, row]));
    expect(rows.get(restartId)).toMatchObject({ id: restartId, subscribed: true });
    // The rows written before the restart are untouched by it.
    for (const id of churnIds.filter((candidate) => !unsubscribed.has(candidate))) {
      expect(rows.get(id), `${id} survives the restart`).toMatchObject({ id, subscribed: true });
    }
  }, 90_000);

  it('a fresh agent on the same stores rehydrates exactly the durable subscriptions', async () => {
    const readerDataDir = await mkdtemp(join(tmpdir(), 'dkg-e2e-subpersist-reader-'));
    tempDirs.push(readerDataDir);
    const reader = await DKGAgent.create({
      ...TEST_SNAPSHOT_CONFIG,
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'SubPersistReader',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
      nodeRole: 'edge',
      dataDir: readerDataDir,
      contextGraphSubscriptionStore: churnStores.subscriptionStore,
      contextGraphMembershipStore: churnStores.membershipStore,
      chainConfig: makeSharedChainConfig(),
    });
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
  }, 90_000);
});
