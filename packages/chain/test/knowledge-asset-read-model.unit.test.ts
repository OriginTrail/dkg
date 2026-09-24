// SPDX-License-Identifier: Apache-2.0

/**
 * The stage-4 read model's gates.
 *
 * Every case here is a "may the log answer this?" question, and the fail-closed
 * direction is always `undefined` (= one `eth_call`). The tests that matter most
 * are the ones asserting a REFUSAL: a served answer that should have been a
 * refusal is how a KA ends up bound to no graph or an ordinal is truncated.
 */

import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import {
  ChainEventDecoderRegistry,
} from '../src/chain-index/chain-event-decoders.js';
import { createKnowledgeAssetReadModel } from
  '../src/chain-index/knowledge-asset-read-model.js';
import type { ChainEventLogCoverage, ChainEventLogRow } from
  '../src/chain-index/chain-event-log.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { MemoryChainEventLogStore } from './helpers/chain-event-log.js';

const SCOPE = 'evm:31337:0xhub:0xstorage';
const CG_STORAGE = `0x${'cd'.repeat(20)}`;
const CG_FLOOR = 10;

const hash = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(32)}`;
const author = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(20)}`;

const cgInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));

function registry(): ChainEventDecoderRegistry {
  return new ChainEventDecoderRegistry()
    .registerContextGraphAuthority(CG_STORAGE, cgInterface)
    .registerContextGraphKnowledgeAssets(CG_STORAGE, cgInterface);
}

function row(
  contractInterface: ethers.Interface,
  address: string,
  name: string,
  args: readonly unknown[],
  position: { blockNumber: number; logIndex?: number; settled?: boolean },
): ChainEventLogRow {
  const fragment = contractInterface.getEvent(name);
  if (fragment === null) throw new Error(`ABI is missing ${name}`);
  const encoded = contractInterface.encodeEventLog(fragment, [...args]);
  return {
    blockNumber: position.blockNumber,
    blockHash: hash(position.blockNumber),
    logIndex: position.logIndex ?? 0,
    transactionHash: hash(0xaa),
    address: address.toLowerCase(),
    topics: [...encoded.topics],
    data: encoded.data,
    settled: position.settled ?? true,
  };
}

const registration = (
  blockNumber: number,
  contextGraphId: bigint,
  kaId: bigint,
  extra: { logIndex?: number; settled?: boolean } = {},
): ChainEventLogRow => row(
  cgInterface,
  CG_STORAGE,
  'KnowledgeAssetRegisteredToContextGraph',
  [contextGraphId, kaId],
  { blockNumber, ...extra },
);

/**
 * The graph's own `ContextGraphCreated` — same address, same `topic1`.
 *
 * The read model resolves the ordinal origin from THIS row rather than from a
 * caller's parameter, so a fixture without one is a graph the log genuinely
 * cannot place, and every ordinal read of it must refuse.
 */
const creation = (
  blockNumber: number,
  contextGraphId: bigint,
  extra: { logIndex?: number; settled?: boolean } = {},
): ChainEventLogRow => row(
  cgInterface,
  CG_STORAGE,
  'ContextGraphCreated',
  [contextGraphId, author(0x11), hash(0x22), [author(0x11)], 7n, 1, 0, author(0x44), 7n],
  { blockNumber, ...extra },
);

interface SeedOptions {
  readonly cgCoverage?: Partial<ChainEventLogCoverage>;
  readonly authorityCoverage?: Partial<ChainEventLogCoverage>;
  readonly settledBlockNumber?: number;
  readonly headBlockNumber?: number;
  readonly rows?: readonly ChainEventLogRow[];
}

function seeded(options: SeedOptions = {}): MemoryChainEventLogStore {
  const store = new MemoryChainEventLogStore();
  const settledBlockNumber = options.settledBlockNumber ?? 100;
  const headBlockNumber = options.headBlockNumber ?? settledBlockNumber + 5;
  store.seed(SCOPE, {
    cursor: {
      revision: 1,
      lineage: hash(0x01),
      deploymentBlockNumber: CG_FLOOR,
      settledBlockNumber,
      settledBlockHash: hash(settledBlockNumber),
      head: {
        number: headBlockNumber,
        hash: hash(headBlockNumber),
        timestampSeconds: 1_700_000_000,
        fetchedAtMs: 1_700_000_000_000,
      },
      topicSetVersion: 'v1',
    },
    coverage: [
      {
        family: 'context-graph-ka',
        address: CG_STORAGE.toLowerCase(),
        coveredFromBlock: CG_FLOOR,
        coveredThroughBlock: 105,
        floorBlock: CG_FLOOR,
        ...options.cgCoverage,
      },
      {
        // The SECOND family on the same address: where `ContextGraphCreated`
        // lives, and so where the ordinal origin is read from.
        family: 'context-graph-authority',
        address: CG_STORAGE.toLowerCase(),
        coveredFromBlock: CG_FLOOR,
        coveredThroughBlock: 105,
        floorBlock: CG_FLOOR,
        ...options.authorityCoverage,
      },
    ],
  }, options.rows ?? []);
  return store;
}

function model(
  store: MemoryChainEventLogStore,
  liveness: { maxHeadAgeMs?: number; now?: () => number } = {},
) {
  return createKnowledgeAssetReadModel({
    scope: SCOPE,
    store,
    registry: registry(),
    contextGraphStorageAddress: CG_STORAGE,
    ...liveness,
  });
}

/** The head the fixture commits, in the same units the gate measures. */
const SEEDED_FETCHED_AT_MS = 1_700_000_000_000;

describe('knowledge asset read model — the tick is still running', () => {
  it('refuses EVERY read once the tick head read is older than the bound', async () => {
    // Nothing about coverage changed: a chain on which nothing happened and a
    // tick that stopped committing leave exactly the same stored range, and
    // these reads stand in for calls that are never stale.
    const store = seeded({ rows: [registration(50, 7n, 4242n), creation(40, 7n)] });
    const stalled = model(store, {
      maxHeadAgeMs: 18_000,
      now: () => SEEDED_FETCHED_AT_MS + 18_001,
    });

    expect(await stalled.readContextGraphForKa(4242n)).toBeUndefined();
    expect(await stalled.readContextGraphKaList(7n)).toBeUndefined();
  });

  it('answers while the tick is inside the bound', async () => {
    const store = seeded({ rows: [registration(50, 7n, 4242n)] });
    const live = model(store, {
      maxHeadAgeMs: 18_000,
      now: () => SEEDED_FETCHED_AT_MS + 17_999,
    });

    expect(await live.readContextGraphForKa(4242n)).toMatchObject({ kind: 'bound' });
  });

  it('refuses a wall clock that stepped backwards, which proves no age at all', async () => {
    const store = seeded({ rows: [registration(50, 7n, 4242n)] });
    const skewed = model(store, {
      maxHeadAgeMs: 18_000,
      now: () => SEEDED_FETCHED_AT_MS - 1,
    });

    expect(await skewed.readContextGraphForKa(4242n)).toBeUndefined();
  });

  it('refuses while a settled-hash mismatch is held but not yet confirmed', async () => {
    const store = seeded({ rows: [registration(50, 7n, 4242n)] });
    const held = await store.load(SCOPE);
    store.seed(SCOPE, { ...held!, suspectedForkBlockNumber: 99 }, [
      registration(50, 7n, 4242n),
    ]);

    expect(await model(store).readContextGraphForKa(4242n)).toBeUndefined();
  });
});

describe('knowledge asset read model — kaToContextGraph', () => {
  it('serves a positive binding from a settled row', async () => {
    const store = seeded({ rows: [registration(50, 7n, 4242n)] });
    await expect(model(store).readContextGraphForKa(4242n)).resolves.toEqual({
      kind: 'bound',
      contextGraphId: 7n,
      asOfBlockNumber: 100,
    });
  });

  it('decodes only the requested KA even when thousands of other registrations are retained', async () => {
    const kaId = (1n << 200n) + 4242n;
    const target = registration(50, 7n, kaId, { logIndex: 4_000 });
    const store = seeded({
      rows: [
        ...Array.from({ length: 4_000 }, (_, index) => (
          registration(50, 8n, BigInt(index), { logIndex: index })
        )),
        target,
        creation(40, 7n),
      ],
    });
    const decoder = registry();
    const decode = vi.spyOn(decoder, 'decodeContextGraphKaRegistrations');
    const readEvents = vi.spyOn(store, 'readEvents');
    const view = createKnowledgeAssetReadModel({
      scope: SCOPE, store, registry: decoder, contextGraphStorageAddress: CG_STORAGE,
    });

    await expect(view.readContextGraphForKa(kaId)).resolves.toEqual({
      kind: 'bound', contextGraphId: 7n, asOfBlockNumber: 100,
    });
    expect(readEvents).toHaveBeenCalledExactlyOnceWith(SCOPE, {
      fromBlockNumber: CG_FLOOR,
      throughBlockNumber: 100,
      addresses: [CG_STORAGE],
      topic0: [target.topics[0]],
      topic2: [target.topics[2]],
    });
    expect(decode).toHaveBeenCalledExactlyOnceWith([target]);
  });

  it('checks the decoded KA identity when a store returns an unrelated registration', async () => {
    const store = seeded();
    vi.spyOn(store, 'readEvents').mockResolvedValue([registration(50, 7n, 1111n)]);

    await expect(model(store).readContextGraphForKa(4242n)).resolves.toBeUndefined();
  });

  it('keeps the first registration in log order when a KA row was replayed', async () => {
    const store = seeded({ rows: [
      registration(60, 8n, 4242n),
      registration(50, 7n, 4242n),
    ] });
    await expect(model(store).readContextGraphForKa(4242n)).resolves.toMatchObject({
      kind: 'bound', contextGraphId: 7n,
    });
  });

  it.each([0n, (1n << 256n) - 1n])('encodes the complete uint256 topic for KA %s', async (kaId) => {
    const store = seeded({ rows: [registration(50, 7n, kaId)] });
    await expect(model(store).readContextGraphForKa(kaId)).resolves.toMatchObject({
      kind: 'bound', contextGraphId: 7n,
    });
  });

  it.each([-1n, 1n << 256n])('refuses an out-of-range KA %s without reading history', async (kaId) => {
    const store = seeded();
    const readEvents = vi.spyOn(store, 'readEvents');
    await expect(model(store).readContextGraphForKa(kaId)).resolves.toBeUndefined();
    expect(readEvents).not.toHaveBeenCalled();
  });

  it('refuses a ZERO answer while coverage is incomplete', async () => {
    // The backfill has not reached the contract's deploy block, so a
    // registration could still be hiding below `coveredFromBlock`. Serving 0
    // here is the correctness bug the spec calls out by name.
    const store = seeded({
      cgCoverage: { coveredFromBlock: CG_FLOOR + 5 },
      rows: [registration(50, 7n, 4242n)],
    });
    await expect(model(store).readContextGraphForKa(9999n)).resolves.toBeUndefined();
  });

  it('never serves a negative answer, even under complete coverage', async () => {
    const store = seeded({ rows: [registration(50, 7n, 4242n)] });
    await expect(model(store).readContextGraphForKa(9999n)).resolves.toBeUndefined();
  });

  it('refuses mutable and negative answers while a fresh tick is still catching up', async () => {
    const store = seeded({
      headBlockNumber: 2_105,
      rows: [
        creation(40, 7n),
        registration(50, 7n, 4242n),
      ],
    });
    const view = model(store);

    // A real write-once row stays useful even while the range above it is a
    // bounded catch-up gap.
    await expect(view.readContextGraphForKa(4242n, { view: 'latest' })).resolves.toMatchObject({
      kind: 'bound',
      contextGraphId: 7n,
    });
    // Every answer whose truth can change in the unwalked gap falls back.
    await expect(view.readContextGraphForKa(9999n, { view: 'latest' }))
      .resolves.toBeUndefined();
    await expect(view.readContextGraphKaList(7n, { view: 'latest' }))
      .resolves.toBeUndefined();
  });

  it('does not serve a tail-only binding to the finalized view', async () => {
    const store = seeded({ rows: [registration(103, 7n, 4242n, { settled: false })] });
    const answer = await model(store).readContextGraphForKa(4242n);
    expect(answer).toBeUndefined();
  });

  it('ignores an unsettled registration BELOW the settled cursor', async () => {
    const store = seeded({ rows: [registration(80, 7n, 4242n, { settled: false })] });
    await expect(model(store).readContextGraphForKa(4242n)).resolves.toBeUndefined();
  });

  it('serves a tail binding to the latest view', async () => {
    // THE DOCUMENTED EXPOSURE, stated rather than glossed: the module's
    // write-once justification is about a SETTLED row, so a tail row folded
    // into a positive `bound` is an answer a tip reorg could still orphan. It
    // stands because this view replaces an UNPINNED `eth_call` with the same
    // tip exposure — plus up to one tick interval, because the tail is only
    // replaced on the tick's NEXT pass. The `knowledgeAssetsFromLog` comment
    // in evm-adapter-context-graph.ts carries that window.
    const store = seeded({ rows: [registration(103, 7n, 4242n, { settled: false })] });
    await expect(model(store).readContextGraphForKa(4242n, { view: 'latest' })).resolves.toEqual({
      kind: 'bound',
      contextGraphId: 7n,
      asOfBlockNumber: 105,
    });
  });

  it('holds the barrier until the log passes the own write', async () => {
    const store = seeded({ rows: [registration(50, 7n, 4242n)] });
    await expect(model(store).readContextGraphForKa(4242n, {
      ownWrite: { blockNumber: 140, blockHash: hash(140) },
    })).resolves.toBeUndefined();
  });

  it('holds the barrier when the log walked a different lineage (S6)', async () => {
    // The log is PAST block 50 by number, but the hash it holds there is not
    // the one the receipt names, so this node's write is not in the history the
    // log folded. A block-number-only barrier would have dropped here.
    const store = seeded({ rows: [registration(50, 7n, 4242n)] });
    await expect(model(store).readContextGraphForKa(4242n, {
      ownWrite: { blockNumber: 50, blockHash: hash(0xfe) },
    })).resolves.toBeUndefined();
  });

  it('drops the barrier once the log holds that exact block hash', async () => {
    const store = seeded({ rows: [registration(50, 7n, 4242n)] });
    await expect(model(store).readContextGraphForKa(4242n, {
      ownWrite: { blockNumber: 50, blockHash: hash(50) },
    })).resolves.toEqual({ kind: 'bound', contextGraphId: 7n, asOfBlockNumber: 100 });
  });
});

describe('knowledge asset read model — KaCount / KaAt', () => {
  it('returns ordinals in (block, logIndex) order', async () => {
    const store = seeded({
      rows: [
        creation(40, 7n),
        registration(50, 7n, 100n, { logIndex: 3 }),
        registration(50, 7n, 101n, { logIndex: 1 }),
        registration(60, 7n, 102n),
        registration(61, 8n, 999n),
      ],
    });
    const list = await model(store).readContextGraphKaList(7n);
    expect(list?.kaIds).toEqual([101n, 100n, 102n]);
  });

  it('refuses when coverage does not reach the graph creation block', async () => {
    const store = seeded({
      cgCoverage: { coveredFromBlock: 45 },
      rows: [creation(40, 7n), registration(50, 7n, 100n)],
    });
    // The graph was created at 40 and the KA family only holds from 45: an
    // ordinal computed here could be missing the graph's first KAs entirely.
    await expect(model(store).readContextGraphKaList(7n)).resolves.toBeUndefined();
  });

  it('serves an empty list once coverage reaches the creation block', async () => {
    const store = seeded({ rows: [creation(40, 7n), registration(50, 8n, 100n)] });
    const list = await model(store).readContextGraphKaList(7n);
    expect(list?.kaIds).toEqual([]);
  });

  it('never double-counts a replayed registration', async () => {
    const store = seeded({
      rows: [
        creation(40, 7n),
        registration(50, 7n, 100n),
        registration(51, 7n, 100n, { logIndex: 5 }),
        registration(52, 7n, 101n),
      ],
    });
    const list = await model(store).readContextGraphKaList(7n);
    // A duplicate appended would shift 101n from ordinal 1 to ordinal 2 and
    // make every later `getContextGraphKaAt` disagree with the chain.
    expect(list?.kaIds).toEqual([100n, 101n]);
  });

  it('refuses a graph whose creation row the log does not hold', async () => {
    // The registrations are right there and the coverage is complete, so a
    // model that took the origin on trust would answer confidently. Without
    // the creation row nothing proves ordinal 0 is the first row held rather
    // than the first row WALKED.
    const store = seeded({ rows: [registration(50, 7n, 100n), registration(60, 7n, 101n)] });
    await expect(model(store).readContextGraphKaList(7n)).resolves.toBeUndefined();
  });

  it('does not truncate the list when the graph was created earlier than the first row read',
    async () => {
      // This is the caller-supplied-origin defect, stated as an outcome: the
      // graph really starts at 40, and the old signature let a caller pass 100
      // and receive a list beginning at kaId 222.
      const store = seeded({
        rows: [creation(40, 7n), registration(50, 7n, 111n), registration(90, 7n, 222n)],
      });
      const list = await model(store).readContextGraphKaList(7n);
      expect(list?.kaIds).toEqual([111n, 222n]);
    });

  it('refuses rather than serving an empty list when the topic filter matches nothing',
    async () => {
      // A `topic1` encoding that disagreed with what the tick stored would make
      // every filtered read come back empty. The graph's own creation row goes
      // through the SAME filter, so it vanishes too — and an empty list is then
      // refused instead of served as a confident count of zero.
      const store = seeded({
        rows: [
          { ...creation(40, 7n), topics: [creation(40, 7n).topics[0]!, `0x${'ff'.repeat(32)}`] },
          { ...registration(50, 7n, 100n), topics: [
            registration(50, 7n, 100n).topics[0]!,
            `0x${'ff'.repeat(32)}`,
          ] },
        ],
      });
      await expect(model(store).readContextGraphKaList(7n)).resolves.toBeUndefined();
    });

  it('does not take the creation block from an unsettled row in the finalized view', async () => {
    const store = seeded({
      rows: [creation(40, 7n, { settled: false }), registration(50, 7n, 100n)],
    });
    await expect(model(store).readContextGraphKaList(7n)).resolves.toBeUndefined();
  });
});

describe('knowledge asset read model — no log', () => {
  it('refuses every read when the scope has no cursor', async () => {
    const store = new MemoryChainEventLogStore();
    const view = model(store);
    await expect(view.readContextGraphForKa(1n)).resolves.toBeUndefined();
    await expect(view.readContextGraphKaList(1n)).resolves.toBeUndefined();
  });
});
