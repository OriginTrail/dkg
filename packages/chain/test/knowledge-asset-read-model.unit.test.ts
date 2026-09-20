// SPDX-License-Identifier: Apache-2.0

/**
 * The stage-4 read model's gates.
 *
 * Every case here is a "may the log answer this?" question, and the fail-closed
 * direction is always `undefined` (= one `eth_call`). The tests that matter most
 * are the ones asserting a REFUSAL: a served answer that should have been a
 * refusal is how a KA ends up bound to no graph, or verified against version 0
 * of a version-3 asset.
 */

import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

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
const KA_STORAGE = `0x${'ab'.repeat(20)}`;
const CG_FLOOR = 10;
const KA_FLOOR = 12;

const hash = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(32)}`;
const root = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(32)}`;
const author = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(20)}`;

const cgInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));
const kaInterface = new ethers.Interface(loadAbi('DKGKnowledgeAssets'));

function registry(): ChainEventDecoderRegistry {
  return new ChainEventDecoderRegistry()
    .registerContextGraphAuthority(CG_STORAGE, cgInterface)
    .registerContextGraphKnowledgeAssets(CG_STORAGE, cgInterface)
    .registerKnowledgeAssets(KA_STORAGE, kaInterface);
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

const created = (
  blockNumber: number,
  kaId: bigint,
  merkleRoot: string,
  authorAddress = author(0x11),
  extra: { logIndex?: number; settled?: boolean } = {},
): ChainEventLogRow => row(
  kaInterface,
  KA_STORAGE,
  'KnowledgeAssetCreated',
  [kaId, authorAddress, 'op-1', merkleRoot, 128n, 1n, 2n, 0n, false],
  { blockNumber, ...extra },
);

const updated = (
  blockNumber: number,
  kaId: bigint,
  merkleRoot: string,
  authorAddress = author(0x11),
  extra: { logIndex?: number; settled?: boolean } = {},
): ChainEventLogRow => row(
  kaInterface,
  KA_STORAGE,
  'KnowledgeAssetUpdated',
  [kaId, authorAddress, 'op-2', merkleRoot, 256n, 0n],
  { blockNumber, ...extra },
);

/** `KnowledgeAssetMerkleRootAdded(uint256 indexed id, bytes32 merkleRoot)`. */
const rootAdded = (
  blockNumber: number,
  kaId: bigint,
  merkleRoot: string,
  extra: { logIndex?: number; settled?: boolean } = {},
): ChainEventLogRow => row(
  kaInterface,
  KA_STORAGE,
  'KnowledgeAssetMerkleRootAdded',
  [kaId, merkleRoot],
  { blockNumber, ...extra },
);

/** `…MerkleRootRemoved` names the root it REMOVES, not the one it exposes. */
const rootRemoved = (
  blockNumber: number,
  kaId: bigint,
  merkleRoot: string,
  extra: { logIndex?: number; settled?: boolean } = {},
): ChainEventLogRow => row(
  kaInterface,
  KA_STORAGE,
  'KnowledgeAssetMerkleRootRemoved',
  [kaId, merkleRoot],
  { blockNumber, ...extra },
);

/** Whole-stack replacement: `MerkleRoot[]` of (publisher, merkleRoot, timestamp). */
const rootsUpdated = (
  blockNumber: number,
  kaId: bigint,
  roots: readonly string[],
  extra: { logIndex?: number; settled?: boolean } = {},
): ChainEventLogRow => row(
  kaInterface,
  KA_STORAGE,
  'KnowledgeAssetMerkleRootsUpdated',
  [kaId, roots.map((merkleRoot) => [author(0x55), merkleRoot, 1_700_000_000n])],
  { blockNumber, ...extra },
);

interface SeedOptions {
  readonly cgCoverage?: Partial<ChainEventLogCoverage>;
  readonly authorityCoverage?: Partial<ChainEventLogCoverage>;
  readonly kaCoverage?: Partial<ChainEventLogCoverage>;
  readonly settledBlockNumber?: number;
  readonly rows?: readonly ChainEventLogRow[];
}

function seeded(options: SeedOptions = {}): MemoryChainEventLogStore {
  const store = new MemoryChainEventLogStore();
  const settledBlockNumber = options.settledBlockNumber ?? 100;
  store.seed({
    cursor: {
      revision: 1,
      lineage: hash(0x01),
      deploymentBlockNumber: CG_FLOOR,
      settledBlockNumber,
      settledBlockHash: hash(settledBlockNumber),
      head: {
        number: settledBlockNumber + 5,
        hash: hash(settledBlockNumber + 5),
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
      {
        family: 'knowledge-asset',
        address: KA_STORAGE.toLowerCase(),
        coveredFromBlock: KA_FLOOR,
        coveredThroughBlock: 105,
        floorBlock: KA_FLOOR,
        ...options.kaCoverage,
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
    knowledgeAssetStorageAddress: KA_STORAGE,
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
    expect(await stalled.readLatestMerkleRoot(4242n)).toBeUndefined();
    expect(await stalled.readMaxKaNumberForAuthor(author(0x11))).toBeUndefined();
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
    store.seed({ ...held!, suspectedForkBlockNumber: 99 }, [registration(50, 7n, 4242n)]);

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

  it('serves a ZERO answer only under complete coverage', async () => {
    const store = seeded({ rows: [registration(50, 7n, 4242n)] });
    await expect(model(store).readContextGraphForKa(9999n)).resolves.toEqual({
      kind: 'unbound',
      asOfBlockNumber: 100,
    });
  });

  it('does not serve a tail-only binding to the finalized view', async () => {
    const store = seeded({ rows: [registration(103, 7n, 4242n, { settled: false })] });
    const answer = await model(store).readContextGraphForKa(4242n);
    // Complete coverage still applies, so the honest finalized answer is
    // "not bound yet" — never the unsettled binding.
    expect(answer).toEqual({ kind: 'unbound', asOfBlockNumber: 100 });
  });

  it('ignores an unsettled registration BELOW the settled cursor', async () => {
    const store = seeded({ rows: [registration(80, 7n, 4242n, { settled: false })] });
    await expect(model(store).readContextGraphForKa(4242n)).resolves.toEqual({
      kind: 'unbound',
      asOfBlockNumber: 100,
    });
  });

  it('serves a tail binding to the latest view', async () => {
    const store = seeded({ rows: [registration(103, 7n, 4242n, { settled: false })] });
    await expect(model(store).readContextGraphForKa(4242n, { view: 'latest' })).resolves.toEqual({
      kind: 'bound',
      contextGraphId: 7n,
      asOfBlockNumber: 105,
    });
  });

  it('holds the barrier until the log passes the own write', async () => {
    const store = seeded({ rows: [registration(50, 7n, 4242n)] });
    await expect(model(store).readContextGraphForKa(9999n, {
      ownWrite: { blockNumber: 140, blockHash: hash(140) },
    })).resolves.toBeUndefined();
  });

  it('holds the barrier when the log walked a different lineage (S6)', async () => {
    // The log is PAST block 50 by number, but the hash it holds there is not
    // the one the receipt names, so this node's write is not in the history the
    // log folded. A block-number-only barrier would have dropped here.
    const store = seeded({ rows: [registration(50, 7n, 4242n)] });
    await expect(model(store).readContextGraphForKa(9999n, {
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

describe('knowledge asset read model — latest merkle root', () => {
  it('serves root and rootIndex from a complete stack', async () => {
    const store = seeded({
      rows: [created(30, 55n, root(0xa1)), updated(40, 55n, root(0xa2))],
    });
    await expect(model(store).readLatestMerkleRoot(55n)).resolves.toEqual({
      merkleRoot: root(0xa2),
      rootIndex: 1,
      author: author(0x11),
    });
  });

  it('refuses a stack whose creation event was never walked', async () => {
    // Only the update is held. The top root is right and `rootIndex` would be
    // 0 for what is really version 1 — a verifier comparing versions would
    // reject valid content.
    const store = seeded({ rows: [updated(40, 55n, root(0xa2))] });
    await expect(model(store).readLatestMerkleRoot(55n)).resolves.toBeUndefined();
  });

  it('refuses a KA the log holds nothing for', async () => {
    const store = seeded({ rows: [created(30, 55n, root(0xa1))] });
    await expect(model(store).readLatestMerkleRoot(77n)).resolves.toBeUndefined();
  });

  it('ignores an unsettled row that sits BELOW the settled cursor', async () => {
    // Capping the window at the cursor is not the same guard as reading only
    // settled rows. A row the store still carries as tail while the cursor has
    // moved past its height is inside the window and must STILL be refused:
    // `settled` is the flag that says the row survived the reorg tail, and
    // promoting a root is exactly the thing that must not be undone.
    const store = seeded({
      rows: [
        created(30, 55n, root(0xa1)),
        updated(80, 55n, root(0xa2), author(0x11), { settled: false }),
      ],
    });
    await expect(model(store).readLatestMerkleRoot(55n)).resolves.toEqual({
      merkleRoot: root(0xa1),
      rootIndex: 0,
      author: author(0x11),
    });
  });

  it('does not promote an unsettled root into the finalized view', async () => {
    const store = seeded({
      rows: [
        created(30, 55n, root(0xa1)),
        updated(103, 55n, root(0xa2), author(0x11), { settled: false }),
      ],
    });
    await expect(model(store).readLatestMerkleRoot(55n)).resolves.toEqual({
      merkleRoot: root(0xa1),
      rootIndex: 0,
      author: author(0x11),
    });
    await expect(model(store).readLatestMerkleRoot(55n, { view: 'latest' })).resolves.toEqual({
      merkleRoot: root(0xa2),
      rootIndex: 1,
      author: author(0x11),
    });
  });
});

describe('knowledge asset read model — the three admin root branches', () => {
  it('MerkleRootAdded pushes a version and moves rootIndex with it', async () => {
    const store = seeded({
      rows: [created(30, 55n, root(0xa1)), rootAdded(40, 55n, root(0xa2))],
    });
    await expect(model(store).readLatestMerkleRoot(55n)).resolves.toEqual({
      merkleRoot: root(0xa2),
      rootIndex: 1,
    });
  });

  it('MerkleRootRemoved exposes the version UNDERNEATH, not the one it names', async () => {
    // The whole reason the fold keeps the stack instead of "the latest root":
    // the event names 0xa2, and the correct answer afterwards is 0xa1 at
    // rootIndex 0 — which only the history below the removal can supply.
    const store = seeded({
      rows: [
        created(30, 55n, root(0xa1)),
        rootAdded(40, 55n, root(0xa2)),
        rootRemoved(50, 55n, root(0xa2)),
      ],
    });
    await expect(model(store).readLatestMerkleRoot(55n)).resolves.toEqual({
      merkleRoot: root(0xa1),
      rootIndex: 0,
      author: author(0x11),
    });
  });

  it('refuses when MerkleRootRemoved names a root the fold does not hold on top', async () => {
    // Either history below was never walked or the fold disagrees with the
    // chain. Popping anyway would serve 0xa1 as the latest when the chain says
    // something else entirely.
    const store = seeded({
      rows: [created(30, 55n, root(0xa1)), rootRemoved(50, 55n, root(0xa9))],
    });
    await expect(model(store).readLatestMerkleRoot(55n)).resolves.toBeUndefined();
  });

  it('MerkleRootsUpdated replaces the whole stack and re-establishes its bottom', async () => {
    // No create is held at all, and the replacement is still servable: the
    // event names every version the chain holds, so the bottom is known.
    const store = seeded({
      rows: [rootsUpdated(50, 55n, [root(0xb1), root(0xb2), root(0xb3)])],
    });
    await expect(model(store).readLatestMerkleRoot(55n)).resolves.toEqual({
      merkleRoot: root(0xb3),
      rootIndex: 2,
    });
  });

  it('refuses an EMPTY replacement rather than reading it as "no versions"', async () => {
    const store = seeded({ rows: [created(30, 55n, root(0xa1)), rootsUpdated(50, 55n, [])] });
    await expect(model(store).readLatestMerkleRoot(55n)).resolves.toBeUndefined();
  });
});

describe('knowledge asset read model — a partially decoded replacement', () => {
  /**
   * The same signature carrying a `bytes` root instead of a `bytes32` one.
   *
   * This is the shape the decoder's own `record.merkleRoot ?? record[0]`
   * fallback exists for, and it is the only way to build a list in which SOME
   * entries normalize and others do not — with the shipped `bytes32` tuple
   * every entry is well-formed by construction, so the shipped ABI alone
   * cannot exercise the branch at all.
   */
  const variantInterface = new ethers.Interface([
    'event KnowledgeAssetCreated(uint256 indexed id, address indexed author, string operationId,'
    + ' bytes32 merkleRoot, uint256 byteSize, uint256 epochs, uint256 tokenAmount,'
    + ' uint256 scoreFunctionId, bool isImmutable)',
    'event KnowledgeAssetMerkleRootsUpdated(uint256 indexed id,'
    + ' tuple(bytes merkleRoot)[] merkleRoots)',
  ]);

  function variantModel(rows: readonly ChainEventLogRow[]) {
    const store = seeded({ rows });
    return createKnowledgeAssetReadModel({
      scope: SCOPE,
      store,
      registry: new ChainEventDecoderRegistry()
        .registerContextGraphAuthority(CG_STORAGE, cgInterface)
        .registerContextGraphKnowledgeAssets(CG_STORAGE, cgInterface)
        .registerKnowledgeAssets(KA_STORAGE, variantInterface),
      contextGraphStorageAddress: CG_STORAGE,
      knowledgeAssetStorageAddress: KA_STORAGE,
    });
  }

  const variantRootsUpdated = (
    blockNumber: number,
    kaId: bigint,
    roots: readonly string[],
  ): ChainEventLogRow => row(
    variantInterface,
    KA_STORAGE,
    'KnowledgeAssetMerkleRootsUpdated',
    [kaId, roots.map((merkleRoot) => [merkleRoot])],
    { blockNumber },
  );

  it('serves a replacement every entry of which decoded', async () => {
    const view = variantModel([variantRootsUpdated(50, 55n, [root(0xb1), root(0xb2)])]);
    await expect(view.readLatestMerkleRoot(55n)).resolves.toEqual({
      merkleRoot: root(0xb2),
      rootIndex: 1,
    });
  });

  it('refuses the WHOLE replacement when one entry does not decode', async () => {
    // Dropping the bad entry would serve 0xb1 at rootIndex 0 for a stack whose
    // chain top is the entry that failed. That is this branch's one way to feed
    // a verifier a root the chain does not hold, and a shorter list is a
    // DIFFERENT stack, not a partial one.
    const view = variantModel([variantRootsUpdated(50, 55n, [root(0xb1), '0xdead'])]);
    await expect(view.readLatestMerkleRoot(55n)).resolves.toBeUndefined();
  });

  it('refuses even when the entry that fails is the LAST one', async () => {
    const view = variantModel([
      variantRootsUpdated(50, 55n, [root(0xb1), root(0xb2), '0x00']),
    ]);
    await expect(view.readLatestMerkleRoot(55n)).resolves.toBeUndefined();
  });
});

describe('knowledge asset read model — allocator floor', () => {
  it('serves the highest ordinal under complete coverage', async () => {
    const store = seeded({
      rows: [
        created(30, (3n << 96n) | 7n, root(0xa1), author(0x22)),
        created(31, (3n << 96n) | 9n, root(0xa2), author(0x22)),
        created(32, (3n << 96n) | 40n, root(0xa3), author(0x33)),
      ],
    });
    await expect(model(store).readMaxKaNumberForAuthor(author(0x22))).resolves.toBe(9n);
  });

  it('refuses under partial coverage', async () => {
    // A partial fold yields a LOWER floor than the truth, and a low floor hands
    // out a KA number that is already taken.
    const store = seeded({
      kaCoverage: { coveredFromBlock: KA_FLOOR + 3 },
      rows: [created(30, (3n << 96n) | 7n, root(0xa1), author(0x22))],
    });
    await expect(model(store).readMaxKaNumberForAuthor(author(0x22))).resolves.toBeUndefined();
  });

  it('serves zero for an author with no assets under complete coverage', async () => {
    const store = seeded({ rows: [created(30, (3n << 96n) | 7n, root(0xa1), author(0x22))] });
    await expect(model(store).readMaxKaNumberForAuthor(author(0x44))).resolves.toBe(0n);
  });

  it('refuses when a create in the window carried no decodable author', async () => {
    // Coverage is complete and the fold is clean; what is missing is the ONE
    // property the floor is actually built from. Gating on coverage alone
    // returns 0n here — a floor below every number already handed out.
    const authorless = new ethers.Interface([
      'event KnowledgeAssetCreated(uint256 indexed id, string operationId, bytes32 merkleRoot)',
    ]);
    const store = seeded({
      rows: [row(
        authorless,
        KA_STORAGE,
        'KnowledgeAssetCreated',
        [(3n << 96n) | 7n, 'op-1', root(0xa1)],
        { blockNumber: 30 },
      )],
    });
    const view = createKnowledgeAssetReadModel({
      scope: SCOPE,
      store,
      registry: new ChainEventDecoderRegistry()
        .registerContextGraphAuthority(CG_STORAGE, cgInterface)
        .registerContextGraphKnowledgeAssets(CG_STORAGE, cgInterface)
        .registerKnowledgeAssets(KA_STORAGE, authorless),
      contextGraphStorageAddress: CG_STORAGE,
      knowledgeAssetStorageAddress: KA_STORAGE,
    });
    await expect(view.readMaxKaNumberForAuthor(author(0x22))).resolves.toBeUndefined();
  });
});

describe('knowledge asset read model — no log', () => {
  it('refuses every read when the scope has no cursor', async () => {
    const store = new MemoryChainEventLogStore();
    const view = model(store);
    await expect(view.readContextGraphForKa(1n)).resolves.toBeUndefined();
    await expect(view.readContextGraphKaList(1n)).resolves.toBeUndefined();
    await expect(view.readLatestMerkleRoot(1n)).resolves.toBeUndefined();
    await expect(view.readMaxKaNumberForAuthor(author(0x11))).resolves.toBeUndefined();
  });
});
