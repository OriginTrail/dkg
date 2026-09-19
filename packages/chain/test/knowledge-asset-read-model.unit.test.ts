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

interface SeedOptions {
  readonly cgCoverage?: Partial<ChainEventLogCoverage>;
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

function model(store: MemoryChainEventLogStore) {
  return createKnowledgeAssetReadModel({
    scope: SCOPE,
    store,
    registry: registry(),
    contextGraphStorageAddress: CG_STORAGE,
    knowledgeAssetStorageAddress: KA_STORAGE,
  });
}

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
        registration(50, 7n, 100n, { logIndex: 3 }),
        registration(50, 7n, 101n, { logIndex: 1 }),
        registration(60, 7n, 102n),
        registration(61, 8n, 999n),
      ],
    });
    const list = await model(store).readContextGraphKaList(7n, 40);
    expect(list?.kaIds).toEqual([101n, 100n, 102n]);
  });

  it('refuses when coverage does not reach the graph creation block', async () => {
    const store = seeded({
      cgCoverage: { coveredFromBlock: 45 },
      rows: [registration(50, 7n, 100n)],
    });
    // The graph was created at 40 and the log only holds from 45: an ordinal
    // computed here could be missing the graph's first KAs entirely.
    await expect(model(store).readContextGraphKaList(7n, 40)).resolves.toBeUndefined();
  });

  it('serves an empty list once coverage reaches the creation block', async () => {
    const store = seeded({ rows: [registration(50, 8n, 100n)] });
    const list = await model(store).readContextGraphKaList(7n, 40);
    expect(list?.kaIds).toEqual([]);
  });

  it('never double-counts a replayed registration', async () => {
    const store = seeded({
      rows: [
        registration(50, 7n, 100n),
        registration(51, 7n, 100n, { logIndex: 5 }),
        registration(52, 7n, 101n),
      ],
    });
    const list = await model(store).readContextGraphKaList(7n, 40);
    // A duplicate appended would shift 101n from ordinal 1 to ordinal 2 and
    // make every later `getContextGraphKaAt` disagree with the chain.
    expect(list?.kaIds).toEqual([100n, 101n]);
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
});

describe('knowledge asset read model — no log', () => {
  it('refuses every read when the scope has no cursor', async () => {
    const store = new MemoryChainEventLogStore();
    const view = model(store);
    await expect(view.readContextGraphForKa(1n)).resolves.toBeUndefined();
    await expect(view.readContextGraphKaList(1n, 0)).resolves.toBeUndefined();
    await expect(view.readLatestMerkleRoot(1n)).resolves.toBeUndefined();
    await expect(view.readMaxKaNumberForAuthor(author(0x11))).resolves.toBeUndefined();
  });
});
