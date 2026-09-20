// SPDX-License-Identifier: Apache-2.0

/**
 * The #2670 authority index, read through the ONE log.
 *
 * Every test here is about the same question in a different lighting: does a
 * read that the log CANNOT prove still reach the chain? The saving is only
 * defensible if the answer stays yes, because this index is what gates catalog
 * admission — an absence it reports wrongly is one hop from a PUBLIC.
 */

import { ethers, type JsonRpcProvider } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import { ChainEventDecoderRegistry } from '../src/chain-index/chain-event-decoders.js';
import {
  chainIndexAuthorityAnchorHolds,
  resolveChainIndexAuthorityAnchor,
} from '../src/chain-index/chain-index-anchor.js';
import { createChainIndexAuthorityPageSource } from
  '../src/chain-index/chain-index-authority-page.js';
import type { ChainEventLogAuthoritySource } from '../src/chain-event-log-binding.js';
import { ContextGraphAuthorityIndex } from '../src/context-graph-authority-index.js';
import { createEvmContextGraphAuthorityIndexRevisionReaderV1 } from
  '../src/evm-context-graph-authority-index-reader.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { MemoryChainEventLogStore } from './helpers/chain-event-log.js';
import { MemoryAuthorityIndexStore } from './helpers/context-graph-authority-index.js';

const DEPLOYMENT = 'evm:31337:0xhub';
const STORAGE = `0x${'cd'.repeat(20)}`.toLowerCase();
const ROTATED_STORAGE = `0x${'ab'.repeat(20)}`.toLowerCase();
const SCOPE = [DEPLOYMENT, STORAGE].join(':');
const OWNER = `0x${'11'.repeat(20)}`;
const NAME_HASH = `0x${'33'.repeat(32)}`;
const ABSENT_NAME_HASH = `0x${'55'.repeat(32)}`;
const DEPLOY_BLOCK = 10;
const HEAD = 105;
/** The chain the PROVIDER answers for: ahead of the log, as it always is. */
const LIVE_HEAD = 130;
const HEAD_TIMESTAMP_SECONDS = 1_700_000_000;
const NOW_MS = HEAD_TIMESTAMP_SECONDS * 1_000;
const TICK_MS = 6_000;

const hash = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(32)}`;
const storageInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));

function creationRow(blockNumber: number, contextGraphId: bigint, nameHash: string) {
  const fragment = storageInterface.getEvent('ContextGraphCreated')!;
  const encoded = storageInterface.encodeEventLog(fragment, [
    contextGraphId,
    OWNER,
    nameHash,
    [OWNER],
    `0x${'44'.repeat(32)}`,
    1,
    0,
    `0x${'66'.repeat(20)}`,
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

function seededStore(options: {
  coveredFrom?: number;
  head?: number;
  fetchedAtMs?: number;
} = {}): MemoryChainEventLogStore {
  const store = new MemoryChainEventLogStore();
  const head = options.head ?? HEAD;
  store.seed({
    cursor: {
      revision: 1,
      lineage: hash(0x01),
      deploymentBlockNumber: DEPLOY_BLOCK,
      settledBlockNumber: head - 50,
      settledBlockHash: hash(head - 50),
      head: {
        number: head,
        hash: hash(head),
        timestampSeconds: HEAD_TIMESTAMP_SECONDS,
        fetchedAtMs: options.fetchedAtMs ?? NOW_MS,
      },
      topicSetVersion: 'v1',
    },
    coverage: [{
      family: 'context-graph-authority',
      address: STORAGE,
      coveredFromBlock: options.coveredFrom ?? DEPLOY_BLOCK,
      coveredThroughBlock: head,
      floorBlock: DEPLOY_BLOCK,
    }],
  }, [creationRow(20, 7n, NAME_HASH)]);
  return store;
}

/**
 * The production `ChainEventLogAuthoritySource`, assembled from the same three
 * pieces `createEvmChainIndexRuntime` assembles it from. Nothing about the
 * guards is stubbed — only the wall clock and the address the tick walked.
 */
function logSource(
  store: MemoryChainEventLogStore,
  options: { nowMs?: number; contractAddress?: string } = {},
): ChainEventLogAuthoritySource {
  const contractAddress = options.contractAddress ?? STORAGE;
  return Object.freeze({
    contractAddress,
    pageSource: createChainIndexAuthorityPageSource({
      scope: SCOPE,
      store,
      registry: new ChainEventDecoderRegistry()
        .registerContextGraphAuthority(STORAGE, storageInterface),
      contractAddress: STORAGE,
      readBlockHash: async () => null,
    }),
    async resolveAnchor(input) {
      return resolveChainIndexAuthorityAnchor({
        state: await store.load(SCOPE),
        contractAddress: STORAGE,
        deploymentBlockNumber: input.deploymentBlockNumber,
        finalityConfirmations: input.finalityConfirmations,
        nowMs: options.nowMs ?? NOW_MS,
        maxHeadAgeMs: 3 * TICK_MS,
        headTimestampToleranceMs: 5 * 60_000,
      });
    },
    anchorHolds(anchor) {
      return chainIndexAuthorityAnchorHolds(() => store.load(SCOPE), anchor);
    },
  });
}

/** One provider that counts every chain round trip this read could make. */
function makeProvider() {
  const calls = { getBlock: 0, getLogs: 0, getNetwork: 0 };
  const authorityLogs: ethers.Log[] = [];
  const provider = {
    async getBlock(tag: ethers.BlockTag) {
      calls.getBlock += 1;
      const number = tag === 'latest' ? LIVE_HEAD : Number(tag);
      return { number, hash: hash(number), timestamp: HEAD_TIMESTAMP_SECONDS };
    },
    async getLogs() {
      calls.getLogs += 1;
      return authorityLogs;
    },
    async getNetwork() {
      calls.getNetwork += 1;
      return { chainId: 31337n };
    },
  } as unknown as JsonRpcProvider;
  return { provider, calls, authorityLogs };
}

function makeReader(options: {
  store?: MemoryChainEventLogStore;
  source?: ChainEventLogAuthoritySource | undefined;
  contractAddress?: string;
} = {}) {
  const { provider, calls, authorityLogs } = makeProvider();
  const index = new ContextGraphAuthorityIndex(
    new MemoryAuthorityIndexStore(),
    undefined,
    { tickMs: TICK_MS, now: () => NOW_MS },
  );
  const base = new ethers.Contract(
    options.contractAddress ?? STORAGE,
    loadAbi('ContextGraphStorage'),
    provider,
  );
  const attempts: unknown[] = [];
  const reader = createEvmContextGraphAuthorityIndexRevisionReaderV1({
    index,
    deploymentId: DEPLOYMENT,
    initialize: async () => undefined,
    requireContextGraphStorage: () => base,
    // Two attempts, then surface: enough for a retryable fence refusal to be
    // observable as a retry rather than as an infinite loop.
    readTipProvider: async (_label, read, opts) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await read(provider);
        } catch (error) {
          attempts.push(error);
          if (attempt >= 1 || opts?.isRetryable?.(error) !== true) throw error;
        }
      }
    },
    resolveContractDeployBlock: async () => ({ fromBlock: DEPLOY_BLOCK }),
    pageSize: () => 2_000,
    finalityConfirmations: () => 1,
    ...(options.source === undefined ? {} : { chainEventLogAuthority: () => options.source }),
  });
  reader.snapshots.open();
  return { reader, calls, authorityLogs, attempts };
}

/** The same `ContextGraphCreated`, as the LIVE scan would deliver it. */
function liveCreationLog(blockNumber: number, contextGraphId: bigint, nameHash: string) {
  const row = creationRow(blockNumber, contextGraphId, nameHash);
  return {
    blockNumber,
    blockHash: row.blockHash,
    index: 0,
    transactionHash: row.transactionHash,
    address: STORAGE,
    topics: row.topics,
    data: row.data,
  } as unknown as ethers.Log;
}

describe('Context Graph authority index over the one log', () => {
  it('issues ZERO chain reads for an answer the log can prove', async () => {
    const store = seededStore();
    const { reader, calls } = makeReader({ store, source: logSource(store) });

    const resolved = await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH);

    expect(resolved).toBe(7n);
    // The head probe, the anchor probe, the page scan and the stabilization
    // re-read — the whole of what this index used to spend — are all gone.
    expect(calls.getBlock).toBe(0);
    expect(calls.getLogs).toBe(0);
  });

  it('keeps its live scan while the log holds no cursor at all', async () => {
    const cold = new MemoryChainEventLogStore();
    const { reader, calls, authorityLogs } = makeReader({
      store: cold,
      source: logSource(cold),
    });
    authorityLogs.push(liveCreationLog(20, 7n, NAME_HASH));

    expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);
    expect(calls.getLogs).toBeGreaterThan(0);
    expect(calls.getBlock).toBeGreaterThan(0);
  });

  it('keeps its live scan while the backfill has not reached the deploy block', async () => {
    // The rows the log holds would answer — but nothing proves that the blocks
    // BELOW them hold no earlier commitment for this name.
    const store = seededStore({ coveredFrom: 60 });
    const { reader, calls, authorityLogs } = makeReader({ store, source: logSource(store) });
    authorityLogs.push(liveCreationLog(20, 7n, NAME_HASH));

    expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);
    expect(calls.getLogs).toBeGreaterThan(0);
  });

  it('keeps its live scan once the tick has gone quiet, however servable the rows look', async () => {
    const store = seededStore();
    const { reader, calls, authorityLogs } = makeReader({
      store,
      // Coverage, rows and lineage are untouched; only the clock moved past
      // three missed passes.
      source: logSource(store, { nowMs: NOW_MS + 3 * TICK_MS + 1 }),
    });
    authorityLogs.push(liveCreationLog(20, 7n, NAME_HASH));

    expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);
    expect(calls.getLogs).toBeGreaterThan(0);
  });

  it('never reads a log bound to the ContextGraphStorage the Hub rotated away from', async () => {
    const store = seededStore();
    const { reader, calls, authorityLogs } = makeReader({
      store,
      // The adapter now resolves ROTATED_STORAGE; the log still walked STORAGE.
      source: logSource(store, { contractAddress: STORAGE }),
      contractAddress: ROTATED_STORAGE,
    });
    authorityLogs.push(liveCreationLog(20, 7n, NAME_HASH));

    expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);
    expect(calls.getLogs).toBeGreaterThan(0);
  });

  it('discards a log fold the caller own targets are ABSENT from, and reads live', async () => {
    // A graph registered SECONDS ago: above the log cursor, below the live
    // head. The log is fresh and complete to its own horizon and still cannot
    // see it, so its fold is an absence — the one answer that must never be
    // served from anything but a read taken for this caller.
    const store = seededStore();
    const { reader, calls, authorityLogs } = makeReader({ store, source: logSource(store) });
    authorityLogs.push(liveCreationLog(LIVE_HEAD - 10, 9n, ABSENT_NAME_HASH));

    expect(await reader.resolveFinalizedContextGraphIdByNameHash(ABSENT_NAME_HASH)).toBe(9n);
    expect(calls.getLogs).toBeGreaterThan(0);
  });

  it('refuses the fold when the tick committed underneath it', async () => {
    const store = seededStore();
    // The fence, and only the fence: the anchor resolves, the pages read, and
    // then the log moves before the answer is handed over.
    const moved = vi.fn(async () => false);
    const source = { ...logSource(store), anchorHolds: moved };
    const { reader, attempts } = makeReader({ store, source });

    await expect(reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /chain event log moved under/,
    );
    // Retryable, not fatal: the transport asked for a second attempt.
    expect(attempts).toHaveLength(2);
    expect(moved).toHaveBeenCalled();
  });
});
