// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  ContextGraphAuthorityHistoryCache,
  resolveContextGraphAuthorityHistory,
  type ContextGraphAuthorityHistoryCreationEvent,
  type ContextGraphAuthorityHistoryState,
  type ContextGraphAuthorityHistoryStore,
  type ResolveContextGraphAuthorityHistoryInput,
} from '../src/context-graph-authority-history.js';

const FINALIZED_HASH = `0x${'55'.repeat(32)}`;
const NEXT_FINALIZED_HASH = `0x${'56'.repeat(32)}`;
const NAME_HASH = `0x${'88'.repeat(32)}`;
const DIRECT_READ_SCOPE = {};

class MemoryHistoryStore implements ContextGraphAuthorityHistoryStore {
  readonly states = new Map<string, ContextGraphAuthorityHistoryState>();
  readonly deleted: string[] = [];

  async load(cacheKey: string): Promise<ContextGraphAuthorityHistoryState | undefined> {
    return this.states.get(cacheKey);
  }

  async save(cacheKey: string, state: ContextGraphAuthorityHistoryState): Promise<void> {
    this.states.set(cacheKey, state);
  }

  async delete(cacheKey: string): Promise<void> {
    this.deleted.push(cacheKey);
    this.states.delete(cacheKey);
  }
}

function directHistoryInput(params: Readonly<{
  cache: ContextGraphAuthorityHistoryCache;
  cacheKey: string;
  blockNumber: number;
  blockHash: string;
  coldReads?: { count: number };
  ordinaryRanges?: Array<readonly [number, number]>;
  blockHashes?: Readonly<Record<number, string>>;
  creationGate?: Readonly<{ entered(): void; wait: Promise<void> }>;
  readScope?: object;
  signal?: AbortSignal;
  omitCreationNameHash?: boolean;
}>): ResolveContextGraphAuthorityHistoryInput {
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
    readBlockHash: async (blockNumber) => params.blockHashes?.[blockNumber]
      ?? (blockNumber === params.blockNumber ? params.blockHash : null),
    readCreationEvents: async () => {
      params.creationGate?.entered();
      if (params.creationGate) await params.creationGate.wait;
      return [{
        blockNumber: 1,
        blockHash: `0x${'01'.repeat(32)}`,
        index: 0,
        ...(params.omitCreationNameHash ? {} : { nameHash: NAME_HASH }),
      }] as unknown as readonly ContextGraphAuthorityHistoryCreationEvent[];
    },
    readEvents: async (_query, fromBlock, toBlock) => {
      params.ordinaryRanges?.push([fromBlock, toBlock]);
      return [];
    },
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

  it('does not let a stalled provider attempt capture same-head failover', async () => {
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

    const healthy = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache,
      cacheKey: 'provider-failover',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
      readScope: healthyScope,
    }));
    expect(healthy.state.nameHash).toBe(NAME_HASH);
    await healthy.publish();

    release.resolve();
    await expect(stalled).resolves.toMatchObject({ state: healthy.state });
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

  it('hydrates a verified durable checkpoint and scans only its suffix', async () => {
    const store = new MemoryHistoryStore();
    const firstColdReads = { count: 0 };
    const initial = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: new ContextGraphAuthorityHistoryCache(1_024, store),
      cacheKey: 'durable',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
      coldReads: firstColdReads,
    }));
    expect(store.states.size).toBe(0);
    await initial.publish();
    expect(firstColdReads.count).toBe(1);

    const restartedColdReads = { count: 0 };
    const ranges: Array<readonly [number, number]> = [];
    const restarted = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: new ContextGraphAuthorityHistoryCache(1_024, store),
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
    expect(store.states.get('durable')?.throughBlockNumber).toBe(35);
  });

  it('deletes a durable checkpoint whose finalized anchor changed', async () => {
    const store = new MemoryHistoryStore();
    const initial = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: new ContextGraphAuthorityHistoryCache(1_024, store),
      cacheKey: 'reorged',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
    }));
    await initial.publish();

    const coldReads = { count: 0 };
    const replacement = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: new ContextGraphAuthorityHistoryCache(1_024, store),
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
      cache: new ContextGraphAuthorityHistoryCache(1_024, store),
      cacheKey: 'non-archive-provider',
      blockNumber: 30,
      blockHash: FINALIZED_HASH,
    }));
    await initial.publish();

    await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: new ContextGraphAuthorityHistoryCache(1_024, store),
      cacheKey: 'non-archive-provider',
      blockNumber: 35,
      blockHash: NEXT_FINALIZED_HASH,
    }));
    expect(store.deleted).toEqual([]);
    expect(store.states.get('non-archive-provider')?.throughBlockNumber).toBe(30);
  });

  it('ignores malformed durable input before choosing a scan bound', async () => {
    const store = new MemoryHistoryStore();
    store.states.set('malformed', {
      throughBlockNumber: 30,
      throughBlockHash: 'not-a-hash',
      nameHash: NAME_HASH,
      ownershipEra: 0,
      policyVersion: 0,
      rosterVersion: 0,
      sourceBlockNumber: 1,
      sourceBlockHash: `0x${'01'.repeat(32)}`,
    });
    const coldReads = { count: 0 };
    const resolution = await resolveContextGraphAuthorityHistory(directHistoryInput({
      cache: new ContextGraphAuthorityHistoryCache(1_024, store),
      cacheKey: 'malformed',
      blockNumber: 35,
      blockHash: NEXT_FINALIZED_HASH,
      coldReads,
    }));
    expect(coldReads.count).toBe(1);
    await resolution.publish();
    expect(store.states.get('malformed')?.throughBlockHash).toBe(NEXT_FINALIZED_HASH);
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
