// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  ContextGraphAuthorityHistoryCache,
  classifyContextGraphAuthorityCheckpoint,
  decodeContextGraphAuthorityHistoryCheckpoint,
  encodeContextGraphAuthorityHistoryCheckpoint,
  normalizeContextGraphAuthorityHistoryState,
  resolveContextGraphAuthorityHistory,
  type ContextGraphAuthorityHistoryCreationEvent,
  type ContextGraphAuthorityHistoryEvent,
  type ContextGraphAuthorityHistoryEventName,
  type ContextGraphAuthorityHistoryState,
  type ContextGraphAuthorityHistoryStore,
  type ResolveContextGraphAuthorityHistoryInput,
} from '../src/context-graph-authority-history.js';
import { readAdaptiveEvmLogRange } from '../src/evm-log-range.js';

const FINALIZED_HASH = `0x${'55'.repeat(32)}`;
const NEXT_FINALIZED_HASH = `0x${'56'.repeat(32)}`;
const NAME_HASH = `0x${'88'.repeat(32)}`;
const DIRECT_READ_SCOPE = {};

describe('Context Graph authority checkpoint admission policy', () => {
  const checkpoint: ContextGraphAuthorityHistoryState = {
    throughBlockNumber: 30,
    throughBlockHash: FINALIZED_HASH,
    nameHash: NAME_HASH,
    ownershipEra: 1,
    policyVersion: 2,
    rosterVersion: 3,
    sourceBlockNumber: 30,
    sourceBlockHash: FINALIZED_HASH,
  };

  it('makes warm, future, unverifiable, and stale actions explicit', () => {
    expect(classifyContextGraphAuthorityCheckpoint(
      checkpoint, { number: 30, hash: FINALIZED_HASH }, FINALIZED_HASH,
    )).toEqual({ kind: 'warm', state: checkpoint });
    expect(classifyContextGraphAuthorityCheckpoint(
      checkpoint, { number: 20, hash: NEXT_FINALIZED_HASH }, null,
    )).toEqual({
      kind: 'cold', reason: 'ahead', invalidateMemory: false, invalidateDurable: false,
    });
    expect(classifyContextGraphAuthorityCheckpoint(
      checkpoint, { number: 35, hash: NEXT_FINALIZED_HASH }, null,
    )).toEqual({
      kind: 'cold', reason: 'unverifiable', invalidateMemory: true, invalidateDurable: false,
    });
    expect(classifyContextGraphAuthorityCheckpoint(
      checkpoint, { number: 35, hash: NEXT_FINALIZED_HASH }, NEXT_FINALIZED_HASH,
    )).toEqual({
      kind: 'cold', reason: 'stale', invalidateMemory: true, invalidateDurable: true,
    });
  });
});

class MemoryHistoryStore implements ContextGraphAuthorityHistoryStore {
  readonly checkpoints = new Map<string, unknown>();
  readonly deleted: string[] = [];

  async load(cacheKey: string): Promise<unknown> {
    return this.checkpoints.get(cacheKey);
  }

  async save(cacheKey: string, checkpoint: unknown): Promise<void> {
    this.checkpoints.set(cacheKey, checkpoint);
  }

  async delete(cacheKey: string): Promise<void> {
    this.deleted.push(cacheKey);
    this.checkpoints.delete(cacheKey);
  }

  state(cacheKey: string): ContextGraphAuthorityHistoryState | undefined {
    return decodeContextGraphAuthorityHistoryCheckpoint(this.checkpoints.get(cacheKey));
  }
}

class DelayedHistoryStore extends MemoryHistoryStore {
  readonly saveEntered = Promise.withResolvers<void>();
  readonly releaseSave = Promise.withResolvers<void>();
  readonly deleteEntered = Promise.withResolvers<void>();
  readonly releaseDelete = Promise.withResolvers<void>();
  delayNextSave = false;
  delayNextDelete = false;

  override async save(cacheKey: string, checkpoint: unknown): Promise<void> {
    if (this.delayNextSave) {
      this.delayNextSave = false;
      this.saveEntered.resolve();
      await this.releaseSave.promise;
    }
    await super.save(cacheKey, checkpoint);
  }

  override async delete(cacheKey: string): Promise<void> {
    if (this.delayNextDelete) {
      this.delayNextDelete = false;
      this.deleteEntered.resolve();
      await this.releaseDelete.promise;
    }
    await super.delete(cacheKey);
  }
}

function cacheWithStore(store: ContextGraphAuthorityHistoryStore) {
  return new ContextGraphAuthorityHistoryCache(
    1_024,
    store,
  );
}

function directHistoryInput(params: Readonly<{
  cache: ContextGraphAuthorityHistoryCache;
  cacheKey: string;
  blockNumber: number;
  blockHash: string;
  coldReads?: { count: number };
  ordinaryRanges?: Array<readonly [number, number]>;
  blockHashes?: Readonly<Record<number, string>>;
  readBlockHash?: (blockNumber: number) => Promise<string | null>;
  creationGate?: Readonly<{ entered(): void; wait: Promise<void> }>;
  readScope?: object;
  signal?: AbortSignal;
  omitCreationNameHash?: boolean;
  rangeLimit?: number;
  rangeAttempts?: { count: number };
  readConcurrency?: { active: number; peak: number };
  events?: Partial<Record<ContextGraphAuthorityHistoryEventName,
    readonly ContextGraphAuthorityHistoryEvent[]>>;
}>): ResolveContextGraphAuthorityHistoryInput {
  const enforceRangeLimit = (fromBlock: number, toBlock: number) => {
    if (params.rangeAttempts) params.rangeAttempts.count += 1;
    if (params.rangeLimit !== undefined && toBlock - fromBlock + 1 > params.rangeLimit) {
      throw new Error(
        `Block range too large: maximum allowed is ${params.rangeLimit} blocks`,
      );
    }
  };
  const trackRead = async <T>(read: () => T): Promise<T> => {
    if (params.readConcurrency === undefined) return read();
    params.readConcurrency.active += 1;
    params.readConcurrency.peak = Math.max(
      params.readConcurrency.peak,
      params.readConcurrency.active,
    );
    await Promise.resolve();
    try {
      return read();
    } finally {
      params.readConcurrency.active -= 1;
    }
  };
  const adaptiveRead = <T>(
    read: (fromBlock: number, toBlock: number) => Promise<readonly T[]>,
    fromBlock: number,
    toBlock: number,
  ) => readAdaptiveEvmLogRange({ read, fromBlock, toBlock, signal: params.signal });
  return {
    cache: params.cache,
    cacheKey: params.cacheKey,
    readScope: params.readScope ?? DIRECT_READ_SCOPE,
    contextGraphId: 9n,
    finalized: { number: params.blockNumber, hash: params.blockHash },
    pageSize: 100,
    signal: params.signal,
    loadColdFromBlock: async () => {
      if (params.coldReads) params.coldReads.count += 1;
      return 1;
    },
    readBlockHash: params.readBlockHash ?? (async (blockNumber) => params.blockHashes?.[blockNumber]
      ?? (blockNumber === params.blockNumber ? params.blockHash : null)),
    readCreationEvents: async (_contextGraphId, fromBlock, toBlock) => (
      adaptiveRead(async (rangeFrom, rangeTo) => trackRead(() => {
        enforceRangeLimit(rangeFrom, rangeTo);
        params.creationGate?.entered();
        if (rangeFrom > 1 || rangeTo < 1) return [];
        return [{
          blockNumber: 1,
          blockHash: `0x${'01'.repeat(32)}`,
          index: 0,
          ...(params.omitCreationNameHash ? {} : { nameHash: NAME_HASH }),
        }] as unknown as readonly ContextGraphAuthorityHistoryCreationEvent[];
      }).then(async (events) => {
        if (params.creationGate) await params.creationGate.wait;
        return events;
      }), fromBlock, toBlock)
    ),
    readEvents: async (query, fromBlock, toBlock) => adaptiveRead(
      async (rangeFrom, rangeTo) => trackRead(() => {
        enforceRangeLimit(rangeFrom, rangeTo);
        params.ordinaryRanges?.push([rangeFrom, rangeTo]);
        return (params.events?.[query.name] ?? []).filter((event) => (
          event.blockNumber >= rangeFrom && event.blockNumber <= rangeTo
        ));
      }),
      fromBlock,
      toBlock,
    ),
  };
}

describe('ContextGraphAuthorityHistoryCache', () => {
  it('coalesces overlapping resolutions for the same finalized head', async () => {
    const cache = new ContextGraphAuthorityHistoryCache();
    const coldReads = { count: 0 };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const input = directHistoryInput({
      cache,
      cacheKey: 'same-head',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
      coldReads,
      creationGate: { entered: entered.resolve, wait: release.promise },
    });
    const first = resolveContextGraphAuthorityHistory(input);
    await entered.promise;
    const second = resolveContextGraphAuthorityHistory(input);
    release.resolve();
    const [firstResolution, secondResolution] = await Promise.all([first, second]);
    expect(coldReads.count).toBe(1);
    expect(firstResolution.state).toBe(secondResolution.state);
    await Promise.all([firstResolution.publish(), secondResolution.publish()]);
  });

  it('a successful fallback retires a stalled same-graph lease for other cold graphs', async () => {
    const cache = new ContextGraphAuthorityHistoryCache();
    const stalledScope = {};
    const healthyScope = {};
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stalled = resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'provider-failover',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
      readScope: stalledScope,
      creationGate: { entered: entered.resolve, wait: release.promise },
    }));
    await entered.promise;

    const otherGraph = resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'provider-failover-other-graph',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
    }));

    const healthy = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'provider-failover',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
      readScope: healthyScope,
    }));
    expect(healthy.state.nameHash).toBe(NAME_HASH);
    await healthy.publish();

    const otherBeforeStalledRetires = await Promise.race([
      otherGraph.then(() => 'started'),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 25)),
    ]);
    release.resolve();
    await expect(stalled).resolves.toMatchObject({ state: healthy.state });
    await expect(otherGraph).resolves.toMatchObject({ state: { nameHash: NAME_HASH } });
    expect(otherBeforeStalledRetires).toBe('started');
  });

  it('does not let one reader abort an independent same-head reader', async () => {
    const cache = new ContextGraphAuthorityHistoryCache();
    const readScope = {};
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    firstAbort.abort();

    const cancelled = resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'independent-abort',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
      readScope,
      signal: firstAbort.signal,
    }));
    const healthy = resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'independent-abort',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
      readScope,
      signal: secondAbort.signal,
    }));

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await expect(healthy).resolves.toMatchObject({ state: { nameHash: NAME_HASH } });
  });

  it('retains a newer watermark when an older load publishes last', async () => {
    const cache = new ContextGraphAuthorityHistoryCache();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const older = resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'out-of-order',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
      creationGate: { entered: entered.resolve, wait: release.promise },
    }));
    await entered.promise;
    const newer = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'out-of-order',
      blockNumber: 35,
      blockHash: NEXT_FINALIZED_HASH,
    }));
    await newer.publish();
    release.resolve();
    await (await older).publish();

    const ranges: Array<readonly [number, number]> = [];
    const next = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'out-of-order',
      blockNumber: 36,
      blockHash: `0x${'57'.repeat(32)}`,
      blockHashes: { 35: NEXT_FINALIZED_HASH },
      ordinaryRanges: ranges,
    }));
    expect(ranges).toEqual(Array(5).fill([36, 36]));
    await next.publish();
  });

  it('prevents clear from being undone by an in-flight load', async () => {
    const cache = new ContextGraphAuthorityHistoryCache();
    const coldReads = { count: 0 };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'cleared',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
      coldReads,
      creationGate: { entered: entered.resolve, wait: release.promise },
    }));
    await entered.promise;
    cache.clear();
    release.resolve();
    const stale = await pending;
    await expect(stale.publish()).rejects.toThrow('invalidated');

    const fresh = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'cleared',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
      coldReads,
    }));
    await fresh.publish();
    expect(coldReads.count).toBe(2);
  });

  it('bounds authority history with LRU retention', async () => {
    const cache = new ContextGraphAuthorityHistoryCache(2);
    const coldReads = new Map<string, { count: number }>();
    const publish = async (cacheKey: string) => {
      const counter = coldReads.get(cacheKey) ?? { count: 0 };
      coldReads.set(cacheKey, counter);
      const resolution = await resolveContextGraphAuthorityHistory(directHistoryInput({
        cache,
        cacheKey,
        blockNumber: 30,
        blockHash: FINALIZED_HASH,
        coldReads: counter,
      }));
      await resolution.publish();
    };
    await publish('a');
    await publish('b');
    await publish('a');
    await publish('c');
    expect(cache.size).toBe(2);
    await publish('b');
    expect(coldReads.get('a')?.count).toBe(1);
    expect(coldReads.get('b')?.count).toBe(2);
    expect(coldReads.get('c')?.count).toBe(1);
  });

  it('takes the process-local checkpoint store directly at its composition boundary', () => {
    const localStore = new MemoryHistoryStore();
    expect(cacheWithStore(localStore).localStore).toBe(localStore);
  });

  it('serializes cold histories across graphs without blocking same-graph failover', async () => {
    const cache = new ContextGraphAuthorityHistoryCache();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const secondColdReads = { count: 0 };
    const first = resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'cold-graph-a',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
      creationGate: { entered: entered.resolve, wait: release.promise },
    }));
    await entered.promise;
    const second = resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'cold-graph-b',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
      coldReads: secondColdReads,
    }));
    await Promise.resolve();
    expect(secondColdReads.count).toBe(0);
    release.resolve();
    const [firstResolution, secondResolution] = await Promise.all([first, second]);
    expect(secondColdReads.count).toBe(1);
    await Promise.all([firstResolution.publish(), secondResolution.publish()]);
  });

  it('hydrates a verified durable checkpoint and scans only its suffix', async () => {
    const store = new MemoryHistoryStore();
    const firstColdReads = { count: 0 };
    const initial = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: cacheWithStore(store),
      cacheKey: 'durable',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
      coldReads: firstColdReads,
    }));
    expect(store.checkpoints.size).toBe(0);
    await initial.publish();
    expect(firstColdReads.count).toBe(1);

    const restartedColdReads = { count: 0 };
    const ranges: Array<readonly [number, number]> = [];
    const restarted = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: cacheWithStore(store),
      cacheKey: 'durable',
      blockNumber: 35,
      blockHash: NEXT_FINALIZED_HASH,
      blockHashes: { 30: FINALIZED_HASH },
      coldReads: restartedColdReads,
      ordinaryRanges: ranges,
    }));
    expect(restartedColdReads.count).toBe(0);
    expect(ranges).toEqual(Array(5).fill([31, 35]));
    await restarted.publish();
    expect(store.state('durable')?.throughBlockNumber).toBe(35);
  });

  it('preserves a future durable watermark across a lagging provider read', async () => {
    const store = new MemoryHistoryStore();
    const checkpointHash = `0x${'60'.repeat(32)}`;
    const initial = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: cacheWithStore(store),
      cacheKey: 'lagging-provider',
      blockNumber: 100,
      blockHash: checkpointHash,
    }));
    await initial.publish();

    const restartedCache = cacheWithStore(store);
    const laggingColdReads = { count: 0 };
    const lagging = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: restartedCache,
      cacheKey: 'lagging-provider',
      blockNumber: 90,
      blockHash: `0x${'59'.repeat(32)}`,
      coldReads: laggingColdReads,
    }));
    await lagging.publish();
    expect(laggingColdReads.count).toBe(1);
    expect(store.state('lagging-provider')?.throughBlockNumber).toBe(100);
    expect(store.deleted).toEqual([]);

    const suffixRanges: Array<readonly [number, number]> = [];
    const caughtUp = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: restartedCache,
      cacheKey: 'lagging-provider',
      blockNumber: 110,
      blockHash: `0x${'61'.repeat(32)}`,
      blockHashes: { 100: checkpointHash },
      ordinaryRanges: suffixRanges,
    }));
    expect(suffixRanges).toEqual(Array(5).fill([101, 110]));
    await caughtUp.publish();
    expect(store.state('lagging-provider')?.throughBlockNumber).toBe(110);
  });

  it('orders overlapping checkpoint publications so a late old save cannot regress storage', async () => {
    const store = new DelayedHistoryStore();
    store.delayNextSave = true;
    const cache = cacheWithStore(store);
    const older = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'overlapping-saves',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
    }));
    const olderPublish = older.publish();
    await store.saveEntered.promise;

    const newer = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'overlapping-saves',
      blockNumber: 35,
      blockHash: NEXT_FINALIZED_HASH,
      blockHashes: { 30: FINALIZED_HASH },
    }));
    const newerPublish = newer.publish();
    store.releaseSave.resolve();
    await Promise.all([olderPublish, newerPublish]);
    expect(store.state('overlapping-saves')?.throughBlockNumber).toBe(35);
  });

  it('orders stale-anchor deletion before a concurrent newer checkpoint save', async () => {
    const store = new DelayedHistoryStore();
    const seeded = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: cacheWithStore(store),
      cacheKey: 'delete-save-race',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
    }));
    await seeded.publish();
    store.delayNextDelete = true;

    const cache = cacheWithStore(store);
    const stale = resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'delete-save-race',
      blockNumber: 35,
      blockHash: NEXT_FINALIZED_HASH,
      blockHashes: { 30: `0x${'99'.repeat(32)}` },
    }));
    await store.deleteEntered.promise;

    const newer = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'delete-save-race',
      blockNumber: 40,
      blockHash: `0x${'57'.repeat(32)}`,
      blockHashes: { 30: FINALIZED_HASH },
      readScope: {},
    }));
    const newerPublish = newer.publish();
    store.releaseDelete.resolve();
    await Promise.all([stale, newerPublish]);
    expect(store.state('delete-save-race')?.throughBlockNumber).toBe(40);
  });

  it('deletes a durable checkpoint whose finalized anchor changed', async () => {
    const store = new MemoryHistoryStore();
    const initial = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: cacheWithStore(store),
      cacheKey: 'reorged',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
    }));
    await initial.publish();

    const coldReads = { count: 0 };
    const replacement = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: cacheWithStore(store),
      cacheKey: 'reorged',
      blockNumber: 35,
      blockHash: NEXT_FINALIZED_HASH,
      blockHashes: { 30: `0x${'99'.repeat(32)}` },
      coldReads,
    }));
    expect(coldReads.count).toBe(1);
    expect(store.deleted).toEqual(['reorged']);
    await replacement.publish();
  });

  it('retains a checkpoint when one provider cannot read its historical anchor', async () => {
    const store = new MemoryHistoryStore();
    const initial = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: cacheWithStore(store),
      cacheKey: 'non-archive-provider',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
    }));
    await initial.publish();

    await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: cacheWithStore(store),
      cacheKey: 'non-archive-provider',
      blockNumber: 35,
      blockHash: NEXT_FINALIZED_HASH,
    }));
    expect(store.deleted).toEqual([]);
    expect(store.state('non-archive-provider')?.throughBlockNumber).toBe(30);
  });

  it('ignores malformed durable input before choosing a scan bound', async () => {
    const store = new MemoryHistoryStore();
    store.checkpoints.set('malformed', {
      version: 1,
      integrity: FINALIZED_HASH,
      state: {
        throughBlockNumber: 30,
        throughBlockHash: 'not-a-hash',
        nameHash: NAME_HASH,
        ownershipEra: 0,
        policyVersion: 0,
        rosterVersion: 0,
        sourceBlockNumber: 1,
        sourceBlockHash: `0x${'01'.repeat(32)}`,
      },
    });
    const coldReads = { count: 0 };
    const resolution = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: cacheWithStore(store),
      cacheKey: 'malformed',
      blockNumber: 35,
      blockHash: NEXT_FINALIZED_HASH,
      coldReads,
    }));
    expect(coldReads.count).toBe(1);
    await resolution.publish();
    expect(store.state('malformed')?.throughBlockHash).toBe(NEXT_FINALIZED_HASH);
  });

  it('rejects a canonical-anchor checkpoint whose aggregate was altered', async () => {
    const store = new MemoryHistoryStore();
    const validState: ContextGraphAuthorityHistoryState = {
      throughBlockNumber: 30,
      throughBlockHash: FINALIZED_HASH,
      nameHash: NAME_HASH,
      ownershipEra: 2,
      policyVersion: 4,
      rosterVersion: 7,
      sourceBlockNumber: 20,
      sourceBlockHash: `0x${'20'.repeat(32)}`,
    };
    const checkpoint = encodeContextGraphAuthorityHistoryCheckpoint(validState);
    store.checkpoints.set('altered-aggregate', {
      ...checkpoint,
      state: { ...checkpoint.state, ownershipEra: 99 },
    });
    const coldReads = { count: 0 };
    const resolution = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: cacheWithStore(store),
      cacheKey: 'altered-aggregate',
      blockNumber: 35,
      blockHash: NEXT_FINALIZED_HASH,
      blockHashes: { 30: FINALIZED_HASH },
      coldReads,
    }));
    expect(coldReads.count).toBe(1);
    expect(resolution.state.ownershipEra).toBe(0);
    await resolution.publish();
  });

  it.each([
    ['negative watermark', { throughBlockNumber: -1 }],
    ['malformed anchor hash', { throughBlockHash: '0x1234' }],
    ['malformed name hash', { nameHash: 'not-a-hash' }],
    ['negative ownership generation', { ownershipEra: -1 }],
    ['fractional policy generation', { policyVersion: 1.5 }],
    ['unsafe roster generation', { rosterVersion: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative source block', { sourceBlockNumber: -1 }],
    ['source after watermark', { sourceBlockNumber: 31 }],
    ['malformed source hash', { sourceBlockHash: '0x00' }],
  ])('rejects malformed state: %s', (_label, patch) => {
    const valid: ContextGraphAuthorityHistoryState = {
      throughBlockNumber: 30,
      throughBlockHash: FINALIZED_HASH,
      nameHash: NAME_HASH,
      ownershipEra: 2,
      policyVersion: 4,
      rosterVersion: 7,
      sourceBlockNumber: 20,
      sourceBlockHash: `0x${'20'.repeat(32)}`,
    };
    expect(normalizeContextGraphAuthorityHistoryState({ ...valid, ...patch })).toBeUndefined();
  });

  it('decodes the fixed v1 generation-order compatibility fixture', () => {
    const state: ContextGraphAuthorityHistoryState = {
      throughBlockNumber: 30,
      throughBlockHash: FINALIZED_HASH,
      nameHash: NAME_HASH,
      ownershipEra: 0,
      policyVersion: 0,
      rosterVersion: 0,
      sourceBlockNumber: 1,
      sourceBlockHash: `0x${'01'.repeat(32)}`,
    };
    const persistedV1 = {
      version: 1,
      state,
      // Fixed independently from the encoder so changing tuple order breaks
      // backward compatibility instead of silently updating the assertion.
      integrity: '0xa6c25f9c288f489861f99e68560160d7aeaca450f9ed151db406bdfb1e50a958',
    };

    expect(decodeContextGraphAuthorityHistoryCheckpoint(persistedV1)).toEqual(state);
  });

  it('rejects old-version and integrity-less checkpoint envelopes', () => {
    const state: ContextGraphAuthorityHistoryState = {
      throughBlockNumber: 30,
      throughBlockHash: FINALIZED_HASH,
      nameHash: NAME_HASH,
      ownershipEra: 0,
      policyVersion: 0,
      rosterVersion: 0,
      sourceBlockNumber: 1,
      sourceBlockHash: `0x${'01'.repeat(32)}`,
    };
    expect(decodeContextGraphAuthorityHistoryCheckpoint({ version: 0, state }))
      .toBeUndefined();
    expect(decodeContextGraphAuthorityHistoryCheckpoint({ version: 1, state }))
      .toBeUndefined();
  });

  it('sequentially splits pages rejected by a fallback RPC range cap', async () => {
    const rangeAttempts = { count: 0 };
    const transfer = (blockNumber: number, index: number): ContextGraphAuthorityHistoryEvent => ({
      blockNumber,
      blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
      index,
    });
    const resolution = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: new ContextGraphAuthorityHistoryCache(),
      cacheKey: 'adaptive-range',
      blockNumber: 200,
      blockHash: FINALIZED_HASH,
      rangeLimit: 50,
      rangeAttempts,
      // Both configured pages carry an event in each split half. The reducer
      // assertion proves the transport helper concatenates right-hand results,
      // rather than merely proving that it retried a particular number of times.
      events: { Transfer: [transfer(25, 0), transfer(75, 1), transfer(125, 2), transfer(175, 3)] },
    }));
    expect(resolution.state).toMatchObject({
      throughBlockNumber: 200,
      ownershipEra: 4,
      policyVersion: 4,
      rosterVersion: 4,
      sourceBlockNumber: 175,
    });
    // Two configured 100-block pages × six event streams: each rejected page
    // is retried as two accepted 50-block reads.
    expect(rangeAttempts.count).toBe(36);
    await resolution.publish();
  });

  it('serializes cold event streams but keeps warm suffix streams parallel', async () => {
    const cache = new ContextGraphAuthorityHistoryCache();
    const coldConcurrency = { active: 0, peak: 0 };
    const cold = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'cold-concurrency',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
      readConcurrency: coldConcurrency,
    }));
    expect(coldConcurrency.peak).toBe(1);
    await cold.publish();

    const warmConcurrency = { active: 0, peak: 0 };
    const warm = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'cold-concurrency',
      blockNumber: 35,
      blockHash: NEXT_FINALIZED_HASH,
      blockHashes: { 30: FINALIZED_HASH },
      readConcurrency: warmConcurrency,
    }));
    expect(warmConcurrency.peak).toBe(5);
    await warm.publish();
  });

  it('rejects a malformed creation event without a name hash at runtime', async () => {
    await expect(resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: new ContextGraphAuthorityHistoryCache(),
      cacheKey: 'malformed-creation',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
      omitCreationNameHash: true,
    }))).rejects.toThrow('creation event has no name hash');
  });
});

describe('adaptive EVM log-range transport', () => {
  it('recognizes nested managed-provider errors and preserves both split halves', async () => {
    const calls: Array<readonly [number, number]> = [];
    const result = await readAdaptiveEvmLogRange({
      fromBlock: 1,
      toBlock: 100,
      read: async (fromBlock, toBlock) => {
        calls.push([fromBlock, toBlock]);
        if (toBlock - fromBlock + 1 > 50) {
          throw {
            cause: {
              info: {
                error: { message: 'eth_getLogs is limited to 50 blocks' },
              },
            },
          };
        }
        return [`${fromBlock}-${toBlock}`];
      },
    });
    expect(calls).toEqual([[1, 100], [1, 50], [51, 100]]);
    expect(result).toEqual(['1-50', '51-100']);
  });
});
