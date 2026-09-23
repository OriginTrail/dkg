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
import { RpcEndpointsExhaustedError } from '../src/chain-rpc-transport-error.js';
import { ContextGraphAuthorityIndex } from '../src/context-graph-authority-index.js';
import type { ContextGraphAuthorityProjectionServedEvidence } from
  '../src/context-graph-authority-index-projection.js';
import { createEvmContextGraphAuthorityIndexRevisionReaderV1 } from
  '../src/evm-context-graph-authority-index-reader.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { RpcUsageTracker } from '../src/rpc-usage.js';
import { MemoryChainEventLogStore } from './helpers/chain-event-log.js';
import { MemoryAuthorityIndexStore } from './helpers/context-graph-authority-index.js';

const DEPLOYMENT = 'evm:31337:0xhub';
const STORAGE = `0x${'cd'.repeat(20)}`.toLowerCase();
const ROTATED_STORAGE = `0x${'ab'.repeat(20)}`.toLowerCase();
const SCOPE = [DEPLOYMENT, STORAGE].join(':');
const OWNER = `0x${'11'.repeat(20)}`;
const NAME_HASH = `0x${'33'.repeat(32)}`;
const ABSENT_NAME_HASH = `0x${'55'.repeat(32)}`;
/**
 * A name hash whose HEX contains `500`, so the ambiguity message this index
 * raises about it satisfies `classifyRpcRetryDisposition`'s bare
 * `429|503|502|500` alternation. ~5.9% of 32-byte hashes do; nothing about the
 * value is otherwise special, which is the point.
 */
const FAILOVER_NAME_HASH = `0x500${'a'.repeat(61)}`;
const DEPLOY_BLOCK = 10;
const HEAD = 105;
/** The chain the PROVIDER answers for: ahead of the log, as it always is. */
const LIVE_HEAD = 130;
const HEAD_TIMESTAMP_SECONDS = 1_700_000_000;
const NOW_MS = HEAD_TIMESTAMP_SECONDS * 1_000;
const TICK_MS = 6_000;

const hash = (seed: number): string => `0x${seed.toString(16).padStart(64, '0')}`;
const storageInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));

function creationRow(
  blockNumber: number,
  contextGraphId: bigint,
  nameHash: string,
  accessPolicy: number = 1,
) {
  const fragment = storageInterface.getEvent('ContextGraphCreated')!;
  const encoded = storageInterface.encodeEventLog(fragment, [
    contextGraphId,
    OWNER,
    nameHash,
    [OWNER],
    `0x${'44'.repeat(32)}`,
    accessPolicy,
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

interface SeedOptions {
  coveredFrom?: number;
  head?: number;
  fetchedAtMs?: number;
  /** Replaces the single default creation row. */
  rows?: readonly ReturnType<typeof creationRow>[];
}

/** Put one committed tick state into `store`, as the runner's pass would. */
function seedLog(
  store: MemoryChainEventLogStore,
  options: SeedOptions = {},
): MemoryChainEventLogStore {
  const head = options.head ?? HEAD;
  store.seed(SCOPE, {
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
  }, options.rows ?? [creationRow(20, 7n, NAME_HASH)]);
  return store;
}

function seededStore(options: SeedOptions = {}): MemoryChainEventLogStore {
  return seedLog(new MemoryChainEventLogStore(), options);
}

/**
 * The production `ChainEventLogAuthoritySource`, assembled from the same three
 * pieces `createEvmChainIndexRuntime` assembles it from. Nothing about the
 * guards is stubbed — only the wall clock and the address the tick walked.
 */
function logSource(
  store: MemoryChainEventLogStore,
  options: {
    nowMs?: number;
    /** A MOVING clock, read per anchor resolution, where a test needs one. */
    now?: () => number;
    contractAddress?: string;
    /**
     * The point read the runtime wires in for a block the log holds no event
     * from. Most tests here fold once and never need it; a test whose DURABLE
     * cursor advances between reads does, because re-admitting the stored
     * cursor re-checks that block's hash.
     */
    readBlockHash?: (blockNumber: number) => Promise<string | null>;
  } = {},
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
      readBlockHash: options.readBlockHash ?? (async () => null),
    }),
    async resolveAnchor(input) {
      return resolveChainIndexAuthorityAnchor({
        state: await store.load(SCOPE),
        contractAddress: STORAGE,
        deploymentBlockNumber: input.deploymentBlockNumber,
        finalityConfirmations: input.finalityConfirmations,
        nowMs: options.now?.() ?? options.nowMs ?? NOW_MS,
        maxHeadAgeMs: 3 * TICK_MS,
        headTimestampToleranceMs: 5 * 60_000,
      });
    },
    anchorHolds(anchor) {
      return chainIndexAuthorityAnchorHolds(
        () => store.load(SCOPE),
        anchor,
        {
          nowMs: options.now?.() ?? options.nowMs ?? NOW_MS,
          maxHeadAgeMs: 3 * TICK_MS,
          headTimestampToleranceMs: 5 * 60_000,
        },
      );
    },
  });
}

/** One provider that counts every chain round trip this read could make. */
function makeProvider() {
  const calls = { getBlock: 0, getLogs: 0, getNetwork: 0 };
  const usage = new RpcUsageTracker(() => 'evm:31337');
  const authorityLogs: ethers.Log[] = [];
  const provider = {
    async getBlock(tag: ethers.BlockTag) {
      calls.getBlock += 1;
      usage.record('eth_getBlockByNumber');
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
  return { provider, calls, authorityLogs, usage };
}

function makeReader(options: {
  store?: MemoryChainEventLogStore;
  source?: ChainEventLogAuthoritySource | undefined;
  sourceProvider?: () => ChainEventLogAuthoritySource | undefined;
  contractAddress?: string;
  finalityConfirmations?: number;
  /** The projection cache's clock, where a test has to age a projection. */
  now?: () => number;
  /**
   * Mirror the production failover loop's ENDING: once `isRetryable` has sent
   * the read round every endpoint, `RpcFailoverClient` does not rethrow the
   * last error — it throws the typed `RPC_ENDPOINTS_EXHAUSTED`, which is the
   * only thing the projection cache reads as an availability outage.
   */
  exhaustsOnFailover?: boolean;
} = {}) {
  const { provider, calls, authorityLogs, usage } = makeProvider();
  const index = new ContextGraphAuthorityIndex(
    new MemoryAuthorityIndexStore(),
    undefined,
    { tickMs: TICK_MS, now: options.now ?? (() => NOW_MS) },
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
          if (opts?.isRetryable?.(error) !== true) throw error;
          if (attempt >= 1) {
            if (options.exhaustsOnFailover !== true) throw error;
            throw new RpcEndpointsExhaustedError(
              error instanceof Error ? error.message : String(error),
              'mixed',
              { cause: error },
            );
          }
        }
      }
    },
    // The NUMBER the reader declares, which is what the adapter wires in
    // (`resolveContractDeployBlockNumber`), not the adapter's own
    // `{ fromBlock, head, scanProviders }` search result. Handing the object
    // over made every anchor unresolvable and sent all of these through the
    // live scan they exist to prove is skipped.
    resolveContractDeployBlockNumber: async () => DEPLOY_BLOCK,
    pageSize: () => 2_000,
    finalityConfirmations: () => options.finalityConfirmations ?? 1,
    ...(options.sourceProvider === undefined && options.source === undefined
      ? {}
      : {
          chainEventLogAuthority: options.sourceProvider
            ?? (() => options.source),
        }),
  });
  reader.snapshots.open();
  return { reader, index, calls, authorityLogs, attempts, usage };
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
  it('reads the immutable creation pair atomically with ZERO chain calls', async () => {
    const store = seededStore({
      rows: [creationRow(20, 7n, NAME_HASH, 1)],
    });
    const { reader, calls } = makeReader({ store, source: logSource(store) });

    await expect(reader.readContextGraphFinalizedCreation(7n)).resolves.toEqual({
      nameHash: NAME_HASH,
      accessPolicy: 1,
    });
    expect(calls).toEqual({ getBlock: 0, getLogs: 0, getNetwork: 0 });
  });

  it('requires exactly one canonical creation row for the requested id', async () => {
    const missing = seededStore({
      rows: [creationRow(20, 8n, ABSENT_NAME_HASH, 1)],
    });
    const duplicate = creationRow(21, 7n, NAME_HASH, 1);
    const duplicated = seededStore({
      rows: [
        creationRow(20, 7n, NAME_HASH, 1),
        { ...duplicate, logIndex: 1, transactionHash: hash(0xbb) },
      ],
    });

    await expect(makeReader({
      store: missing,
      source: logSource(missing),
    }).reader.readContextGraphFinalizedCreation(7n)).resolves.toBeUndefined();
    await expect(makeReader({
      store: duplicated,
      source: logSource(duplicated),
    }).reader.readContextGraphFinalizedCreation(7n)).resolves.toBeUndefined();
  });

  it('refuses malformed policy and any pair whose point row disagrees with the projection', async () => {
    const malformed = seededStore({
      rows: [creationRow(20, 7n, NAME_HASH, 2)],
    });
    await expect(makeReader({
      store: malformed,
      source: logSource(malformed),
    }).reader.readContextGraphFinalizedCreation(7n)).resolves.toBeUndefined();

    const store = seededStore();
    const source = logSource(store);
    const { reader } = makeReader({ store, source });
    await expect(reader.readContextGraphFinalizedCreation(7n)).resolves.toEqual({
      nameHash: NAME_HASH,
      accessPolicy: 1,
    });
    seedLog(store, {
      rows: [creationRow(20, 7n, ABSENT_NAME_HASH, 1)],
    });
    await expect(reader.readContextGraphFinalizedCreation(7n)).resolves.toBeUndefined();
  });

  it.each([
    ['returns false', async () => false],
    ['throws', async () => { throw new Error('local fence failed'); }],
  ])('treats anchorHolds that %s as a proof miss', async (_label, anchorHolds) => {
    const store = seededStore();
    const source = { ...logSource(store), anchorHolds };
    const { reader, calls } = makeReader({ store, source });

    await expect(reader.readContextGraphFinalizedCreation(7n)).resolves.toBeUndefined();
    expect(calls).toEqual({ getBlock: 0, getLogs: 0, getNetwork: 0 });
  });

  it('returns a proof miss when the source generation swaps during anchorHolds', async () => {
    const store = seededStore();
    let release!: (value: boolean) => void;
    let markStarted!: () => void;
    const held = new Promise<boolean>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const sourceA = {
      ...logSource(store),
      anchorHolds: () => {
        markStarted();
        return held;
      },
    };
    const sourceB = logSource(store);
    let current: ChainEventLogAuthoritySource | undefined = sourceA;
    const { reader, calls } = makeReader({
      store,
      sourceProvider: () => current,
    });
    const reading = reader.readContextGraphFinalizedCreation(7n);
    await started;
    current = sourceB;
    release(true);

    await expect(reading).resolves.toBeUndefined();
    expect(calls.getLogs).toBe(0);
  });

  it('returns a proof miss when the source rotates during the point-row lookup', async () => {
    const store = seededStore();
    const original = logSource(store);
    let release!: () => void;
    let markStarted!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const sourceA: ChainEventLogAuthoritySource = {
      ...original,
      pageSource: {
        ...original.pageSource,
        async readContextGraphEvents(...args) {
          const events = await original.pageSource.readContextGraphEvents(...args);
          markStarted();
          await held;
          return events;
        },
      },
    };
    const sourceB = logSource(store);
    let current: ChainEventLogAuthoritySource | undefined = sourceA;
    const { reader, calls } = makeReader({
      store,
      sourceProvider: () => current,
    });

    const reading = reader.readContextGraphFinalizedCreation(7n);
    await started;
    current = sourceB;
    release();

    await expect(reading).resolves.toBeUndefined();
    expect(calls.getLogs).toBe(0);
  });

  it('propagates abort after the local fence await without issuing live fallback', async () => {
    const store = seededStore();
    let release!: (value: boolean) => void;
    let markStarted!: () => void;
    const held = new Promise<boolean>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const source = {
      ...logSource(store),
      anchorHolds: () => {
        markStarted();
        return held;
      },
    };
    const { reader, calls } = makeReader({ store, source });
    const controller = new AbortController();

    const reading = reader.readContextGraphFinalizedCreation(7n, {
      signal: controller.signal,
    });
    await started;
    controller.abort(new DOMException('test abort', 'AbortError'));
    release(true);

    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.getLogs).toBe(0);
  });

  it('does not optimize an existing zero-nameHash graph or invent policy zero', async () => {
    const store = seededStore({
      rows: [creationRow(20, 7n, ethers.ZeroHash, 0)],
    });
    const { reader, calls } = makeReader({
      store,
      source: logSource(store),
    });

    await expect(reader.readContextGraphFinalizedCreation(7n)).resolves.toBeUndefined();
    expect(calls.getLogs).toBe(0);
  });

  it('returns a miss when the tick is outside the authority freshness window', async () => {
    const store = seededStore();
    const { reader, calls } = makeReader({
      store,
      source: logSource(store, { nowMs: NOW_MS + 3 * TICK_MS + 1 }),
    });

    await expect(reader.readContextGraphFinalizedCreation(7n)).resolves.toBeUndefined();
    expect(calls.getLogs).toBe(0);
    expect(calls.getBlock).toBe(0);
  });

  it('drops an orphaned creation when same-address lineage resets before the fence', async () => {
    const store = seededStore();
    const original = logSource(store);
    const resetDuringFence: ChainEventLogAuthoritySource = {
      ...original,
      async anchorHolds(anchor) {
        store.seed(SCOPE, {
          cursor: {
            revision: 2,
            lineage: hash(0x02),
            deploymentBlockNumber: DEPLOY_BLOCK,
            settledBlockNumber: HEAD - 50,
            settledBlockHash: hash(HEAD - 50),
            head: {
              number: HEAD,
              hash: hash(HEAD),
              timestampSeconds: HEAD_TIMESTAMP_SECONDS,
              fetchedAtMs: NOW_MS,
            },
            topicSetVersion: 'reset-v2',
          },
          coverage: [{
            family: 'context-graph-authority',
            address: STORAGE,
            coveredFromBlock: DEPLOY_BLOCK,
            coveredThroughBlock: HEAD,
            floorBlock: DEPLOY_BLOCK,
          }],
        }, []);
        return original.anchorHolds(anchor);
      },
    };
    const { reader, calls } = makeReader({ store, source: resetDuringFence });

    await expect(reader.readContextGraphFinalizedCreation(7n)).resolves.toBeUndefined();
    expect(calls.getLogs).toBe(0);
    expect(calls.getBlock).toBe(0);
  });

  it('does not resurrect an old indexed creation after deterministic same-address reset', async () => {
    const store = seededStore();
    const source = logSource(store);
    const { reader, calls } = makeReader({ store, source });
    await expect(reader.readContextGraphFinalizedCreation(7n)).resolves.toEqual({
      nameHash: NAME_HASH,
      accessPolicy: 1,
    });

    // Same heights, hashes, address and numeric id; only the one-log lineage
    // proves this is a different chain instance. The authority checkpoint from
    // the first read is intentionally left in place to exercise the stale
    // durable-prefix mutation the point-row validation closes.
    store.seed(SCOPE, {
      cursor: {
        revision: 2,
        lineage: hash(0x02),
        deploymentBlockNumber: DEPLOY_BLOCK,
        settledBlockNumber: HEAD - 50,
        settledBlockHash: hash(HEAD - 50),
        head: {
          number: HEAD,
          hash: hash(HEAD),
          timestampSeconds: HEAD_TIMESTAMP_SECONDS,
          fetchedAtMs: NOW_MS,
        },
        topicSetVersion: 'reset-v2',
      },
      coverage: [{
        family: 'context-graph-authority',
        address: STORAGE,
        coveredFromBlock: DEPLOY_BLOCK,
        coveredThroughBlock: HEAD,
        floorBlock: DEPLOY_BLOCK,
      }],
    }, []);

    await expect(reader.readContextGraphFinalizedCreation(7n)).resolves.toBeUndefined();
    seedLog(store, {
      rows: [creationRow(20, 7n, NAME_HASH, 0)],
    });
    // The old private checkpoint must not overwrite the new canonical public
    // creation for the same address/id. Until the old checkpoint is rebuilt,
    // the fast lane misses and the caller performs its live pair of reads.
    await expect(reader.readContextGraphFinalizedCreation(7n)).resolves.toBeUndefined();
    expect(calls.getLogs).toBe(0);
    expect(calls.getBlock).toBe(0);
  });

  it('does not replace an old public checkpoint with a current private creation', async () => {
    const store = seededStore({
      rows: [creationRow(20, 7n, NAME_HASH, 0)],
    });
    const source = logSource(store);
    const { reader, calls } = makeReader({ store, source });
    await expect(reader.readContextGraphFinalizedCreation(7n)).resolves.toEqual({
      nameHash: NAME_HASH,
      accessPolicy: 0,
    });

    seedLog(store, {
      rows: [creationRow(20, 7n, NAME_HASH, 1)],
    });
    await expect(reader.readContextGraphFinalizedCreation(7n)).resolves.toBeUndefined();
    expect(calls.getLogs).toBe(0);
    expect(calls.getBlock).toBe(0);
  });

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
    const { reader, calls, authorityLogs, usage } = makeReader({
      store: cold,
      source: logSource(cold),
    });
    authorityLogs.push(liveCreationLog(20, 7n, NAME_HASH));

    expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);
    expect(calls.getLogs).toBeGreaterThan(0);
    expect(calls.getBlock).toBeGreaterThan(0);
    const headerConsumers = usage.drainWindow().attributions
      .filter((entry) => entry.method === 'eth_getBlockByNumber')
      .map((entry) => entry.consumer);
    expect(headerConsumers).toContain('authorityIndex.head');
    expect(headerConsumers).toContain('authorityIndex.stabilize');
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

  it('keeps its live scan at a depth the log anchor would answer STALER than', async () => {
    // The operator raised `chain.finalityConfirmations` to 2 — the first thing
    // anyone does to be safer. The live read would pin head-1; the log can only
    // name its settled boundary, 50 blocks under the head, and an authority
    // roster read 49 blocks stale is how a participant revoked in between stays
    // admitted. Nothing about the rows, the coverage or the clock changed.
    const store = seededStore();
    const { reader, calls, authorityLogs } = makeReader({
      store,
      source: logSource(store),
      finalityConfirmations: 2,
    });
    authorityLogs.push(liveCreationLog(20, 7n, NAME_HASH));

    expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);
    // Fails CLOSED to the scan, never to an error, a 0 or an absence.
    expect(calls.getLogs).toBeGreaterThan(0);

    // And the depth is the ONLY reason: the same store, the same source and the
    // same fold at the default depth still cost nothing.
    const cheap = makeReader({ store, source: logSource(store) });
    expect(await cheap.reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);
    expect(cheap.calls.getLogs).toBe(0);
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

  it('propagates an ambiguity the fold proves, WITHOUT buying a scan first', async () => {
    // The admission predicate is the caller's own projection and it can throw:
    // two finalized creations committing one name hash is a deterministic,
    // fail-closed refusal. Swallowing it (`catch { return false }` reads like
    // hygiene and is the mutation a refactor reintroduces) does not make the
    // read succeed — the live scan's own projection raises the same thing one
    // paid `eth_getLogs` and two `eth_getBlock`s later. The propagation IS the
    // saving, so it is pinned by cost, not only by message.
    const store = seededStore({
      rows: [creationRow(20, 7n, NAME_HASH), creationRow(30, 9n, NAME_HASH)],
    });
    const { reader, calls } = makeReader({ store, source: logSource(store) });

    await expect(reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).rejects.toThrow(
      /name hash 0x3333.* is ambiguous across 2 finalized Context Graphs/,
    );
    expect(calls.getLogs).toBe(0);
    expect(calls.getBlock).toBe(0);
  });

  it('keeps that ambiguity deterministic instead of laundering it into stale authority', async () => {
    // The predicate now runs inside the provider session AND inside the
    // projection cache's `refresh()`, so a naked throw is read by two
    // classifiers that are not about it. `classifyRpcRetryDisposition`
    // alternates a bare `429|503|502|500` with NO word boundaries, and this
    // message interpolates a 32-byte hash — so ~5.9% of name hashes turn a
    // deterministic refusal into `failover`, then `RPC_ENDPOINTS_EXHAUSTED`,
    // which the cache reads as an outage: it arms a scope-wide backoff and
    // serves the RETAINED projection, which (ambiguity grows with the state
    // set) is not ambiguous. A fail-closed check would come back as an answer.
    const clock = { nowMs: NOW_MS };
    // The tick has only reached block 60 so far.
    const store = seededStore({ head: 60, rows: [creationRow(20, 7n, FAILOVER_NAME_HASH)] });
    const evidence: ContextGraphAuthorityProjectionServedEvidence[] = [];
    const served = { onContextGraphAuthorityProjectionServed: (e: typeof evidence[number]) => { evidence.push(e); } };
    const { reader, calls, attempts } = makeReader({
      store,
      source: logSource(store, {
        now: () => clock.nowMs,
        readBlockHash: async (blockNumber) => hash(blockNumber),
      }),
      now: () => clock.nowMs,
      exhaustsOnFailover: true,
    });

    // One unambiguous answer first, so there IS a retained projection for a
    // stale-if-error pass to reach for.
    expect(await reader.resolveFinalizedContextGraphIdByNameHash(FAILOVER_NAME_HASH, served))
      .toBe(7n);

    // A later tick reaches block 105 and brings a SECOND finalized creation
    // committing the same name. The new fold is ambiguous; the projection
    // retained from the first read — which never saw block 70 — is not.
    clock.nowMs = NOW_MS + TICK_MS;
    seedLog(store, {
      fetchedAtMs: clock.nowMs,
      rows: [creationRow(20, 7n, FAILOVER_NAME_HASH), creationRow(70, 9n, FAILOVER_NAME_HASH)],
    });

    for (const pass of [1, 2]) {
      let caught: unknown;
      await reader.resolveFinalizedContextGraphIdByNameHash(FAILOVER_NAME_HASH, served)
        .then(() => { throw new Error(`pass ${pass} was answered instead of refused`); })
        .catch((error: unknown) => { caught = error; });
      expect((caught as Error).message).toMatch(/is ambiguous across 2 finalized Context Graphs/);
      // The caller's own error, not a transport verdict wrapped around it.
      expect((caught as { code?: string }).code).toBeUndefined();
    }
    // The explicit fault result crosses the provider session as data, so the
    // transport classifier is never invoked at all. The second pass proves no
    // cache backoff was armed — one would serve the retained projection.
    expect(attempts).toHaveLength(0);
    expect(evidence.map((e) => e.source)).not.toContain('stale-cache');
    expect(calls.getLogs).toBe(0);
  });

  it('ages a log fold from the TICK fetch, so it cannot be re-served as fresh', async () => {
    // The fold's data is as of the tick's head fetch, not as of this read.
    // Retaining it under `now` resets its age to zero and buys it a further T
    // of service as a FRESH cache entry, so a view already `max(3T,15s)` behind
    // the chain can be served for `max(3T,15s) + T` while every consumer is
    // told it is under T old.
    const clock = { nowMs: NOW_MS };
    const store = seededStore({ fetchedAtMs: NOW_MS - 5_000 });
    const evidence: ContextGraphAuthorityProjectionServedEvidence[] = [];
    const served = { onContextGraphAuthorityProjectionServed: (e: typeof evidence[number]) => { evidence.push(e); } };
    const { reader, calls } = makeReader({
      store,
      source: logSource(store, { now: () => clock.nowMs }),
      now: () => clock.nowMs,
    });

    expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH, served)).toBe(7n);
    expect(evidence).toEqual([{ source: 'log', ageMs: 5_000 }]);

    // 1.5s later the fold is 6.5s old — past the tick the cache answers within.
    clock.nowMs = NOW_MS + 1_500;
    expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH, served)).toBe(7n);
    expect(evidence[1]).toEqual({ source: 'log', ageMs: 6_500 });
    // Truthfulness is not paid for in RPC: both reads still cost nothing.
    expect(evidence.map((e) => e.source)).not.toContain('cache');
    expect(calls.getLogs).toBe(0);
    expect(calls.getBlock).toBe(0);
  });

  it('never reports a fold as a scan, whether it is fresh, retained or both', async () => {
    // `scan` is the ONE member that means "this read exercised the RPC pool",
    // and the RFC-64 authority circuit breaker closes on it unconditionally.
    // A fold exercises nothing, so it may not carry that word on any path out
    // of the cache — not from `#refresh`, and not from `#serve` one read later
    // when the retained fold is still inside the tick and would otherwise be
    // relabelled `cache` (which the breaker credits whenever the fetch
    // post-dates the outage).
    const clock = { nowMs: NOW_MS };
    // 1s old: comfortably inside T, so `#serve` would call the retained entry
    // FRESH and the `cache` relabel is live rather than hypothetical.
    const store = seededStore({ fetchedAtMs: NOW_MS - 1_000 });
    const evidence: ContextGraphAuthorityProjectionServedEvidence[] = [];
    const served = { onContextGraphAuthorityProjectionServed: (e: typeof evidence[number]) => { evidence.push(e); } };
    const { reader, calls } = makeReader({
      store,
      source: logSource(store, { now: () => clock.nowMs }),
      now: () => clock.nowMs,
    });

    // Pass 1 folds and publishes; pass 2 is answered by `#serve` from what
    // pass 1 retained — no second anchor resolution, no second fold.
    expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH, served)).toBe(7n);
    clock.nowMs = NOW_MS + 500;
    expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH, served)).toBe(7n);

    expect(evidence).toEqual([
      { source: 'log', ageMs: 1_000 },
      { source: 'log', ageMs: 1_500 },
    ]);
    // Both ages are under T, so the second answer really did take the `fresh`
    // branch of `#serve` — it is `log` because of its PROVENANCE, not because
    // it aged out into `stale-cache`.
    expect(evidence.every((e) => e.ageMs < 6_000)).toBe(true);
    expect(calls.getLogs).toBe(0);
    expect(calls.getBlock).toBe(0);
  });

  describe('retained log-fold anchor validation', () => {
    const retainedHead = DEPLOY_BLOCK + 600;

    it('accepts a checksummed live binding against the lowercase log source without an RPC',
      async () => {
        const store = seededStore({ head: retainedHead });
        const original = logSource(store);
        const anchorHolds = vi.fn(original.anchorHolds.bind(original));
        const source = { ...original, anchorHolds };
        const { reader, calls } = makeReader({
          store,
          source,
          // Production receives this address from an ABI-decoded Hub call;
          // ethers preserves its checksum case on Contract.getAddress(). The
          // one-log source is deliberately lowercase.
          contractAddress: ethers.getAddress(STORAGE),
        });

        expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);
        const networkCallsAfterFold = calls.getNetwork;
        expect(networkCallsAfterFold).toBe(1);
        expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);

        // First call stabilizes the fold. The unchanged network-read counter
        // proves the second call served that retained projection rather than
        // silently re-folding the log (which resolves chain id again).
        expect(calls.getNetwork).toBe(networkCallsAfterFold);
        expect(anchorHolds).toHaveBeenCalledTimes(2);
        expect(calls.getBlock).toBe(0);
        expect(calls.getLogs).toBe(0);
      });

    it('falls back to the provider when the local revision moved', async () => {
      const store = seededStore({ head: retainedHead });
      const original = logSource(store);
      let current: ChainEventLogAuthoritySource | undefined = original;
      const { reader, calls } = makeReader({
        store,
        sourceProvider: () => current,
      });
      expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);

      const moved = vi.fn(async () => false);
      current = { ...original, anchorHolds: moved };
      expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);

      expect(moved).toHaveBeenCalledTimes(1);
      expect(calls.getBlock).toBe(1);
      expect(calls.getLogs).toBe(0);
    });

    it('falls back to the provider when the current source belongs to another contract',
      async () => {
        const store = seededStore({ head: retainedHead });
        const original = logSource(store);
        let current: ChainEventLogAuthoritySource | undefined = original;
        const { reader, calls } = makeReader({
          store,
          sourceProvider: () => current,
        });
        expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);

        const rotatedAnchorHolds = vi.fn(async () => true);
        current = {
          ...original,
          contractAddress: ROTATED_STORAGE,
          anchorHolds: rotatedAnchorHolds,
        };
        expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);

        expect(rotatedAnchorHolds).not.toHaveBeenCalled();
        expect(calls.getBlock).toBe(1);
        expect(calls.getLogs).toBe(0);
      });

    it('falls back for a retained pre-anchor log origin', async () => {
      const store = seededStore({ head: retainedHead });
      const source = logSource(store);
      const { reader, index, calls } = makeReader({ store, source });
      expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);

      // Projection caches are process-local, but the origin field stays
      // optional for older/direct hosts. Wrap the real cache so the public
      // reader exercises that compatibility shape through its actual
      // validateAnchor callback.
      const project = index.projection.bind(index);
      vi.spyOn(index, 'projection').mockImplementation(async (input) => project({
        ...input,
        validateAnchor: async (cached) => input.validateAnchor!({
          ...cached,
          origin: Object.freeze({
            kind: 'log' as const,
            dataFetchedAtMs: cached.origin.kind === 'log'
              ? cached.origin.dataFetchedAtMs
              : cached.fetchedAtMs,
          }),
        }),
      }));

      expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);
      expect(calls.getBlock).toBe(1);
      expect(calls.getLogs).toBe(0);
    });

    it('falls back when the optional local anchor proof rejects', async () => {
      const store = seededStore({ head: retainedHead });
      const original = logSource(store);
      let current: ChainEventLogAuthoritySource | undefined = original;
      const { reader, calls } = makeReader({
        store,
        sourceProvider: () => current,
      });
      expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);

      const rejected = vi.fn(async () => { throw new Error('local index unavailable'); });
      current = { ...original, anchorHolds: rejected };
      expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);

      expect(rejected).toHaveBeenCalledTimes(1);
      expect(calls.getBlock).toBe(1);
      expect(calls.getLogs).toBe(0);
    });

    it('honours caller abort after the local proof await without provider fallback', async () => {
      const store = seededStore({ head: retainedHead });
      const original = logSource(store);
      let current: ChainEventLogAuthoritySource | undefined = original;
      const { reader, calls } = makeReader({
        store,
        sourceProvider: () => current,
      });
      expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);

      let release!: (value: boolean) => void;
      let markStarted!: () => void;
      const held = new Promise<boolean>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      current = {
        ...original,
        anchorHolds: () => {
          markStarted();
          return held;
        },
      };
      const controller = new AbortController();
      const reading = reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH, {
        signal: controller.signal,
      });
      await started;
      controller.abort(new DOMException('test abort', 'AbortError'));
      release(true);

      await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls.getBlock).toBe(0);
    });

    // The bounded peek validates a retained fold through its OWN copy of the
    // anchor check. Without the log short-circuit there, a caller that asked
    // for bounded freshness to skip one `eth_call` would pay an
    // `eth_getBlockByNumber` that the escalating read above never spends.
    it('lets a bounded peek prove the retained fold from the log without an RPC', async () => {
      const store = seededStore({ head: retainedHead });
      const original = logSource(store);
      const anchorHolds = vi.fn(original.anchorHolds.bind(original));
      const { reader, calls } = makeReader({ store, source: { ...original, anchorHolds } });
      expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);
      const anchorChecksAfterFold = anchorHolds.mock.calls.length;

      expect(await reader.peekContextGraphLiveAuthority(7n)).toEqual({
        active: true,
        accessPolicy: 1,
        participantAgents: [OWNER],
      });

      expect(anchorHolds).toHaveBeenCalledTimes(anchorChecksAfterFold + 1);
      expect(calls.getBlock).toBe(0);
      expect(calls.getLogs).toBe(0);
    });

    it('lets a bounded peek fall back to the provider when the local revision moved',
      async () => {
        const store = seededStore({ head: retainedHead });
        const original = logSource(store);
        let current: ChainEventLogAuthoritySource | undefined = original;
        const { reader, calls } = makeReader({
          store,
          sourceProvider: () => current,
        });
        expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);

        const moved = vi.fn(async () => false);
        current = { ...original, anchorHolds: moved };
        expect(await reader.peekContextGraphLiveAuthority(7n)).toEqual({
          active: true,
          accessPolicy: 1,
          participantAgents: [OWNER],
        });

        // The provider confirms the anchor, so the retained fold is served:
        // one block read, never a rescan.
        expect(moved).toHaveBeenCalledTimes(1);
        expect(calls.getBlock).toBe(1);
        expect(calls.getLogs).toBe(0);
      });

    it('honours caller abort after the peek local proof await without provider fallback',
      async () => {
        const store = seededStore({ head: retainedHead });
        const original = logSource(store);
        let current: ChainEventLogAuthoritySource | undefined = original;
        const { reader, calls } = makeReader({
          store,
          sourceProvider: () => current,
        });
        expect(await reader.resolveFinalizedContextGraphIdByNameHash(NAME_HASH)).toBe(7n);

        let release!: (value: boolean) => void;
        let markStarted!: () => void;
        const held = new Promise<boolean>((resolve) => { release = resolve; });
        const started = new Promise<void>((resolve) => { markStarted = resolve; });
        current = {
          ...original,
          anchorHolds: () => {
            markStarted();
            return held;
          },
        };
        const controller = new AbortController();
        const peeking = reader.peekContextGraphLiveAuthority(7n, { signal: controller.signal });
        await started;
        controller.abort(new DOMException('test abort', 'AbortError'));
        release(true);

        await expect(peeking).rejects.toMatchObject({ name: 'AbortError' });
        expect(calls.getBlock).toBe(0);
      });
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
