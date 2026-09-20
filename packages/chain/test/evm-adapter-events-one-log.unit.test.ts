// SPDX-License-Identifier: Apache-2.0

/**
 * The two lanes named in the measurements — `queryFilter_ContextGraphCreated`
 * and `queryFilter_KnowledgeAssetRegisteredToContextGraph` — read the one log.
 *
 * These are the pins that say so: when the log covers the range the lane asked
 * for, NO `queryFilter` is issued; when it does not, the live scan is still
 * there. The all-or-nothing rule is the important one — a partially covered
 * range must fall back rather than return a short answer, because the lane
 * advances its cursor to the bound it asked for either way.
 */

import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import { ChainEventDecoderRegistry } from '../src/chain-index/chain-event-decoders.js';
import { createChainEventLogSubscription } from
  '../src/chain-index/chain-event-log-subscription.js';
import type { ChainEventLogSubscription } from
  '../src/chain-index/chain-event-log-subscription.js';
import type { ChainEventLogRow } from '../src/chain-index/chain-event-log.js';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { MemoryChainEventLogStore } from './helpers/chain-event-log.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const SCOPE = 'evm:31337:0xhub:0xstorage';
const CG_STORAGE = `0x${'cd'.repeat(20)}`.toLowerCase();
const ROTATED_CG_STORAGE = `0x${'ef'.repeat(20)}`.toLowerCase();

const hash = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(32)}`;
const cgInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));

function minimalConfig(): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    adminPrivateKey: ADMIN_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
  };
}

function row(name: string, args: readonly unknown[], blockNumber: number): ChainEventLogRow {
  const fragment = cgInterface.getEvent(name);
  if (fragment === null) throw new Error(`missing ${name}`);
  const encoded = cgInterface.encodeEventLog(fragment, [...args]);
  return {
    blockNumber,
    blockHash: hash(blockNumber),
    logIndex: 0,
    transactionHash: hash(0xaa),
    address: CG_STORAGE,
    topics: [...encoded.topics],
    data: encoded.data,
    settled: true,
  };
}

const creationRow = (blockNumber: number, cgId: bigint) => row('ContextGraphCreated', [
  cgId,
  `0x${'11'.repeat(20)}`,
  `0x${'22'.repeat(32)}`,
  [`0x${'11'.repeat(20)}`],
  `0x${'33'.repeat(32)}`,
  1,
  0,
  `0x${'44'.repeat(20)}`,
  0n,
], blockNumber);

const registrationRow = (blockNumber: number, cgId: bigint, kaId: bigint) =>
  row('KnowledgeAssetRegisteredToContextGraph', [cgId, kaId], blockNumber);

function seededStore(
  coveredThroughBlock: number,
  rows: readonly ChainEventLogRow[],
): MemoryChainEventLogStore {
  const store = new MemoryChainEventLogStore();
  store.seed({
    cursor: {
      revision: 1,
      lineage: hash(1),
      deploymentBlockNumber: 10,
      settledBlockNumber: coveredThroughBlock,
      settledBlockHash: hash(coveredThroughBlock),
      head: {
        number: coveredThroughBlock,
        hash: hash(coveredThroughBlock),
        timestampSeconds: 1_700_000_000,
        fetchedAtMs: 1_700_000_000_000,
      },
      topicSetVersion: 'v1',
    },
    coverage: ['context-graph-authority', 'context-graph-ka'].map((family) => ({
      family,
      address: CG_STORAGE,
      coveredFromBlock: 10,
      coveredThroughBlock,
      floorBlock: 10,
    })),
  }, rows);
  return store;
}

/** The adapter with a stubbed contract handle and a recorded live scan. */
function makeAdapter(
  store: MemoryChainEventLogStore | undefined,
  currentContextGraphStorageAddress = CG_STORAGE,
  subscriptionOverride?: ChainEventLogSubscription,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter: any = new EVMChainAdapter(minimalConfig());
  adapter.initialized = true;
  adapter.init = async () => { adapter.initialized = true; };
  const liveScans: string[] = [];
  adapter.readContractWith = async (_c: unknown, label: string) => {
    liveScans.push(label);
    return [];
  };
  adapter.contracts = {
    contextGraphStorage: {
      interface: cgInterface,
      getAddress: async () => currentContextGraphStorageAddress,
      filters: {
        ContextGraphCreated: () => ({}),
        KnowledgeAssetRegisteredToContextGraph: () => ({}),
      },
    },
  };
  if (store !== undefined) {
    adapter.attachChainEventLog({
      subscription: subscriptionOverride ?? createChainEventLogSubscription({
        scope: SCOPE,
        store,
        registry: new ChainEventDecoderRegistry()
          .registerContextGraphAuthority(CG_STORAGE, cgInterface)
          .registerContextGraphKnowledgeAssets(CG_STORAGE, cgInterface),
      }),
      contextGraphStorageAddress: CG_STORAGE,
    });
  }
  return { adapter, liveScans };
}

async function collect(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter: any,
  eventTypes: readonly string[],
  fromBlock: number,
  toBlock: number,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of adapter.listenForEvents({ eventTypes, fromBlock, toBlock })) {
    out.push(event);
  }
  return out;
}

describe('listenForEvents over the one log', () => {
  it('borrows an event-scan lease only for the exact selected address and topic', async () => {
    const { adapter } = makeAdapter(seededStore(100, []));
    const binding = adapter.chainEventLog!;
    let received: unknown;
    adapter.attachChainEventLog({
      ...binding,
      readEventScanLease: async (identity: unknown) => {
        received = identity;
        return { throughBlockNumber: 100, holds: async () => true };
      },
    });

    const lease = await adapter.acquireEventScanHorizonLease(['ContextGraphCreated']);
    expect(lease?.throughBlockNumber).toBe(100);
    await expect(lease!.holds()).resolves.toBe(true);
    expect(received).toEqual({
      eventType: 'ContextGraphCreated',
      contextGraphStorageAddress: CG_STORAGE,
      topic0: cgInterface.getEvent('ContextGraphCreated')!.topicHash.toLowerCase(),
    });
    adapter.destroy();
  });

  it('refuses sole unsupported and mixed event sets before consulting the log', async () => {
    const { adapter } = makeAdapter(seededStore(100, []));
    const binding = adapter.chainEventLog!;
    let reads = 0;
    adapter.attachChainEventLog({
      ...binding,
      readEventScanLease: async () => {
        reads += 1;
        return { throughBlockNumber: 100, holds: async () => true };
      },
    });

    await expect(adapter.acquireEventScanHorizonLease(['AllowListUpdated']))
      .resolves.toBeUndefined();
    await expect(adapter.acquireEventScanHorizonLease([
      'NameClaimed',
      'ContextGraphCreated',
    ])).resolves.toBeUndefined();
    expect(reads).toBe(0);
    adapter.destroy();
  });

  it('discards an event-scan lease when its binding generation changes in flight', async () => {
    const { adapter } = makeAdapter(seededStore(100, []));
    const base = adapter.chainEventLog!;
    let release = (_lease: { throughBlockNumber: number; holds(): Promise<boolean> }): void => {};
    let markStarted = (): void => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    adapter.attachChainEventLog({
      ...base,
      readEventScanLease: () => new Promise<{
        throughBlockNumber: number;
        holds(): Promise<boolean>;
      }>((resolve) => {
        release = resolve;
        markStarted();
      }),
    });

    const reading = adapter.acquireEventScanHorizonLease(['ContextGraphCreated']);
    await started;
    adapter.attachChainEventLog({
      ...base,
      readEventScanLease: async () => ({
        throughBlockNumber: 101,
        holds: async () => true,
      }),
    });
    release({
      throughBlockNumber: 100,
      holds: async () => true,
    });

    await expect(reading).resolves.toBeUndefined();
    await expect(adapter.acquireEventScanHorizonLease(['ContextGraphCreated']))
      .resolves.toMatchObject({ throughBlockNumber: 101 });
    adapter.destroy();
  });

  it('retires an issued event-scan lease when its binding generation changes', async () => {
    const { adapter } = makeAdapter(seededStore(100, []));
    const base = adapter.chainEventLog!;
    adapter.attachChainEventLog({
      ...base,
      readEventScanLease: async () => ({
        throughBlockNumber: 100,
        holds: async () => true,
      }),
    });
    const lease = await adapter.acquireEventScanHorizonLease([
      'KnowledgeAssetRegisteredToContextGraph',
    ]);
    expect(lease).toBeDefined();

    adapter.attachChainEventLog({ ...base });
    await expect(lease!.holds()).resolves.toBe(false);
    adapter.destroy();
  });

  it('discards an event-scan lease when the contract handle changes in flight', async () => {
    const { adapter } = makeAdapter(seededStore(100, []));
    const base = adapter.chainEventLog!;
    const originalHandle = adapter.contracts.contextGraphStorage;
    let release = (_lease: { throughBlockNumber: number; holds(): Promise<boolean> }): void => {};
    let markStarted = (): void => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    adapter.attachChainEventLog({
      ...base,
      readEventScanLease: () => new Promise<{
        throughBlockNumber: number;
        holds(): Promise<boolean>;
      }>((resolve) => {
        release = resolve;
        markStarted();
      }),
    });

    const reading = adapter.acquireEventScanHorizonLease(['ContextGraphCreated']);
    await started;
    adapter.contracts.contextGraphStorage = { ...originalHandle };
    release({ throughBlockNumber: 100, holds: async () => true });

    await expect(reading).resolves.toBeUndefined();
    adapter.destroy();
  });

  it('serves ContextGraphCreated from the log and issues no queryFilter', async () => {
    const store = seededStore(100, [creationRow(50, 7n), registrationRow(51, 7n, 900n)]);
    const { adapter, liveScans } = makeAdapter(store);
    const events = await collect(adapter, ['ContextGraphCreated'], 10, 100);
    expect(liveScans).toEqual([]);
    expect(events).toHaveLength(1);
    expect((events[0] as { data: { contextGraphId: string } }).data.contextGraphId).toBe('7');
  });

  it('does not leak the other six authority signatures into the lane', async () => {
    // One filter carries seven signatures; this lane subscribed to one of them,
    // and a sibling event arriving as a ContextGraphCreated would be dispatched
    // as a brand-new graph that does not exist.
    const store = seededStore(100, [
      creationRow(50, 7n),
      row('ContextGraphDeactivated', [7n], 55),
      row('AgentParticipantAdded', [7n, `0x${'12'.repeat(20)}`], 56),
    ]);
    const { adapter } = makeAdapter(store);
    const events = await collect(adapter, ['ContextGraphCreated'], 10, 100);
    expect(events).toHaveLength(1);
  });

  it('serves KnowledgeAssetRegisteredToContextGraph from the log', async () => {
    // The creation row shares this address and is deliberately present: the
    // lane must see only its own signature, not everything stored there.
    const store = seededStore(100, [creationRow(50, 7n), registrationRow(60, 7n, 900n)]);
    const { adapter, liveScans } = makeAdapter(store);
    const events = await collect(
      adapter, ['KnowledgeAssetRegisteredToContextGraph'], 10, 100,
    );
    expect(liveScans).toEqual([]);
    expect(events).toHaveLength(1);
    expect((events[0] as { data: { kaId: string } }).data.kaId).toBe('900');
  });

  it('falls back to the live scan when coverage is short of the asked range', async () => {
    // The log holds through 100; the lane asked through 140. Serving the 90
    // blocks it has would let the lane record 140 as scanned.
    const store = seededStore(100, [creationRow(50, 7n)]);
    const { adapter, liveScans } = makeAdapter(store);
    await collect(adapter, ['ContextGraphCreated'], 10, 140);
    expect(liveScans).toEqual(['cgStorage.queryFilter(ContextGraphCreated)']);
  });

  it('falls back when the lane cursor starts below the log floor', async () => {
    const store = seededStore(100, [creationRow(50, 7n)]);
    const { adapter, liveScans } = makeAdapter(store);
    await collect(adapter, ['KnowledgeAssetRegisteredToContextGraph'], 0, 100);
    expect(liveScans).toEqual([
      'cgStorage.queryFilter(KnowledgeAssetRegisteredToContextGraph)',
    ]);
  });

  it('keeps the live scan when no log is attached at all', async () => {
    const { adapter, liveScans } = makeAdapter(undefined);
    await collect(adapter, ['ContextGraphCreated'], 10, 100);
    expect(liveScans).toEqual(['cgStorage.queryFilter(ContextGraphCreated)']);
  });

  it('never serves lanes from the ContextGraphStorage the Hub rotated away from', async () => {
    const store = seededStore(100, [creationRow(50, 7n), registrationRow(60, 7n, 900n)]);
    const { adapter, liveScans } = makeAdapter(store, ROTATED_CG_STORAGE);

    expect(await collect(adapter, ['ContextGraphCreated'], 10, 100)).toEqual([]);
    expect(await collect(
      adapter,
      ['KnowledgeAssetRegisteredToContextGraph'],
      10,
      100,
    )).toEqual([]);
    expect(liveScans).toEqual([
      'cgStorage.queryFilter(ContextGraphCreated)',
      'cgStorage.queryFilter(KnowledgeAssetRegisteredToContextGraph)',
    ]);
  });

  it('discards rows when the binding generation changes while their read is in flight', async () => {
    const store = seededStore(100, [creationRow(50, 7n)]);
    const base = createChainEventLogSubscription({
      scope: SCOPE,
      store,
      registry: new ChainEventDecoderRegistry()
        .registerContextGraphAuthority(CG_STORAGE, cgInterface)
        .registerContextGraphKnowledgeAssets(CG_STORAGE, cgInterface),
    });
    let release = (): void => {};
    let markStarted = (): void => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const delayed: ChainEventLogSubscription = {
      ...base,
      async readRows(range, view) {
        markStarted();
        await new Promise<void>((resolve) => { release = resolve; });
        return base.readRows(range, view);
      },
    };
    const { adapter, liveScans } = makeAdapter(store, CG_STORAGE, delayed);

    const collecting = collect(adapter, ['ContextGraphCreated'], 10, 100);
    await started;
    adapter.attachChainEventLog({
      subscription: base,
      contextGraphStorageAddress: CG_STORAGE,
    });
    release();

    expect(await collecting).toEqual([]);
    expect(liveScans).toEqual(['cgStorage.queryFilter(ContextGraphCreated)']);
    adapter.destroy();
  });
});
