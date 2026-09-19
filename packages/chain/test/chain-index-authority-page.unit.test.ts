// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import { ChainEventDecoderRegistry } from '../src/chain-index/chain-event-decoders.js';
import { createChainIndexAuthorityPageSource } from
  '../src/chain-index/chain-index-authority-page.js';
import { isContextGraphAuthorityIndexRetryableError } from
  '../src/context-graph-authority-index-errors.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { MemoryChainEventLogStore } from './helpers/chain-event-log.js';

const SCOPE = 'evm:31337:0xhub:0xstorage';
const STORAGE = `0x${'cd'.repeat(20)}`.toLowerCase();
const OTHER_STORAGE = `0x${'ef'.repeat(20)}`.toLowerCase();

const hash = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(32)}`;
const storageInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));

function creationRow(blockNumber: number, contextGraphId: bigint) {
  const fragment = storageInterface.getEvent('ContextGraphCreated')!;
  const encoded = storageInterface.encodeEventLog(fragment, [
    contextGraphId,
    `0x${'11'.repeat(20)}`,
    `0x${'22'.repeat(32)}`,
    [`0x${'11'.repeat(20)}`],
    `0x${'33'.repeat(32)}`,
    1,
    0,
    `0x${'44'.repeat(20)}`,
    7n,
  ]);
  return {
    blockNumber,
    blockHash: hash(blockNumber),
    logIndex: 0,
    transactionHash: hash(0xaa),
    address: STORAGE,
    topics: [...encoded.topics],
    data: encoded.data,
    settled: true,
  };
}

function seeded(coverage: { from: number; through: number }): MemoryChainEventLogStore {
  const store = new MemoryChainEventLogStore();
  store.seed({
    cursor: {
      revision: 1,
      lineage: hash(0x01),
      deploymentBlockNumber: 10,
      settledBlockNumber: coverage.through,
      settledBlockHash: hash(coverage.through),
      head: {
        number: coverage.through,
        hash: hash(coverage.through),
        timestampSeconds: 1_700_000_000,
        fetchedAtMs: 1_700_000_000_000,
      },
      topicSetVersion: 'v1',
    },
    coverage: [{
      family: 'context-graph-authority',
      address: STORAGE,
      coveredFromBlock: coverage.from,
      coveredThroughBlock: coverage.through,
      floorBlock: 10,
    }],
  }, [creationRow(coverage.through, 7n)]);
  return store;
}

function source(store: MemoryChainEventLogStore, contractAddress = STORAGE) {
  return createChainIndexAuthorityPageSource({
    scope: SCOPE,
    store,
    registry: new ChainEventDecoderRegistry()
      .registerContextGraphAuthority(STORAGE, storageInterface),
    contractAddress,
    readBlockHash: async () => null,
  });
}

describe('chain index authority page source', () => {
  it('folds the stored rows for a range the log provably holds', async () => {
    const page = await source(seeded({ from: 10, through: 100 }))
      .readPage(10, 100, new AbortController().signal);

    expect(page).toHaveLength(1);
    expect(page[0]!.name).toBe('ContextGraphCreated');
  });

  it('refuses a range the log does not cover instead of folding it as empty', async () => {
    // The log holds 50-100; the reducer asks from 10. Returning [] here would
    // fold to "Context Graph 7 was never created", which downstream is an
    // ABSENT — one step from a PUBLIC or a roster missing a revoked member.
    const store = seeded({ from: 50, through: 100 });

    const failure = await source(store)
      .readPage(10, 100, new AbortController().signal)
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toBeDefined();
    expect(isContextGraphAuthorityIndexRetryableError(failure)).toBe(true);
    expect(String((failure as Error).message)).toContain('does not cover');
  });

  it('refuses a range ABOVE what the tick has reached', async () => {
    const store = seeded({ from: 10, through: 100 });

    const failure = await source(store)
      .readPage(10, 140, new AbortController().signal)
      .then(() => undefined, (error: unknown) => error);

    expect(isContextGraphAuthorityIndexRetryableError(failure)).toBe(true);
  });

  it('refuses a contract the coverage record says nothing about', async () => {
    const store = seeded({ from: 10, through: 100 });

    const failure = await source(store, OTHER_STORAGE)
      .readPage(10, 100, new AbortController().signal)
      .then(() => undefined, (error: unknown) => error);

    expect(isContextGraphAuthorityIndexRetryableError(failure)).toBe(true);
  });

  it('refuses every read while the scope has no cursor at all', async () => {
    const failure = await source(new MemoryChainEventLogStore())
      .readPage(10, 100, new AbortController().signal)
      .then(() => undefined, (error: unknown) => error);

    expect(isContextGraphAuthorityIndexRetryableError(failure)).toBe(true);
  });

  it('answers a block hash from the log before touching the chain', async () => {
    const store = seeded({ from: 10, through: 100 });
    let fallbacks = 0;
    const pageSource = createChainIndexAuthorityPageSource({
      scope: SCOPE,
      store,
      registry: new ChainEventDecoderRegistry()
        .registerContextGraphAuthority(STORAGE, storageInterface),
      contractAddress: STORAGE,
      readBlockHash: async () => { fallbacks += 1; return hash(0xee); },
    });

    expect(await pageSource.readBlockHash(100, new AbortController().signal)).toBe(hash(100));
    expect(fallbacks).toBe(0);
    // An empty block emitted nothing, so only the chain can name it.
    expect(await pageSource.readBlockHash(99, new AbortController().signal)).toBe(hash(0xee));
    expect(fallbacks).toBe(1);
  });
});
