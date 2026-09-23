// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import {
  ChainEventDecoderRegistry,
  type KnowledgeAssetEvent,
} from '../src/chain-index/chain-event-decoders.js';
import type { ChainEventLogRow } from '../src/chain-index/chain-event-log.js';
import {
  latestMerkleRootOf,
  reduceKnowledgeAssetEvents,
} from '../src/chain-index/knowledge-asset-reducer.js';
import { loadAbi } from '../src/evm-adapter-abi.js';

const KA_STORAGE = `0x${'ab'.repeat(20)}`;
const AUTHOR = `0x${'11'.repeat(20)}`;
const PUBLISHER = `0x${'22'.repeat(20)}`;
const OTHER_PUBLISHER = `0x${'33'.repeat(20)}`;
const root = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(32)}`;
const hash = (seed: number): string => root(seed);
const kaInterface = new ethers.Interface(loadAbi('DKGKnowledgeAssets'));

function event(
  name: KnowledgeAssetEvent['name'],
  kaId: bigint,
  blockNumber: number,
  fields: Partial<Pick<KnowledgeAssetEvent, 'merkleRoot' | 'merkleRoots' | 'author'>> = {},
): KnowledgeAssetEvent {
  return Object.freeze({
    name,
    kaId,
    blockNumber,
    logIndex: 0,
    transactionHash: hash(blockNumber + 100),
    settled: true,
    ...fields,
  });
}

function encodedRow(
  name: KnowledgeAssetEvent['name'],
  args: readonly unknown[],
  blockNumber: number,
): ChainEventLogRow {
  const encoded = kaInterface.encodeEventLog(kaInterface.getEvent(name)!, args);
  return Object.freeze({
    blockNumber,
    blockHash: hash(blockNumber),
    logIndex: blockNumber,
    transactionHash: hash(blockNumber + 100),
    address: KA_STORAGE,
    topics: Object.freeze([...encoded.topics]),
    data: encoded.data,
    settled: true,
  });
}

describe('knowledge-asset one-log reducer', () => {
  it('keeps stack order and exposes the root uncovered by a top removal', () => {
    const reduced = reduceKnowledgeAssetEvents([
      event('KnowledgeAssetCreated', 1n, 10, { merkleRoot: root(1), author: AUTHOR }),
      event('KnowledgeAssetMerkleRootAdded', 1n, 11, { merkleRoot: root(2) }),
      event('KnowledgeAssetMerkleRootRemoved', 1n, 12, { merkleRoot: root(2) }),
    ]);

    const stack = reduced.rootsByKa.get('1');
    expect(stack?.versions).toEqual([{ merkleRoot: root(1), author: AUTHOR }]);
    expect(latestMerkleRootOf(stack)).toEqual({
      merkleRoot: root(1),
      rootIndex: 0,
      author: AUTHOR,
    });
    expect(stack?.throughBlockNumber).toBe(12);
  });

  it('contains missing or malformed history to only the affected KA', () => {
    const reduced = reduceKnowledgeAssetEvents([
      event('KnowledgeAssetCreated', 1n, 10, { merkleRoot: root(1), author: AUTHOR }),
      event('KnowledgeAssetMerkleRootRemoved', 2n, 11, { merkleRoot: root(9) }),
      // An undecodable whole replacement arrives without `merkleRoots`.
      event('KnowledgeAssetMerkleRootsUpdated', 3n, 12),
    ]);

    expect(reduced.rootsByKa.get('1')?.unservable).toBeUndefined();
    expect(reduced.rootsByKa.get('2')?.unservable).toBe('missing-history');
    expect(reduced.rootsByKa.get('3')?.unservable).toBe('inconsistent');
    expect(latestMerkleRootOf(reduced.rootsByKa.get('2'))).toBeUndefined();
  });

  it('replaces the whole stack and never invents an allocator floor without an author', () => {
    const numberedKa = (5n << 96n) | 7n;
    const reduced = reduceKnowledgeAssetEvents([
      event('KnowledgeAssetCreated', numberedKa, 10, {
        merkleRoot: root(1),
        author: AUTHOR,
      }),
      event('KnowledgeAssetCreated', 9n, 11, { merkleRoot: root(2) }),
      event('KnowledgeAssetMerkleRootsUpdated', numberedKa, 12, {
        merkleRoots: [
          { merkleRoot: root(3), publisher: PUBLISHER },
          { merkleRoot: root(4), publisher: OTHER_PUBLISHER },
        ],
      }),
    ]);

    expect(reduced.maxKaNumberByAuthor.get(AUTHOR)).toBe(7n);
    expect(reduced.authorlessCreates).toBe(1);
    expect(reduced.maxKaNumberByAuthor.size).toBe(1);
    expect(reduced.rootsByKa.get(numberedKa.toString())?.versions).toEqual([
      { merkleRoot: root(3), publisher: PUBLISHER },
      { merkleRoot: root(4), publisher: OTHER_PUBLISHER },
    ]);
    expect(latestMerkleRootOf(reduced.rootsByKa.get(numberedKa.toString())))
      .toEqual({ merkleRoot: root(4), rootIndex: 1 });
  });
});

describe('DKGKnowledgeAssets one-log decoder', () => {
  it('decodes all five stack event shapes from the production ABI', () => {
    const kaId = 42n;
    const rows = [
      encodedRow('KnowledgeAssetCreated', [
        kaId, AUTHOR, 'create-op', root(1), 100n, 1n, 2n, 3n, false,
      ], 10),
      encodedRow('KnowledgeAssetUpdated', [
        kaId, AUTHOR, 'update-op', root(2), 101n, 4n,
      ], 11),
      encodedRow('KnowledgeAssetMerkleRootAdded', [kaId, root(3)], 12),
      encodedRow('KnowledgeAssetMerkleRootRemoved', [kaId, root(3)], 13),
      encodedRow('KnowledgeAssetMerkleRootsUpdated', [kaId, [
        [PUBLISHER, root(4), 100n],
        [OTHER_PUBLISHER, root(5), 101n],
      ]], 14),
    ];
    const decoded = new ChainEventDecoderRegistry()
      .registerKnowledgeAssets(KA_STORAGE, kaInterface)
      .decodeKnowledgeAssets(rows);

    expect(decoded.map((entry) => entry.name)).toEqual([
      'KnowledgeAssetCreated',
      'KnowledgeAssetUpdated',
      'KnowledgeAssetMerkleRootAdded',
      'KnowledgeAssetMerkleRootRemoved',
      'KnowledgeAssetMerkleRootsUpdated',
    ]);
    expect(decoded[0]).toMatchObject({ kaId, merkleRoot: root(1), author: AUTHOR });
    expect(decoded[1]).toMatchObject({ kaId, merkleRoot: root(2), author: AUTHOR });
    expect(decoded[2]).toMatchObject({ kaId, merkleRoot: root(3) });
    expect(decoded[3]).toMatchObject({ kaId, merkleRoot: root(3) });
    expect(decoded[4]?.merkleRoots).toEqual([
      { publisher: PUBLISHER, merkleRoot: root(4) },
      { publisher: OTHER_PUBLISHER, merkleRoot: root(5) },
    ]);

    const folded = reduceKnowledgeAssetEvents(decoded);
    expect(folded.rootsByKa.get(kaId.toString())?.versions).toEqual([
      { publisher: PUBLISHER, merkleRoot: root(4) },
      { publisher: OTHER_PUBLISHER, merkleRoot: root(5) },
    ]);
  });

  it('decodes unnamed MerkleRoot tuple components by their Solidity positions', () => {
    const unnamedTupleInterface = new ethers.Interface([
      'event KnowledgeAssetCreated(uint256 indexed id)',
      'event KnowledgeAssetMerkleRootsUpdated(uint256 indexed id, '
        + '(address,bytes32,uint256)[] merkleRoots)',
    ]);
    const event = unnamedTupleInterface.getEvent('KnowledgeAssetMerkleRootsUpdated')!;
    const encoded = unnamedTupleInterface.encodeEventLog(event, [42n, [
      [PUBLISHER, root(4), 100n],
      [OTHER_PUBLISHER, root(5), 101n],
    ]]);
    const rows: ChainEventLogRow[] = [{
      blockNumber: 14,
      blockHash: hash(14),
      logIndex: 0,
      transactionHash: hash(0xaa),
      address: KA_STORAGE,
      topics: [...encoded.topics],
      data: encoded.data,
      settled: true,
    }];

    const decoded = new ChainEventDecoderRegistry()
      .registerKnowledgeAssets(KA_STORAGE, unnamedTupleInterface)
      .decodeKnowledgeAssets(rows);

    expect(decoded[0]?.merkleRoots).toEqual([
      { publisher: PUBLISHER, merkleRoot: root(4) },
      { publisher: OTHER_PUBLISHER, merkleRoot: root(5) },
    ]);
  });
});
