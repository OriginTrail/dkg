// SPDX-License-Identifier: Apache-2.0

/**
 * What one durable authority-index walk costs when reads keep arriving faster
 * than a throttled RPC budget can serve it.
 *
 * The walk is the paged scan from the durable cursor to a read's anchor. It is
 * cheap when the cursor is near the head and long after a rebuild. Reads arrive
 * every second with a newer anchor, every chain read takes a permit from a
 * throttled `RpcRequestGovernor`, and each caller gives up after a few seconds
 * while the walk it started runs on, owned by the index lifecycle. That is the
 * load a core node sees once the walk takes longer than its readers wait.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextGraphAuthorityIndex } from '../src/context-graph-authority-index.js';
import { CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS } from
  '../src/context-graph-authority-index-projection.js';
import type { ContextGraphAuthorityIndexId } from '../src/chain-adapter.js';
import type { RawContextGraphAuthorityIndexEvent } from
  '../src/context-graph-authority-index-reducer.js';
import { RpcRequestGovernor } from '../src/rpc-request-governor.js';
import { withRpcRequestContext } from '../src/rpc-request-transport.js';
import { MemoryAuthorityIndexStore } from './helpers/context-graph-authority-index.js';

const OWNER = `0x${'11'.repeat(20)}`;
const AUTHORITY = `0x${'33'.repeat(20)}`;
const SCOPE = 'evm:84532:hub:context-graph-storage';
const DEPLOY_BLOCK = 1_000;
const PAGE_SIZE = 200;
const HOLDBACK = 10;
/** The head at t=0 and how fast it moves: five blocks a second. */
const START_HEAD = 5_000;
const MS_PER_BLOCK = 200;
/** A new read arrives every second and gives up after four, like the node's admission deadline. */
const READ_INTERVAL_MS = 1_000;
const CALLER_DEADLINE_MS = 4_000;
const READS = 60;

const blockHash = (block: number): string => `0x${block.toString(16).padStart(64, '0')}`;

function creation(contextGraphId: bigint, blockNumber: number): RawContextGraphAuthorityIndexEvent {
  return {
    name: 'ContextGraphCreated',
    contextGraphId,
    blockNumber,
    blockHash: blockHash(blockNumber),
    index: 0,
    owner: OWNER,
    nameHash: `0x${contextGraphId.toString(16).padStart(64, '0')}`,
    participantAgents: [OWNER],
    accessPolicy: 1,
    publishPolicy: 0,
    publishAuthority: AUTHORITY,
    publishAuthorityAccountId: 7n,
  } as RawContextGraphAuthorityIndexEvent;
}

/** One graph every 500 blocks of history, so every page has something to fold. */
const EVENTS = Array.from({ length: 20 }, (_, offset) => (
  creation(BigInt(offset + 1), DEPLOY_BLOCK + 250 + offset * 500)
));

afterEach(() => {
  vi.useRealTimers();
});

interface WalkCost {
  readonly pageReads: number;
  readonly blockReads: number;
  readonly invalidations: number;
  readonly maxConcurrentPageReads: number;
  readonly cursor: number | undefined;
  readonly lastAnchor: number;
}

/**
 * Drive {@link READS} readers through one index and report what the chain was
 * asked for. Every page and block-hash read waits for a permit from a governor
 * that admits two requests a second, so a page costs about a second of budget
 * on its own and a walk from the deployment block costs about twenty.
 */
async function driveReaders(store: MemoryAuthorityIndexStore): Promise<WalkCost> {
  vi.useFakeTimers();
  const governor = new RpcRequestGovernor({
    maxRequestsPerSecond: 2,
    burstRequests: 1,
    maxQueueSize: 4_096,
    startupJitterMs: 0,
  });
  const index = new ContextGraphAuthorityIndex(store);
  const readScope = {};
  const startedAt = Date.now();
  const head = () => START_HEAD + Math.floor((Date.now() - startedAt) / MS_PER_BLOCK);
  let pageReads = 0;
  let blockReads = 0;
  let pageReadsInFlight = 0;
  let maxConcurrentPageReads = 0;
  let lastAnchor = 0;

  const read = (): Promise<unknown> => {
    const anchor = head();
    lastAnchor = anchor;
    const caller = new AbortController();
    const deadline = setTimeout(() => caller.abort(new Error('caller deadline')), CALLER_DEADLINE_MS);
    return index.view({
      scope: SCOPE,
      readScope,
      deploymentBlockNumber: DEPLOY_BLOCK,
      finalized: { number: anchor, hash: blockHash(anchor) },
      pageSize: PAGE_SIZE,
      durableReorgHoldbackBlocks: HOLDBACK,
      signal: caller.signal,
      readBlockHash: async (blockNumber, lifecycleSignal) => {
        await governor.acquireActiveRequest(lifecycleSignal);
        blockReads += 1;
        return blockHash(blockNumber);
      },
      readPage: async (fromBlock, toBlock, lifecycleSignal) => {
        pageReadsInFlight += 1;
        maxConcurrentPageReads = Math.max(maxConcurrentPageReads, pageReadsInFlight);
        try {
          await governor.acquireActiveRequest(lifecycleSignal);
          pageReads += 1;
          return EVENTS.filter((entry) => (
            entry.blockNumber >= fromBlock && entry.blockNumber <= toBlock
          ));
        } finally {
          pageReadsInFlight -= 1;
        }
      },
    }).catch(() => undefined).finally(() => clearTimeout(deadline));
  };

  const reads: Promise<unknown>[] = [];
  for (let started = 0; started < READS; started += 1) {
    reads.push(read());
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS);
  }
  // Every caller has given up by now; give the walks they left behind the
  // same budget again to finish, then stop whatever is still running.
  await vi.advanceTimersByTimeAsync(READS * READ_INTERVAL_MS);
  await Promise.all(reads);
  const cursor = (store.record?.value as { cursor?: { throughBlockNumber?: number } } | null)
    ?.cursor?.throughBlockNumber;
  index.clear();
  await vi.advanceTimersByTimeAsync(10_000);
  await index.whenIdle();
  return {
    pageReads,
    blockReads,
    invalidations: store.invalidations.length,
    maxConcurrentPageReads,
    cursor,
    lastAnchor,
  };
}

/** One read of the index at `anchor`, against chain data that answers at once. */
function directRead(anchor: number, overrides: Partial<{
  readPage: (
    fromBlock: number,
    toBlock: number,
    lifecycleSignal: AbortSignal,
  ) => Promise<readonly RawContextGraphAuthorityIndexEvent[]>;
  signal: AbortSignal;
  readScope: object;
}> = {}) {
  return {
    scope: SCOPE,
    readScope: overrides.readScope ?? {},
    deploymentBlockNumber: DEPLOY_BLOCK,
    finalized: { number: anchor, hash: blockHash(anchor) },
    pageSize: PAGE_SIZE,
    durableReorgHoldbackBlocks: HOLDBACK,
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    readBlockHash: async (blockNumber: number) => blockHash(blockNumber),
    readPage: overrides.readPage ?? (async (fromBlock: number, toBlock: number) => EVENTS.filter((entry) => (
      entry.blockNumber >= fromBlock && entry.blockNumber <= toBlock
    ))),
  };
}

/**
 * Each scan admits its starting record with at most one block-hash read, and
 * each page costs at most one more for its end. A block read beyond that is a
 * re-admission after losing a commit race to a walk running beside it.
 */
function expectNoReadmissionStorm(cost: WalkCost): void {
  expect(cost.blockReads).toBeLessThanOrEqual(cost.pageReads + READS);
}

describe('durable authority-index walks under a throttled RPC budget', () => {
  it('walks the history once, never in parallel, and catches up with the head', async () => {
    const store = new MemoryAuthorityIndexStore();

    const cost = await driveReaders(store);

    // Before: every read started its own walk beside the others (29 at once),
    // three in four requests re-admitted a commit another walk had won, and
    // in two minutes the cursor covered 7 of the 22 pages to the head.
    expect(cost.maxConcurrentPageReads).toBe(1);
    expectNoReadmissionStorm(cost);
    expect(cost.invalidations).toBe(0);
    // Caught up: within one read interval of the last anchor, less the holdback.
    expect(cost.cursor).toBeGreaterThanOrEqual(
      cost.lastAnchor - HOLDBACK - READ_INTERVAL_MS / MS_PER_BLOCK,
    );
  });

  it('resumes a far-behind durable cursor with one walk, as a restarted node does', async () => {
    const store = new MemoryAuthorityIndexStore();
    // A first pass already reduced most of the history, as a node that was
    // restarted mid-walk has.
    await new ContextGraphAuthorityIndex(store).view(directRead(3_000));

    const cost = await driveReaders(store);

    expect(cost.maxConcurrentPageReads).toBe(1);
    expectNoReadmissionStorm(cost);
    expect(cost.invalidations).toBe(0);
    expect(cost.cursor).toBeGreaterThanOrEqual(
      cost.lastAnchor - HOLDBACK - READ_INTERVAL_MS / MS_PER_BLOCK,
    );
  });

  it('keeps a cursor it proved when a read is anchored far below it', async () => {
    const store = new MemoryAuthorityIndexStore();
    const index = new ContextGraphAuthorityIndex(store);
    await index.view(directRead(3_000));
    const proven = store.record;

    // A lagging endpoint, or a read that waited behind the walk with the
    // anchor it read before, lands 200 blocks below the cursor this index
    // wrote a moment ago. That is a stale anchor, not a dead chain view: the
    // read is refused for retry and the history is kept.
    await expect(index.view(directRead(2_790))).rejects.toMatchObject({ reason: 'cursor-ahead' });
    expect(store.invalidations).toEqual([]);
    expect(store.record).toBe(proven);
  });

  it('gives a cursor it has not proven yet a current anchor before any rebuild, as after a restart', async () => {
    vi.useFakeTimers();
    const store = new MemoryAuthorityIndexStore();
    await new ContextGraphAuthorityIndex(store).view(directRead(3_000));
    const reduced = store.record;
    const restarted = new ContextGraphAuthorityIndex(store);

    // The first read after a restart meets an endpoint 200 blocks behind: a
    // few tens of seconds of lag on a chain that makes five blocks a second.
    await expect(restarted.view(directRead(2_790))).rejects.toMatchObject({ reason: 'cursor-ahead' });
    // The next read, at a current anchor, admits the history as it stands.
    let pages = 0;
    await restarted.view(directRead(3_005, {
      readPage: async () => {
        pages += 1;
        return [];
      },
    }));
    expect(store.invalidations).toEqual([]);
    expect(pages).toBe(2);
    expect((store.record!.value as { cursor: { deploymentBlockNumber: number } }).cursor)
      .toMatchObject({ deploymentBlockNumber: DEPLOY_BLOCK });
    expect(store.record!.token).toBe(reduced!.token + 1);

    // A cursor that no anchor reaches for the whole head tolerance belongs to
    // a chain view that is gone (a copied store, a reset at the same address).
    const copied = new ContextGraphAuthorityIndex(store);
    await expect(copied.view(directRead(2_000))).rejects.toMatchObject({ reason: 'cursor-ahead' });
    await vi.advanceTimersByTimeAsync(CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS);
    await copied.view(directRead(2_000));
    expect(store.invalidations).toHaveLength(1);
  });

  it('rebuilds a chain reset under a running node once no read has reached its cursor for five minutes', async () => {
    vi.useFakeTimers();
    const store = new MemoryAuthorityIndexStore();
    const index = new ContextGraphAuthorityIndex(store);
    await index.view(directRead(3_000));

    // Every anchor after the reset is far below the cursor committed just before it.
    await expect(index.view(directRead(2_790))).rejects.toMatchObject({ reason: 'cursor-ahead' });
    await vi.advanceTimersByTimeAsync(CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS - 1_000);
    await expect(index.view(directRead(2_790))).rejects.toMatchObject({ reason: 'cursor-ahead' });
    expect(store.invalidations).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_001);
    await index.view(directRead(2_790));
    expect(store.invalidations).toHaveLength(1);
  });

  it('starts the out-of-reach clock again when the wall clock steps back', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10 * CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS);
    const store = new MemoryAuthorityIndexStore();
    await new ContextGraphAuthorityIndex(store).view(directRead(3_000));
    const copied = new ContextGraphAuthorityIndex(store);
    await expect(copied.view(directRead(2_000))).rejects.toMatchObject({ reason: 'cursor-ahead' });

    // Stepping back by more than the tolerance proves no elapsed time at all.
    vi.setSystemTime(Date.now() - 2 * CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS);
    await expect(copied.view(directRead(2_000))).rejects.toMatchObject({ reason: 'cursor-ahead' });
    await vi.advanceTimersByTimeAsync(CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS - 1);
    await expect(copied.view(directRead(2_000))).rejects.toMatchObject({ reason: 'cursor-ahead' });
    expect(store.invalidations).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await copied.view(directRead(2_000));
    expect(store.invalidations).toHaveLength(1);
  });

  it('rebuilds from the lookup bound when admission rejects the history a stored deployment block came from', async () => {
    const store = new MemoryAuthorityIndexStore();
    await new ContextGraphAuthorityIndex(store).view(directRead(1_500));
    // A reset chain at the same address: the contract now dates from block
    // 100, a graph was created at block 200, and every block hash differs.
    const resetHash = (block: number): string => `0x${(block + 0xabcdef).toString(16).padStart(64, '0')}`;
    const resetCreation = { ...creation(42n, 200), blockHash: resetHash(200) };
    const pages: Array<readonly [number, number]> = [];

    // The reader's bounds for an unpinned lookup whose stored block is below the anchor.
    const view = await new ContextGraphAuthorityIndex(store).view({
      ...directRead(2_000),
      finalized: { number: 2_000, hash: resetHash(2_000) },
      deploymentBlockNumber: DEPLOY_BLOCK,
      rebuildFromBlockNumber: 0,
      readBlockHash: async (blockNumber: number) => resetHash(blockNumber),
      readPage: async (fromBlock: number, toBlock: number) => {
        pages.push([fromBlock, toBlock]);
        return resetCreation.blockNumber >= fromBlock && resetCreation.blockNumber <= toBlock
          ? [resetCreation]
          : [];
      },
    });

    expect(store.invalidations).toHaveLength(1);
    expect(pages[0]).toEqual([0, PAGE_SIZE - 1]);
    expect(view.has('42' as ContextGraphAuthorityIndexId)).toBe(true);
    expect((store.record!.value as { cursor: { deploymentBlockNumber: number } }).cursor)
      .toMatchObject({ deploymentBlockNumber: 0 });
  });

  it('resumes from the stored deployment block while admission keeps its checkpoint', async () => {
    const store = new MemoryAuthorityIndexStore();
    await new ContextGraphAuthorityIndex(store).view(directRead(1_500));
    const pages: Array<readonly [number, number]> = [];

    await new ContextGraphAuthorityIndex(store).view({
      ...directRead(1_600),
      rebuildFromBlockNumber: 0,
      readPage: async (fromBlock: number, toBlock: number) => {
        pages.push([fromBlock, toBlock]);
        return [];
      },
    });

    expect(store.invalidations).toEqual([]);
    expect(pages[0]?.[0]).toBe(1_500 - HOLDBACK + 1);
    expect((store.record!.value as { cursor: { deploymentBlockNumber: number } }).cursor)
      .toMatchObject({ deploymentBlockNumber: DEPLOY_BLOCK });
  });

  for (const provider of ['the same', 'another'] as const) {
    it(`does not hold a foreground read behind a background-refresh walk on ${provider} endpoint`, async () => {
      // A scan's requests keep the class of the caller that started it, and
      // the background class runs on the smaller share of the budget. The
      // core's background refresh is the first reader after a restart. In
      // production one endpoint serves both classes, so the foreground read
      // must not join the background walk at the same anchor either.
      const store = new MemoryAuthorityIndexStore();
      const index = new ContextGraphAuthorityIndex(store);
      const backgroundScope = {};
      const foregroundScope = provider === 'the same' ? backgroundScope : {};
      const backgroundEntered = Promise.withResolvers<void>();
      const releaseBackground = Promise.withResolvers<void>();
      const background = withRpcRequestContext({ requestClass: 'background' }, () => index.view(
        directRead(3_000, {
          readScope: backgroundScope,
          readPage: async (fromBlock, toBlock) => {
            backgroundEntered.resolve();
            await releaseBackground.promise;
            return EVENTS.filter((entry) => entry.blockNumber >= fromBlock && entry.blockNumber <= toBlock);
          },
        }),
      ));
      await backgroundEntered.promise;

      await expect(index.view(directRead(3_000, { readScope: foregroundScope }))).resolves.toBeDefined();
      releaseBackground.resolve();
      await expect(background).resolves.toBeDefined();
      expect(store.invalidations).toEqual([]);
      expect((store.record!.value as { cursor: { throughBlockNumber: number } }).cursor)
        .toMatchObject({ throughBlockNumber: 3_000 - HOLDBACK });
    });
  }

  it('rejects a queued scan when the index is cleared while it waits', async () => {
    const store = new MemoryAuthorityIndexStore();
    const index = new ContextGraphAuthorityIndex(store);
    const walkEntered = Promise.withResolvers<void>();
    const walk = index.view(directRead(3_000, {
      readPage: async (_fromBlock, _toBlock, lifecycleSignal) => {
        walkEntered.resolve();
        // A page that only ends with the lifecycle, as an owned RPC read does.
        return new Promise<never>((_resolve, reject) => {
          lifecycleSignal.addEventListener('abort', () => reject(lifecycleSignal.reason), { once: true });
        });
      },
    }));
    await walkEntered.promise;
    let queuedPages = 0;
    const queued = index.view(directRead(3_005, {
      readPage: async () => {
        queuedPages += 1;
        return [];
      },
    }));
    const idle = index.whenScanIdle(SCOPE);

    // A Hub rotation or chain reconfiguration: neither the running scan nor a
    // read prepared before it may go on into the new lifecycle.
    index.clear();

    const settled = await Promise.allSettled([walk, queued, idle]);
    expect(settled.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    for (const result of settled) {
      expect((result as PromiseRejectedResult).reason).toMatchObject({ name: 'AbortError' });
    }
    expect(queuedPages).toBe(0);
    expect(store.commits).toEqual([]);
  });

  it('lets a caller leave the line without leaving a scan behind', async () => {
    const store = new MemoryAuthorityIndexStore();
    const index = new ContextGraphAuthorityIndex(store);
    const walkEntered = Promise.withResolvers<void>();
    const releaseWalk = Promise.withResolvers<void>();
    let walkPages = 0;
    const walk = index.view(directRead(3_000, {
      readPage: async (fromBlock, toBlock) => {
        walkPages += 1;
        if (walkPages === 1) {
          walkEntered.resolve();
          await releaseWalk.promise;
        }
        return EVENTS.filter((entry) => entry.blockNumber >= fromBlock && entry.blockNumber <= toBlock);
      },
    }));
    await walkEntered.promise;

    const caller = new AbortController();
    let abandonedPages = 0;
    const abandoned = index.view(directRead(3_005, {
      signal: caller.signal,
      readPage: async () => {
        abandonedPages += 1;
        return [];
      },
    }));
    const idleWait = new AbortController();
    const idle = index.whenScanIdle(SCOPE, idleWait.signal);
    caller.abort(new Error('caller deadline'));
    idleWait.abort(new Error('idle wait deadline'));
    await expect(abandoned).rejects.toThrow('caller deadline');
    await expect(idle).rejects.toThrow('idle wait deadline');

    releaseWalk.resolve();
    await walk;
    await index.whenScanIdle(SCOPE);
    await index.whenIdle();
    expect(abandonedPages).toBe(0);
    expect((store.record!.value as { cursor: { throughBlockNumber: number } }).cursor)
      .toMatchObject({ throughBlockNumber: 3_000 - HOLDBACK });
  });
});
