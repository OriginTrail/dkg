// SPDX-License-Identifier: Apache-2.0

/**
 * Positive `kaToContextGraph` bindings and known `getContextGraphKaAt`
 * ordinals, answered from the ONE log. Mutable counts and negative bindings
 * stay live because a new block may land after the tick's head observation.
 *
 * Each test below asks the same pair of questions: does the log answer WITHOUT
 * a call when a positive fact is durable, and does the call come back the
 * moment it cannot?
 */

import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import { ChainEventDecoderRegistry } from '../src/chain-index/chain-event-decoders.js';
import {
  createKnowledgeAssetReadModel,
  type KnowledgeAssetReadModel,
} from
  '../src/chain-index/knowledge-asset-read-model.js';
import type { ChainEventLogRow } from '../src/chain-index/chain-event-log.js';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { MemoryChainEventLogStore } from './helpers/chain-event-log.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HUB_ADDRESS = '0x0000000000000000000000000000000000000001';
const SCOPE = 'evm:31337:0xhub';
const CG_STORAGE = `0x${'cd'.repeat(20)}`;
const ROTATED_CG_STORAGE = `0x${'ef'.repeat(20)}`;
const FLOOR = 10;
const SETTLED = 100;
const COVERED_THROUGH = 105;
const FETCHED_AT_MS = 1_700_000_000_000;

const hash = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(32)}`;
const addr = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(20)}`;
const cgInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));

function row(name: string, args: readonly unknown[], blockNumber: number, logIndex = 0)
  : ChainEventLogRow {
  const encoded = cgInterface.encodeEventLog(cgInterface.getEvent(name)!, [...args]);
  return {
    blockNumber,
    blockHash: hash(blockNumber),
    logIndex,
    transactionHash: hash(0xaa),
    address: CG_STORAGE.toLowerCase(),
    topics: [...encoded.topics],
    data: encoded.data,
    settled: blockNumber <= SETTLED,
  };
}

const creation = (blockNumber: number, contextGraphId: bigint) => row(
  'ContextGraphCreated',
  [contextGraphId, addr(0x11), hash(0x22), [addr(0x11)], 7n, 1, 0, addr(0x44), 7n],
  blockNumber,
);
const registration = (blockNumber: number, contextGraphId: bigint, kaId: bigint, logIndex = 0) =>
  row('KnowledgeAssetRegisteredToContextGraph', [contextGraphId, kaId], blockNumber, logIndex);

function seeded(
  rows: readonly ChainEventLogRow[],
  coveredFromBlock = FLOOR,
  headNumber = COVERED_THROUGH,
  coveredThroughBlock = COVERED_THROUGH,
) {
  const store = new MemoryChainEventLogStore();
  store.seed(SCOPE, {
    cursor: {
      revision: 1,
      lineage: hash(0x01),
      deploymentBlockNumber: FLOOR,
      settledBlockNumber: SETTLED,
      settledBlockHash: hash(SETTLED),
      head: {
        number: headNumber,
        hash: hash(headNumber),
        timestampSeconds: 1_700_000_000,
        fetchedAtMs: FETCHED_AT_MS,
      },
      topicSetVersion: 'v1',
    },
    coverage: ['context-graph-ka', 'context-graph-authority'].map((family) => ({
      family,
      address: CG_STORAGE.toLowerCase(),
      coveredFromBlock,
      coveredThroughBlock,
      floorBlock: FLOOR,
    })),
  }, [...rows]);
  return store;
}

/**
 * One adapter with the log attached and its `eth_call` port counted.
 *
 * `readContract`/`readContractWithOptions` are the two seams every one of
 * these three views reaches the chain through, so a count of zero on them is
 * the whole claim.
 */
function makeAdapter(options: {
  store?: MemoryChainEventLogStore;
  attach?: boolean;
  now?: () => number;
  currentContextGraphStorageAddress?: string;
  knowledgeAssets?: KnowledgeAssetReadModel;
} = {}) {
  const adapter = new EVMChainAdapter({
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    hubAddress: HUB_ADDRESS,
    chainId: 'evm:31337',
    staticNetwork: false,
    allowNoAdminSigner: true,
  } as EVMAdapterConfig);
  const calls: string[] = [];
  const live = new Map<string, bigint>();
  const internals = adapter as unknown as {
    init(): Promise<void>;
    requireContextGraphStorage(): unknown;
    readContract(contract: unknown, label: string, ...args: unknown[]): Promise<unknown>;
    readContractWithOptions(
      contract: unknown, label: string, ...args: unknown[]
    ): Promise<unknown>;
    attachChainEventLog(binding: unknown): void;
  };
  internals.init = async () => undefined;
  internals.requireContextGraphStorage = () => ({
    getAddress: async () => options.currentContextGraphStorageAddress ?? CG_STORAGE,
  });
  internals.readContract = async (_contract, label) => {
    calls.push(label);
    return live.get(label) ?? 0n;
  };
  internals.readContractWithOptions = async (_contract, label) => {
    calls.push(label);
    return live.get(label) ?? 0n;
  };
  if (options.attach !== false && options.store !== undefined) {
    internals.attachChainEventLog(Object.freeze({
      subscription: {},
      contextGraphStorageAddress: CG_STORAGE.toLowerCase(),
      knowledgeAssets: options.knowledgeAssets ?? createKnowledgeAssetReadModel({
        scope: SCOPE,
        store: options.store,
        registry: new ChainEventDecoderRegistry()
          .registerContextGraphAuthority(CG_STORAGE, cgInterface)
          .registerContextGraphKnowledgeAssets(CG_STORAGE, cgInterface),
        contextGraphStorageAddress: CG_STORAGE,
        maxHeadAgeMs: 18_000,
        now: options.now ?? (() => FETCHED_AT_MS),
      }),
    }));
  }
  return {
    adapter,
    calls,
    live,
    replaceKnowledgeAssets(knowledgeAssets: KnowledgeAssetReadModel) {
      internals.attachChainEventLog(Object.freeze({
        subscription: {},
        contextGraphStorageAddress: CG_STORAGE.toLowerCase(),
        knowledgeAssets,
      }));
    },
  };
}

describe('knowledge-asset views over the one log', () => {
  const populated = () => seeded([
    creation(40, 7n),
    registration(50, 7n, 4242n),
    registration(60, 7n, 4343n, 1),
  ]);

  it('answers kaToContextGraph with NO eth_call', async () => {
    const { adapter, calls } = makeAdapter({ store: populated() });

    expect(await adapter.getKAContextGraphId(4242n)).toBe(7n);
    expect(calls).toEqual([]);
  });

  it('keeps the mutable count live but answers every known ordinal locally', async () => {
    const { adapter, calls, live } = makeAdapter({ store: populated() });
    live.set('cgStorage.getContextGraphKaCount', 2n);

    expect(await adapter.getContextGraphKCCount(7n)).toBe(2n);
    expect(await adapter.getContextGraphKCAt(7n, 0n)).toBe(4242n);
    expect(await adapter.getContextGraphKCAt(7n, 1n)).toBe(4343n);
    expect(calls).toEqual(['cgStorage.getContextGraphKaCount']);
  });

  it('leaves an ordinal PAST the list to the chain, which is what reverts on one', async () => {
    // Inventing an out-of-range answer here would replace a revert the callers
    // read with a silent zero.
    const { adapter, calls } = makeAdapter({ store: populated() });

    await adapter.getContextGraphKCAt(7n, 2n);
    expect(calls).toEqual(['cgStorage.getContextGraphKaAt']);
  });

  it('keeps the eth_call while the backfill has not reached the graph creation', async () => {
    // The registrations are held; what is not held is proof that no EARLIER
    // one exists, and an ordinal folded from the middle disagrees with the
    // chain at every position from there on.
    const { adapter, calls, live } = makeAdapter({
      store: seeded([registration(50, 7n, 4242n)], 45),
    });
    live.set('cgStorage.getContextGraphKaAt', 9001n);

    expect(await adapter.getContextGraphKCAt(7n, 0n)).toBe(9001n);
    expect(calls).toEqual(['cgStorage.getContextGraphKaAt']);
  });

  it('keeps the eth_call once the tick has gone quiet', async () => {
    const { adapter, calls, live } = makeAdapter({
      store: populated(),
      now: () => FETCHED_AT_MS + 18_001,
    });
    live.set('cgStorage.kaToContextGraph', 11n);

    expect(await adapter.getKAContextGraphId(4242n)).toBe(11n);
    expect(calls).toEqual(['cgStorage.kaToContextGraph']);
  });

  it('keeps the eth_call on an adapter with no log at all', async () => {
    const { adapter, calls, live } = makeAdapter({ attach: false });
    live.set('cgStorage.kaToContextGraph', 11n);

    expect(await adapter.getKAContextGraphId(4242n)).toBe(11n);
    expect(calls).toEqual(['cgStorage.kaToContextGraph']);
  });

  it('keeps an unbound kaId live even under complete coverage', async () => {
    // A block can land after the tick observed its head, so complete coverage
    // of that head is not proof that an unpinned call still returns zero.
    const complete = makeAdapter({ store: populated() });
    complete.live.set('cgStorage.kaToContextGraph', 8n);
    expect(await complete.adapter.getKAContextGraphId(9999n)).toBe(8n);
    expect(complete.calls).toEqual(['cgStorage.kaToContextGraph']);

    // Incomplete: a zero here would be a claim about blocks nobody looked at.
    const partial = makeAdapter({ store: seeded([registration(50, 7n, 4242n)], 45) });
    partial.live.set('cgStorage.kaToContextGraph', 7n);
    expect(await partial.adapter.getKAContextGraphId(9999n)).toBe(7n);
    expect(partial.calls).toEqual(['cgStorage.kaToContextGraph']);
  });

  it('falls back during bounded catch-up but keeps a known write-once binding local', async () => {
    const catchingUp = seeded(
      [creation(40, 7n), registration(50, 7n, 4242n)],
      FLOOR,
      COVERED_THROUGH + 2_000,
      COVERED_THROUGH,
    );

    const positive = makeAdapter({ store: catchingUp });
    expect(await positive.adapter.getKAContextGraphId(4242n)).toBe(7n);
    expect(positive.calls).toEqual([]);

    const absent = makeAdapter({ store: catchingUp });
    absent.live.set('cgStorage.kaToContextGraph', 9n);
    expect(await absent.adapter.getKAContextGraphId(9999n)).toBe(9n);
    expect(absent.calls).toEqual(['cgStorage.kaToContextGraph']);

    const list = makeAdapter({ store: catchingUp });
    list.live.set('cgStorage.getContextGraphKaAt', 9002n);
    expect(await list.adapter.getContextGraphKCAt(7n, 0n)).toBe(9002n);
    expect(list.calls).toEqual(['cgStorage.getContextGraphKaAt']);
  });

  it('never serves KA views from the ContextGraphStorage the Hub rotated away from', async () => {
    const { adapter, calls, live } = makeAdapter({
      store: populated(),
      currentContextGraphStorageAddress: ROTATED_CG_STORAGE,
    });
    live.set('cgStorage.kaToContextGraph', 11n);
    live.set('cgStorage.getContextGraphKaAt', 9003n);

    expect(await adapter.getKAContextGraphId(4242n)).toBe(11n);
    expect(await adapter.getContextGraphKCAt(7n, 0n)).toBe(9003n);
    expect(calls).toEqual([
      'cgStorage.kaToContextGraph',
      'cgStorage.getContextGraphKaAt',
    ]);
  });

  it('discards a kaToContextGraph answer completed by a retired binding', async () => {
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const mayFinish = new Promise<void>((resolve) => { release = resolve; });
    const oldReadModel: KnowledgeAssetReadModel = {
      async readContextGraphForKa() {
        started();
        await mayFinish;
        return { kind: 'bound', contextGraphId: 7n, asOfBlockNumber: SETTLED };
      },
      async readContextGraphKaList() { return undefined; },
    };
    const currentReadModel: KnowledgeAssetReadModel = {
      async readContextGraphForKa() { return undefined; },
      async readContextGraphKaList() { return undefined; },
    };
    const { adapter, calls, live, replaceKnowledgeAssets } = makeAdapter({
      store: populated(),
      knowledgeAssets: oldReadModel,
    });
    live.set('cgStorage.kaToContextGraph', 11n);

    const pending = adapter.getKAContextGraphId(4242n);
    await didStart;
    replaceKnowledgeAssets(currentReadModel);
    release();

    expect(await pending).toBe(11n);
    expect(calls).toEqual(['cgStorage.kaToContextGraph']);
  });

  it('discards a context-graph ordinal completed by a retired binding', async () => {
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const mayFinish = new Promise<void>((resolve) => { release = resolve; });
    const oldReadModel: KnowledgeAssetReadModel = {
      async readContextGraphForKa() { return undefined; },
      async readContextGraphKaList() {
        started();
        await mayFinish;
        return {
          contextGraphId: 7n,
          kaIds: [4242n],
          throughBlockNumber: COVERED_THROUGH,
        };
      },
    };
    const currentReadModel: KnowledgeAssetReadModel = {
      async readContextGraphForKa() { return undefined; },
      async readContextGraphKaList() { return undefined; },
    };
    const { adapter, calls, live, replaceKnowledgeAssets } = makeAdapter({
      store: populated(),
      knowledgeAssets: oldReadModel,
    });
    live.set('cgStorage.getContextGraphKaAt', 9003n);

    const pending = adapter.getContextGraphKCAt(7n, 0n);
    await didStart;
    replaceKnowledgeAssets(currentReadModel);
    release();

    expect(await pending).toBe(9003n);
    expect(calls).toEqual(['cgStorage.getContextGraphKaAt']);
  });

  it('includes the UNSETTLED tail, because the call it replaces is unpinned', async () => {
    // A registration above the settled cursor: an `eth_call` at the chain head
    // returns it, so reading at the settled cursor instead would be a
    // different — and fifty blocks staler — answer than the one replaced.
    const { adapter, calls, live } = makeAdapter({
      store: seeded([creation(40, 7n), registration(SETTLED + 3, 7n, 4444n)]),
    });

    live.set('cgStorage.getContextGraphKaCount', 1n);
    expect(await adapter.getContextGraphKCCount(7n)).toBe(1n);
    expect(await adapter.getContextGraphKCAt(7n, 0n)).toBe(4444n);
    expect(calls).toEqual(['cgStorage.getContextGraphKaCount']);
  });
});
