import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger, SUBSCRIPTION_SOURCES } from '@origintrail-official/dkg-core';
import { MOCK_DEFAULT_SIGNER, MockChainAdapter } from '@origintrail-official/dkg-chain';

import {
  DKGAgent as RealDKGAgent,
  createInMemoryContextGraphStorageDiscoveryStore,
  type ContextGraphStorageDiscoveryStore,
  type ListContextGraphsRow,
} from '../src/index.js';

type DKGAgent = RealDKGAgent;

/** More blocks than the live `contextGraphDiscovery` lane looks back on a cold start. */
const BEYOND_LIVE_LOOKBACK_BLOCKS = 600;

const cgHash = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(name)).toLowerCase();

interface HistoricalGraph {
  label: string;
  accessPolicy: 0 | 1;
  publishPolicy: 0 | 1;
  nameHash: string | null;
  active: boolean;
}

/** Five graphs covering public/private, open/curated, opted-out and deactivated. */
const HISTORY: HistoricalGraph[] = [
  { label: 'public-open', accessPolicy: 0, publishPolicy: 1, nameHash: cgHash('history-public-open'), active: true },
  { label: 'private-curated', accessPolicy: 1, publishPolicy: 0, nameHash: cgHash('history-private'), active: true },
  { label: 'public-curated', accessPolicy: 0, publishPolicy: 0, nameHash: cgHash('history-public-curated'), active: true },
  { label: 'opted-out', accessPolicy: 0, publishPolicy: 1, nameHash: null, active: true },
  { label: 'deactivated', accessPolicy: 0, publishPolicy: 1, nameHash: cgHash('history-deactivated'), active: false },
];

async function chainWithHistory(): Promise<MockChainAdapter> {
  const chain = new MockChainAdapter();
  // The mock has no chain head, so its live-tail lanes replay from genesis. A
  // real RPC reports one, and the `contextGraphDiscovery` lane then seeds
  // `head - 500` blocks back; give the mock the same head so the lane behaves
  // exactly as on a fresh mainnet node.
  (chain as unknown as { getBlockNumber: () => Promise<number> }).getBlockNumber =
    async () => (chain as unknown as { nextBlock: number }).nextBlock - 1;
  for (const graph of HISTORY) {
    await chain.createOnChainContextGraph({
      accessPolicy: graph.accessPolicy,
      publishPolicy: graph.publishPolicy,
      ...(graph.nameHash ? { nameHash: graph.nameHash } : {}),
    });
  }
  HISTORY.forEach((graph, index) => {
    if (!graph.active) chain.getContextGraph(BigInt(index + 1))!.active = false;
  });
  // The graphs now predate this node's live tail: only enumeration can find them.
  for (let i = 0; i < BEYOND_LIVE_LOOKBACK_BLOCKS; i++) chain.advanceBlock();
  return chain;
}

const agents: DKGAgent[] = [];

async function startAgent(
  chain: MockChainAdapter,
  store: ContextGraphStorageDiscoveryStore,
  name = 'HistoricalDiscovery',
): Promise<DKGAgent> {
  const agent = await RealDKGAgent.create({
    name,
    listenHost: '127.0.0.1',
    nodeRole: 'edge',
    chainAdapter: chain,
    rfc64CatalogActivation: { enabled: false },
    contextGraphStorageDiscoveryStore: store,
  });
  agents.push(agent);
  await agent.start();
  await agent.awaitInitialChainPoll();
  return agent;
}

function chainRows(rows: ListContextGraphsRow[]): ListContextGraphsRow[] {
  return rows
    .filter((row) => row.onChain !== undefined)
    .sort((a, b) => Number(a.onChain!.id) - Number(b.onChain!.id));
}

afterEach(async () => {
  Logger.setSink(null);
  vi.restoreAllMocks();
  while (agents.length > 0) await agents.pop()!.stop().catch(() => {});
});

describe('historical Context Graph discovery through ContextGraphStorage enumeration', () => {
  it('lets a fresh node list every graph that already exists on chain, with readable facts', async () => {
    const chain = await chainWithHistory();
    const agent = await startAgent(chain, createInMemoryContextGraphStorageDiscoveryStore());

    // The live tail alone never sees history: this is the pre-fix behaviour.
    expect(chainRows(await agent.listContextGraphs({ callerAgentAddress: null }))).toEqual([]);

    await expect(agent.discoverContextGraphsFromStorage()).resolves.toBe(5);

    const rows = chainRows(await agent.listContextGraphs({ callerAgentAddress: null }));
    // The opted-out graph has no wire id, so, as on the live lane, it gets no row.
    expect(rows.map((row) => row.onChain!.id)).toEqual(['1', '2', '3', '5']);
    for (const row of rows) {
      const graph = HISTORY[Number(row.onChain!.id) - 1]!;
      expect(row).toMatchObject({
        id: graph.nameHash,
        name: graph.nameHash,
        nameKnown: false,
        onChainId: row.onChain!.id,
        subscribed: false,
        onChain: {
          access: graph.accessPolicy === 0 ? 'public' : 'private',
          publishPolicy: graph.publishPolicy === 0 ? 'curated' : 'open',
          owner: MOCK_DEFAULT_SIGNER,
          active: graph.active,
          nameHash: graph.nameHash,
        },
      });
      expect(row.onChain!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // Chain facts only: nothing from the local store rides along.
      expect(row.description).toBeUndefined();
      expect(row.curator).toBeUndefined();
    }
    // A user can tell private from public at a glance.
    expect(rows.find((row) => row.onChain!.id === '2')!.onChain!.access).toBe('private');
    expect(rows.find((row) => row.onChain!.id === '1')!.onChain!.access).toBe('public');
    expect(rows.find((row) => row.onChain!.id === '5')!.onChain!.active).toBe(false);

    // The same chain-public rows show for a wallet caller and for unscoped callers.
    const walletRows = chainRows(await agent.listContextGraphs({
      callerAgentAddress: ethers.Wallet.createRandom().address,
    }));
    expect(walletRows.map((row) => row.onChain!.id)).toEqual(['1', '2', '3', '5']);
    // Hash-only rows skip caller annotation on every listing path: the node
    // holds no local allowlist or curator for a graph it knows only by hash.
    expect(walletRows.every((row) => row.callerInvolved === undefined)).toBe(true);
    expect(chainRows(await agent.listContextGraphs()).map((row) => row.onChain!.id))
      .toEqual(['1', '2', '3', '5']);

    // A second pass is idempotent.
    await expect(agent.discoverContextGraphsFromStorage()).resolves.toBe(0);
    expect(chainRows(await agent.listContextGraphs({ callerAgentAddress: null }))).toHaveLength(4);
  }, 60_000);

  it('lists hash-only rows in the projection listing mode too', async () => {
    const chain = await chainWithHistory();
    const agent = await startAgent(chain, createInMemoryContextGraphStorageDiscoveryStore());
    await agent.discoverContextGraphsFromStorage();
    vi.stubEnv('DKG_LIST_CONTEXT_GRAPHS_PROJECTION', '1');
    try {
      for (const callerAgentAddress of [null, ethers.Wallet.createRandom().address]) {
        const rows = chainRows(await agent.listContextGraphs({ callerAgentAddress }));
        expect(rows.map((row) => row.onChain!.id)).toEqual(['1', '2', '3', '5']);
        expect(rows.every((row) => row.nameKnown === false && row.name === row.id)).toBe(true);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);

  it('lists discovered rows without adding a single chain read', async () => {
    const chain = await chainWithHistory();
    const agent = await startAgent(chain, createInMemoryContextGraphStorageDiscoveryStore());

    const calls: Array<{ method: string; args: unknown[] }> = [];
    const methods = new Set<string>();
    for (let proto = Object.getPrototypeOf(chain); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);
        if (key !== 'constructor' && typeof descriptor?.value === 'function') methods.add(key);
      }
    }
    for (const key of methods) {
      const original = (chain as any)[key];
      (chain as any)[key] = function (this: unknown, ...args: unknown[]) {
        calls.push({ method: key, args });
        return original.apply(chain, args);
      };
    }
    const wallet = ethers.Wallet.createRandom().address;
    const listTwice = async () => {
      calls.length = 0;
      await agent.listContextGraphs({ callerAgentAddress: null });
      await agent.listContextGraphs({ callerAgentAddress: wallet });
      return calls.map(({ method }) => method);
    };

    // Whatever the listing already reads for the node's own system graphs.
    const baseline = await listTwice();
    await agent.discoverContextGraphsFromStorage();
    const withDiscoveredRows = await listTwice();

    expect(withDiscoveredRows).toEqual(baseline);
    const discovered = new Set(HISTORY.map((graph) => graph.nameHash).filter(Boolean));
    const referencesDiscovered = calls.some(({ args }) => JSON.stringify(args, (_key, value) => (
      typeof value === 'bigint' ? value.toString() : value
    )).split('"').some((token) => discovered.has(token)));
    expect(referencesDiscovered).toBe(false);
  }, 60_000);

  it('resumes from its durable cursor after a restart without re-reading enumerated ids', async () => {
    const chain = await chainWithHistory();
    const store = createInMemoryContextGraphStorageDiscoveryStore();
    const first = await startAgent(chain, store, 'BeforeRestart');
    await first.discoverContextGraphsFromStorage();
    await first.stop();
    agents.splice(agents.indexOf(first), 1);

    // A graph created while the node was down, also beyond the live lookback.
    const lateHash = cgHash('created-while-down');
    await chain.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 0, nameHash: lateHash });
    for (let i = 0; i < BEYOND_LIVE_LOOKBACK_BLOCKS; i++) chain.advanceBlock();

    const reads: Array<[bigint, number]> = [];
    const readRange = chain.readContextGraphStorageRange.bind(chain);
    chain.readContextGraphStorageRange = async (options) => {
      reads.push([options.fromId, options.maxIds]);
      return readRange(options);
    };
    const second = await startAgent(chain, store, 'AfterRestart');

    // Boot re-staged the saved rows from the checkpoint alone.
    expect(reads).toEqual([]);
    expect(chainRows(await second.listContextGraphs({ callerAgentAddress: null })).map((row) => row.onChain!.id))
      .toEqual(['1', '2', '3', '5']);
    // A checkpoint may be days old: it must not seed the authorization caches.
    expect((second as any).onChainAccessPolicyCache.has('2')).toBe(false);
    expect((second as any).onChainPublishPolicyCache.has('2')).toBe(false);

    await expect(second.discoverContextGraphsFromStorage()).resolves.toBe(1);
    expect(reads[0]![0]).toBe(6n);
    expect(reads.every(([fromId]) => fromId >= 6n)).toBe(true);
    const rows = chainRows(await second.listContextGraphs({ callerAgentAddress: null }));
    expect(rows.map((row) => row.onChain!.id)).toEqual(['1', '2', '3', '5', '6']);
    expect(rows.at(-1)).toMatchObject({ id: lateHash, onChain: { access: 'private', publishPolicy: 'curated' } });
    // A fresh read does seed them, exactly as the live event would.
    expect((second as any).onChainAccessPolicyCache.get('6')).toBe(1);
    expect((second as any).onChainPublishPolicyCache.get('6')).toBe(0);
  }, 90_000);

  it('restores the enumerated catalog on the next pass when the boot restore failed', async () => {
    const chain = await chainWithHistory();
    const store = createInMemoryContextGraphStorageDiscoveryStore();
    const first = await startAgent(chain, store, 'BeforeRestart');
    await first.discoverContextGraphsFromStorage();
    await first.stop();
    agents.splice(agents.indexOf(first), 1);

    // The DashboardDB is briefly locked while the node restarts.
    let failures = 1;
    const flaky: ContextGraphStorageDiscoveryStore = {
      load: async () => {
        if (failures-- > 0) throw new Error('sqlite busy');
        return store.load();
      },
      save: (checkpoint) => store.save(checkpoint),
    };
    const reads: bigint[] = [];
    const readRange = chain.readContextGraphStorageRange.bind(chain);
    chain.readContextGraphStorageRange = async (options) => {
      reads.push(options.fromId);
      return readRange(options);
    };
    const second = await startAgent(chain, flaky, 'AfterRestart');
    expect(chainRows(await second.listContextGraphs({ callerAgentAddress: null }))).toEqual([]);

    // The next pass restores the saved rows before resuming at the cursor, so
    // they are back without waiting for a refresh generation or re-reading ids.
    await expect(second.discoverContextGraphsFromStorage()).resolves.toBe(0);
    expect(chainRows(await second.listContextGraphs({ callerAgentAddress: null })).map((row) => row.onChain!.id))
      .toEqual(['1', '2', '3', '5']);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((fromId) => fromId >= 6n)).toBe(true);
    // Restored rows stay chain-old: they seed no authorization cache.
    expect((second as any).onChainAccessPolicyCache.has('2')).toBe(false);
  }, 90_000);

  it('does not duplicate a graph the live lane saw before enumeration reached it', async () => {
    const chain = await chainWithHistory();
    const liveHash = cgHash('created-after-history');
    // Recent enough for the live tail's first poll.
    await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: liveHash });
    const agent = await startAgent(chain, createInMemoryContextGraphStorageDiscoveryStore());

    const live = chainRows(await agent.listContextGraphs({ callerAgentAddress: null }));
    expect(live.map((row) => row.id)).toEqual([liveHash]);
    // The event carries no creation time or active flag.
    expect(live[0]!.onChain).toMatchObject({ id: '6', access: 'public', createdAt: null, active: null });

    // Ids 1..5 are new; id 6 was already known from the live lane.
    await expect(agent.discoverContextGraphsFromStorage()).resolves.toBe(5);
    const rows = chainRows(await agent.listContextGraphs({ callerAgentAddress: null }));
    expect(rows.filter((row) => row.onChain!.id === '6')).toHaveLength(1);
    expect(rows.find((row) => row.onChain!.id === '6')!.onChain).toMatchObject({
      active: true,
      publishPolicy: 'open',
    });
    expect(rows.find((row) => row.onChain!.id === '6')!.onChain!.createdAt).toMatch(/^\d{4}-/);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  }, 60_000);

  it('says once that the archived ContextGraphNameRegistry is absent instead of scanning in silence', async () => {
    const logs: Array<{ level: string; message: string }> = [];
    Logger.setSink((record) => logs.push(record));
    const chain = await chainWithHistory();
    const agent = await startAgent(chain, createInMemoryContextGraphStorageDiscoveryStore());

    await expect(agent.hasContextGraphNameRegistry()).resolves.toBe(false);
    await expect(agent.hasContextGraphNameRegistry()).resolves.toBe(false);
    await expect(agent.discoverContextGraphsFromChain({ mode: 'seedLiveTail', pageBudget: 30 })).resolves.toBe(0);

    const notices = logs.filter((record) => /ContextGraphNameRegistry is not registered in the Hub/.test(record.message));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.level).toBe('info');
  }, 60_000);

  it('keeps the registry lanes for adapters that cannot tell', async () => {
    const chain = await chainWithHistory();
    (chain as any).hasContextGraphNameRegistry = undefined;
    const agent = await startAgent(chain, createInMemoryContextGraphStorageDiscoveryStore());
    await expect(agent.hasContextGraphNameRegistry()).resolves.toBe(true);
  }, 60_000);

  it('refreshes mutable facts so a later deactivation shows in the list', async () => {
    const chain = await chainWithHistory();
    const agent = await startAgent(chain, createInMemoryContextGraphStorageDiscoveryStore());
    const nudges = vi.spyOn(agent as any, 'reconcileSwmHostModeSubscription');
    await agent.discoverContextGraphsFromStorage();
    // Enumeration nudges host mode for the one curated graph it first finds,
    // by its hash-only row, exactly as the live event would have.
    expect(nudges.mock.calls).toEqual([[HISTORY[1]!.nameHash, SUBSCRIPTION_SOURCES.CHAIN_EVENT]]);
    nudges.mockClear();

    // Not due yet: the catalog is fresh as of the first pass.
    await expect(agent.refreshContextGraphsFromStorage()).resolves.toBe(0);

    chain.getContextGraph(1n)!.active = false;
    await expect(agent.refreshContextGraphsFromStorage({ minimumIntervalMs: 0 })).resolves.toBe(1);
    const row = chainRows(await agent.listContextGraphs({ callerAgentAddress: null }))
      .find((candidate) => candidate.onChain!.id === '1');
    expect(row!.onChain!.active).toBe(false);
    // Host mode is nudged once per graph, not on every refresh.
    expect(nudges).not.toHaveBeenCalled();
  }, 60_000);

  it('keeps the publish authority a storage read saw when the same block\'s event lands after it', async () => {
    const chain = await chainWithHistory();
    const agent = await startAgent(chain, createInMemoryContextGraphStorageDiscoveryStore());
    await agent.discoverContextGraphsFromStorage();
    const onChainOf = async (id: string) => chainRows(await agent.listContextGraphs({ callerAgentAddress: null }))
      .find((row) => row.onChain!.id === id)!.onChain!;
    const read = await onChainOf('3');
    expect(read).toMatchObject({
      publishPolicy: 'curated',
      publishAuthority: MOCK_DEFAULT_SIGNER.toLowerCase(),
    });

    // With finalityConfirmations = 0 the read anchors at the minting block, and
    // the poller then applies (or, after a restart, replays) that block's
    // event, which carries the publish policy but never the authority.
    agent.applyOnChainContextGraphObservation({
      contextGraphId: '3',
      owner: MOCK_DEFAULT_SIGNER,
      accessPolicy: 0,
      publishPolicy: 0,
      nameHash: HISTORY[2]!.nameHash,
      observedAtBlock: read.observedAtBlock,
    }, { source: 'event' });

    expect(await onChainOf('3')).toEqual(read);
  }, 60_000);

  it('retires the hash-only row of a slot a reorg replaced', async () => {
    const chain = await chainWithHistory();
    const agent = await startAgent(chain, createInMemoryContextGraphStorageDiscoveryStore());
    await agent.discoverContextGraphsFromStorage();
    const replacement = cgHash('reorged-in');
    const before = chainRows(await agent.listContextGraphs({ callerAgentAddress: null }))
      .find((row) => row.onChain!.id === '1')!;

    // An older observation of a different identity is ignored.
    expect(agent.applyOnChainContextGraphObservation({
      contextGraphId: '1',
      accessPolicy: 0,
      nameHash: replacement,
      observedAtBlock: 1,
    }, { source: 'event' })).toEqual({ isNew: false, changed: false });

    const newer = before.onChain!.observedAtBlock + 1;
    agent.applyOnChainContextGraphObservation({
      contextGraphId: '1',
      owner: MOCK_DEFAULT_SIGNER,
      accessPolicy: 0,
      publishPolicy: 1,
      nameHash: replacement,
      observedAtBlock: newer,
      createdAt: 1_790_000_000,
      active: true,
    }, { source: 'storage' });

    const rows = chainRows(await agent.listContextGraphs({ callerAgentAddress: null }));
    expect(rows.filter((row) => row.onChain!.id === '1').map((row) => row.id)).toEqual([replacement]);
    expect(rows.some((row) => row.id === before.id)).toBe(false);
  }, 60_000);

  it('degrades to no-ops when the adapter cannot enumerate storage', async () => {
    const chain = await chainWithHistory();
    (chain as any).readContextGraphStorageRange = undefined;
    const agent = await startAgent(chain, createInMemoryContextGraphStorageDiscoveryStore());
    await expect(agent.discoverContextGraphsFromStorage()).resolves.toBe(0);
    await expect(agent.refreshContextGraphsFromStorage()).resolves.toBe(0);
    await expect(agent.hydrateContextGraphsFromStorageCheckpoint()).resolves.toBe(0);
  }, 60_000);

  it('starts even when the durable checkpoint cannot be read', async () => {
    const logs: Array<{ level: string; message: string }> = [];
    Logger.setSink((record) => logs.push(record));
    const chain = await chainWithHistory();
    // start() resolves; only the restore is skipped.
    await startAgent(chain, {
      load: async () => { throw new Error('sqlite busy'); },
      save: async () => {},
    });
    expect(logs.some((record) => record.level === 'warn'
      && /Could not restore the Context Graph storage discovery checkpoint: sqlite busy/.test(record.message)))
      .toBe(true);
  }, 60_000);
});
