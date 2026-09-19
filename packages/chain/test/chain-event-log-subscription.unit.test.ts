// SPDX-License-Identifier: Apache-2.0

/**
 * Subscribers over the one log.
 *
 * The cases that matter are the clamping ones. A lane advances its cursor to
 * whatever upper bound it was handed, so a range wider than the log holds
 * skips those blocks permanently — being handed LESS than asked for is the
 * correct answer, and being handed nothing is better than being handed a
 * silently short scan of the full range.
 */

import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import { ChainEventDecoderRegistry } from '../src/chain-index/chain-event-decoders.js';
import { createChainEventLogSubscription } from
  '../src/chain-index/chain-event-log-subscription.js';
import type { ChainEventLogRow } from '../src/chain-index/chain-event-log.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { MemoryChainEventLogStore } from './helpers/chain-event-log.js';

const SCOPE = 'evm:31337:0xhub:0xstorage';
const CG_STORAGE = `0x${'cd'.repeat(20)}`.toLowerCase();
const KA_STORAGE = `0x${'ab'.repeat(20)}`.toLowerCase();

const hash = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(32)}`;
const cgInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));
const kaInterface = new ethers.Interface(loadAbi('DKGKnowledgeAssets'));

function registry(): ChainEventDecoderRegistry {
  return new ChainEventDecoderRegistry()
    .registerContextGraphAuthority(CG_STORAGE, cgInterface)
    .registerContextGraphKnowledgeAssets(CG_STORAGE, cgInterface)
    .registerKnowledgeAssets(KA_STORAGE, kaInterface);
}

function registrationRow(blockNumber: number, cgId: bigint, kaId: bigint): ChainEventLogRow {
  const fragment = cgInterface.getEvent('KnowledgeAssetRegisteredToContextGraph')!;
  const encoded = cgInterface.encodeEventLog(fragment, [cgId, kaId]);
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

function seeded(
  coveredFromBlock: number,
  coveredThroughBlock: number,
  settledBlockNumber: number,
  rows: readonly ChainEventLogRow[] = [],
): MemoryChainEventLogStore {
  const store = new MemoryChainEventLogStore();
  store.seed({
    cursor: {
      revision: 1,
      lineage: hash(1),
      deploymentBlockNumber: 10,
      settledBlockNumber,
      settledBlockHash: hash(settledBlockNumber),
      head: {
        number: coveredThroughBlock,
        hash: hash(coveredThroughBlock),
        timestampSeconds: 1_700_000_000,
        fetchedAtMs: 1_700_000_000_000,
      },
      topicSetVersion: 'v1',
    },
    coverage: [{
      family: 'context-graph-ka',
      address: CG_STORAGE,
      coveredFromBlock,
      coveredThroughBlock,
      floorBlock: 10,
    }],
  }, rows);
  return store;
}

const subscription = (store: MemoryChainEventLogStore) =>
  createChainEventLogSubscription({ scope: SCOPE, store, registry: registry() });

describe('chain event log subscription', () => {
  it('clamps the range to what coverage proves, never wider', async () => {
    const store = seeded(10, 90, 85);
    const range = await subscription(store).servableRange('context-graph-ka', CG_STORAGE, 50, 200);
    // The lane asked through 200; it may only advance its cursor to 90.
    expect(range).toEqual({ fromBlockNumber: 50, throughBlockNumber: 90 });
  });

  it('refuses when the lane cursor sits below the log floor', async () => {
    // Clamping the BOTTOM up instead would hide blocks 20-39 from a lane that
    // will never look at them again.
    const store = seeded(40, 90, 85);
    await expect(
      subscription(store).servableRange('context-graph-ka', CG_STORAGE, 20, 90),
    ).resolves.toBeUndefined();
  });

  it('refuses a family the log does not track', async () => {
    const store = seeded(10, 90, 85);
    await expect(
      subscription(store).servableRange('knowledge-asset', KA_STORAGE, 50, 90),
    ).resolves.toBeUndefined();
  });

  it('refuses when there is no cursor at all', async () => {
    await expect(
      subscription(new MemoryChainEventLogStore())
        .servableRange('context-graph-ka', CG_STORAGE, 0, 90),
    ).resolves.toBeUndefined();
  });

  it('caps the finalized view at the settled cursor', async () => {
    const store = seeded(10, 90, 85);
    await expect(
      subscription(store).servableRange('context-graph-ka', CG_STORAGE, 50, 90, 'finalized'),
    ).resolves.toEqual({ fromBlockNumber: 50, throughBlockNumber: 85 });
  });

  it('decodes registrations over an approved range', async () => {
    const store = seeded(10, 90, 85, [
      registrationRow(50, 7n, 100n),
      registrationRow(60, 7n, 101n),
    ]);
    const view = subscription(store);
    const range = await view.servableRange('context-graph-ka', CG_STORAGE, 10, 90);
    const events = await view.readKaRegistrations(CG_STORAGE, range!);
    expect(events.map((event) => event.kaId)).toEqual([100n, 101n]);
    expect(events[0]?.contextGraphId).toBe(7n);
  });
});

describe('chain event decoder registry dispatch', () => {
  it('routes two families sharing one address by topic0', () => {
    const rows = [registrationRow(50, 7n, 100n)];
    const built = registry();
    expect(built.familyOf(rows[0]!)).toBe('context-graph-ka');
    // The authority reducer must not see a KA registration: it would fold an
    // event it has no case for.
    expect(built.decodeContextGraphAuthority(rows)).toEqual([]);
    expect(built.decodeContextGraphKaRegistrations(rows)).toHaveLength(1);
  });

  it('refuses a second claim on a topic already taken at one address', () => {
    // Asserting the SPECIFIC message, not just "it threw": a generic match
    // would still pass if this guard were removed and some other check threw.
    expect(() => new ChainEventDecoderRegistry()
      .registerContextGraphKnowledgeAssets(CG_STORAGE, cgInterface)
      .registerContextGraphKnowledgeAssets(CG_STORAGE, cgInterface))
      .toThrow(/is already claimed by family context-graph-ka/);
  });

  it('does not route a foreign contract emitting a known topic0', () => {
    // ERC-721 `Transfer` is shared by ContextGraphStorage, DKGKnowledgeAssets,
    // the PCA NFT and the token. Dispatch is by (address, topic0) precisely so
    // a TRAC transfer cannot reach the Context Graph ownership reducer.
    const fragment = cgInterface.getEvent('Transfer')!;
    const encoded = cgInterface.encodeEventLog(fragment, [
      `0x${'11'.repeat(20)}`,
      `0x${'22'.repeat(20)}`,
      7n,
    ]);
    const foreign: ChainEventLogRow = {
      blockNumber: 50,
      blockHash: hash(50),
      logIndex: 0,
      transactionHash: hash(0xaa),
      address: `0x${'99'.repeat(20)}`,
      topics: [...encoded.topics],
      data: encoded.data,
      settled: true,
    };
    expect(registry().familyOf(foreign)).toBeUndefined();
  });
});
