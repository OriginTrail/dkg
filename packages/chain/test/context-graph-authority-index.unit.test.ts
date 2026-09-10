// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { ContextGraphAuthorityIndex } from '../src/context-graph-authority-index.js';
import type { ContextGraphAuthorityIndexStore } from '../src/context-graph-authority-index-checkpoint.js';
import {
  reduceContextGraphAuthorityIndexPage,
  type ContextGraphAuthorityIndexEvent,
} from '../src/context-graph-authority-index-reducer.js';
import { MemoryAuthorityIndexStore } from './helpers/context-graph-authority-index.js';

const OWNER = `0x${'11'.repeat(20)}`;
const NEXT_OWNER = `0x${'22'.repeat(20)}`;
const AUTHORITY = `0x${'33'.repeat(20)}`;
const NAME_9 = `0x${'99'.repeat(32)}`;
const NAME_10 = `0x${'aa'.repeat(32)}`;

const blockHash = (block: number): string => `0x${block.toString(16).padStart(64, '0')}`;

function event(
  name: ContextGraphAuthorityIndexEvent['name'],
  contextGraphId: bigint,
  blockNumber: number,
  index: number,
  extra: Record<string, unknown> = {},
): ContextGraphAuthorityIndexEvent {
  const defaults: Record<string, unknown> = (() => {
    switch (name) {
      case 'PublishPolicyUpdated':
        return {
          publishPolicy: 0,
          publishAuthority: NEXT_OWNER,
          publishAuthorityAccountId: 0n,
        };
      case 'PublishAuthorityUpdated':
        return { publishAuthority: NEXT_OWNER, publishAuthorityAccountId: 0n };
      case 'AgentParticipantAdded':
        return { agent: NEXT_OWNER };
      case 'AgentParticipantRemoved':
        return { agent: OWNER };
      default:
        return {};
    }
  })();
  return {
    name,
    contextGraphId,
    blockNumber,
    blockHash: blockHash(blockNumber),
    index,
    ...defaults,
    ...extra,
  } as ContextGraphAuthorityIndexEvent;
}

function creation(
  contextGraphId: bigint,
  blockNumber: number,
  index: number,
  nameHash: string,
): ContextGraphAuthorityIndexEvent {
  return event('ContextGraphCreated', contextGraphId, blockNumber, index, {
    owner: OWNER,
    nameHash,
    participantAgents: [OWNER],
    accessPolicy: 1,
    publishPolicy: 0,
    publishAuthority: AUTHORITY,
    publishAuthorityAccountId: 7n,
  });
}

describe('durable contract-wide Context Graph authority scanner', () => {
  const allEvents: ContextGraphAuthorityIndexEvent[] = [
    creation(9n, 10, 1, NAME_9),
    creation(10n, 11, 1, NAME_10),
    event('Transfer', 9n, 12, 1, { from: OWNER, to: NEXT_OWNER }),
    event('PublishPolicyUpdated', 10n, 28, 0),
  ];

  const makeInput = (
    contextGraphId: bigint,
    readScope: object,
    readPage: (from: number, to: number) => Promise<readonly ContextGraphAuthorityIndexEvent[]>,
    finalizedNumber = 25,
  ) => ({
    scope: 'evm:84532:hub:context-graph-storage',
    contextGraphId,
    readScope,
    deploymentBlockNumber: 10,
    finalized: { number: finalizedNumber, hash: blockHash(finalizedNumber) },
    pageSize: 5,
    readBlockHash: async (blockNumber: number) => blockHash(blockNumber),
    readPage,
  });

  it('shares one page walk across concurrent graph lookups and resumes after restart', async () => {
    const store = new MemoryAuthorityIndexStore();
    const index = new ContextGraphAuthorityIndex(store);
    const reader = {};
    const ranges: Array<readonly [number, number]> = [];
    const readPage = async (from: number, to: number) => {
      ranges.push([from, to]);
      await Promise.resolve();
      return allEvents.filter((entry) => (
        entry.blockNumber >= from && entry.blockNumber <= to
      ));
    };

    const [nine, ten] = await Promise.all([
      index.resolve(makeInput(9n, reader, readPage)),
      index.resolve(makeInput(10n, reader, readPage)),
    ]);

    expect(nine).toMatchObject({ contextGraphId: '9', ownershipEra: 1 });
    expect(ten).toMatchObject({ contextGraphId: '10', policyVersion: 0 });
    expect(ranges).toEqual([[10, 14], [15, 19], [20, 24], [25, 25]]);
    expect(store.commits).toEqual([1, 2, 3, 4]);

    const restarted = new ContextGraphAuthorityIndex(store);
    const suffixRanges: Array<readonly [number, number]> = [];
    const advanced = await restarted.resolve(makeInput(
      10n,
      {},
      async (from, to) => {
        suffixRanges.push([from, to]);
        return allEvents.filter((entry) => (
          entry.blockNumber >= from && entry.blockNumber <= to
        ));
      },
      30,
    ));
    expect(suffixRanges).toEqual([[26, 30]]);
    expect(advanced).toMatchObject({ contextGraphId: '10', policyVersion: 1 });
    expect(store.commits).toEqual([1, 2, 3, 4, 5]);
  });

  it('persists each complete page and resumes after a later page fails', async () => {
    const store = new MemoryAuthorityIndexStore();
    const firstRanges: Array<readonly [number, number]> = [];
    await expect(new ContextGraphAuthorityIndex(store).resolve(makeInput(
      9n,
      {},
      async (from, to) => {
        firstRanges.push([from, to]);
        if (from === 15) throw new Error('provider unavailable');
        return allEvents.filter((entry) => entry.blockNumber >= from && entry.blockNumber <= to);
      },
    ))).rejects.toThrow('provider unavailable');
    expect(firstRanges).toEqual([[10, 14], [15, 19]]);
    expect(store.commits).toEqual([1]);

    const resumedRanges: Array<readonly [number, number]> = [];
    await new ContextGraphAuthorityIndex(store).resolve(makeInput(
      9n,
      {},
      async (from, to) => {
        resumedRanges.push([from, to]);
        return allEvents.filter((entry) => entry.blockNumber >= from && entry.blockNumber <= to);
      },
    ));
    expect(resumedRanges[0]).toEqual([15, 19]);
  });

  it('tombstones corrupt payloads before rebuilding with a non-repeating token', async () => {
    const store = new MemoryAuthorityIndexStore();
    store.record = { token: 7, value: { corrupt: true } };
    const index = new ContextGraphAuthorityIndex(store);
    await index.resolve(makeInput(
      9n,
      {},
      async (from, to) => allEvents.filter((entry) => (
        entry.blockNumber >= from && entry.blockNumber <= to
      )),
    ));
    expect(store.invalidations).toEqual([8]);
    expect(store.record?.token).toBe(12);
  });

  it('rejects a malformed durable token promptly without recursive recovery', async () => {
    const store = new MemoryAuthorityIndexStore();
    store.record = { token: 1.5, value: { corrupt: true } };

    await expect(new ContextGraphAuthorityIndex(store).resolve(makeInput(
      9n,
      {},
      async () => [],
    ))).rejects.toThrow('durable token is invalid');
    expect(store.invalidations).toEqual([]);
  });

  it('preserves a newer durable cursor when a lagging caller observes an older head', async () => {
    const store = new MemoryAuthorityIndexStore();
    const readPage = async (from: number, to: number) => allEvents.filter((entry) => (
      entry.blockNumber >= from && entry.blockNumber <= to
    ));
    await new ContextGraphAuthorityIndex(store).resolve(makeInput(9n, {}, readPage, 30));
    const winner = store.record;

    await expect(new ContextGraphAuthorityIndex(store).resolve(
      makeInput(9n, {}, readPage, 25),
    )).rejects.toThrow('behind durable cursor 30');
    expect(store.record).toBe(winner);
    expect(store.invalidations).toEqual([]);
  });

  it('reloads a newer winner when conditional reorg invalidation loses its race', async () => {
    const store = new MemoryAuthorityIndexStore();
    const readPage = async (from: number, to: number) => allEvents.filter((entry) => (
      entry.blockNumber >= from && entry.blockNumber <= to
    ));
    await new ContextGraphAuthorityIndex(store).resolve(makeInput(9n, {}, readPage, 25));
    const rejectedToken = store.record!.token;
    const originalInvalidate = store.invalidate.bind(store);
    store.invalidate = async (scope: string, expectedToken: number) => {
      if (expectedToken === rejectedToken) {
        const winner = reduceContextGraphAuthorityIndexPage({
          deploymentBlockNumber: 10,
          throughBlockNumber: 30,
          throughBlockHash: blockHash(30),
          events: allEvents,
        }).checkpoint;
        store.record = { token: rejectedToken + 1, value: winner };
        return undefined;
      }
      return originalInvalidate(scope, expectedToken);
    };

    const state = await new ContextGraphAuthorityIndex(store).resolve({
      ...makeInput(10n, {}, async () => [], 30),
      readBlockHash: async (blockNumber: number) => (
        blockNumber === 25 ? blockHash(24) : blockHash(blockNumber)
      ),
    });
    expect(state).toMatchObject({ contextGraphId: '10', policyVersion: 1 });
    expect(store.record?.token).toBe(rejectedToken + 1);
    expect(store.invalidations).toEqual([]);
  });

  it('bounds repeated invalidation losses without recursive recovery', async () => {
    const store = new MemoryAuthorityIndexStore();
    store.record = { token: 1, value: { corrupt: true } };
    let invalidationAttempts = 0;
    store.invalidate = async (_scope, expectedToken) => {
      invalidationAttempts += 1;
      store.record = { token: expectedToken + 1, value: { corrupt: true } };
      return undefined;
    };
    let pageReads = 0;

    await expect(new ContextGraphAuthorityIndex(store).resolve(makeInput(
      9n,
      {},
      async () => {
        pageReads += 1;
        return [];
      },
    ))).rejects.toThrow(
      'Context Graph authority index changed repeatedly during checkpoint recovery',
    );
    expect(invalidationAttempts).toBe(3);
    expect(pageReads).toBe(0);
  });

  it('reloads the CAS winner and resumes from its suffix with concurrent providers', async () => {
    const store = new MemoryAuthorityIndexStore();
    const index = new ContextGraphAuthorityIndex(store);
    const firstPageEntered = Promise.withResolvers<void>();
    const releaseFirstPage = Promise.withResolvers<void>();
    let gatedReads = 0;
    const rangesA: Array<readonly [number, number]> = [];
    const rangesB: Array<readonly [number, number]> = [];
    const reader = (ranges: Array<readonly [number, number]>) => async (from: number, to: number) => {
      ranges.push([from, to]);
      if (from === 10) {
        gatedReads += 1;
        if (gatedReads === 2) firstPageEntered.resolve();
        await releaseFirstPage.promise;
      }
      return allEvents.filter((entry) => entry.blockNumber >= from && entry.blockNumber <= to);
    };

    const first = index.resolve(
      makeInput(9n, {}, reader(rangesA)),
    );
    const second = index.resolve(
      makeInput(10n, {}, reader(rangesB)),
    );
    await firstPageEntered.promise;
    releaseFirstPage.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ contextGraphId: '9' }),
      expect.objectContaining({ contextGraphId: '10' }),
    ]);
    expect(rangesA[0]).toEqual([10, 14]);
    expect(rangesB[0]).toEqual([10, 14]);
    for (const ranges of [rangesA, rangesB]) {
      const starts = ranges.map(([from]) => from);
      expect(starts.slice(1).every((from, offset) => from > starts[offset]!)).toBe(true);
      expect(starts.filter((from) => from === 10)).toHaveLength(1);
    }
    expect(store.record?.token).toBeGreaterThanOrEqual(4);
    expect((store.record!.value as { cursor: { throughBlockNumber: number } }).cursor)
      .toMatchObject({ throughBlockNumber: 25 });
  });

  it('does not adopt a newer cached checkpoint from another provider fork', async () => {
    const store = new MemoryAuthorityIndexStore();
    const index = new ContextGraphAuthorityIndex(store);
    const finalCommitStored = Promise.withResolvers<void>();
    const releaseFinalCommit = Promise.withResolvers<void>();
    const compareAndSwap = store.compareAndSwap.bind(store);
    let delayedAcknowledgement = false;
    store.compareAndSwap = async (scope, expectedToken, value) => {
      const token = await compareAndSwap(scope, expectedToken, value);
      const throughBlockNumber = (
        value as { cursor?: { throughBlockNumber?: unknown } }
      ).cursor?.throughBlockNumber;
      if (
        token !== undefined
        && throughBlockNumber === 25
        && !delayedAcknowledgement
      ) {
        delayedAcknowledgement = true;
        finalCommitStored.resolve();
        await releaseFinalCommit.promise;
      }
      return token;
    };

    const forkAEvents = allEvents;
    const forkBEvents = allEvents.map((entry) => (
      entry.name === 'ContextGraphCreated' && entry.contextGraphId === 9n
        ? creation(9n, entry.blockNumber, entry.index, NAME_10)
        : entry
    ));
    const readFork = (entries: readonly ContextGraphAuthorityIndexEvent[]) => async (
      from: number,
      to: number,
    ) => entries.filter((entry) => entry.blockNumber >= from && entry.blockNumber <= to);

    const providerA = index.resolve(makeInput(9n, {}, readFork(forkAEvents)));
    await finalCommitStored.promise;

    const providerB = index.resolve({
      ...makeInput(9n, {}, readFork(forkBEvents)),
      finalized: { number: 25, hash: `0x${'bb'.repeat(32)}` },
    });
    await expect(providerB).resolves.toMatchObject({ nameHash: NAME_10 });

    releaseFinalCommit.resolve();
    await expect(providerA).resolves.toMatchObject({ nameHash: NAME_9 });
    expect(store.invalidations).toEqual([5]);
    expect((store.record!.value as { states: Array<{ nameHash: string }> }).states[0])
      .toMatchObject({ nameHash: NAME_10 });
  });

  it('prevents an ABA stale writer after invalidation and checkpoint recreation', async () => {
    const store = new MemoryAuthorityIndexStore();
    const scope = makeInput(9n, {}, async () => []).scope;
    const initial = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 14,
      throughBlockHash: blockHash(14),
      events: allEvents.filter((entry) => entry.blockNumber <= 14),
    }).checkpoint;
    expect(await store.compareAndSwap(scope, undefined, initial)).toBe(1);

    const stalePageEntered = Promise.withResolvers<void>();
    const releaseStalePage = Promise.withResolvers<void>();
    const stale = new ContextGraphAuthorityIndex(store).resolve(makeInput(
      9n,
      {},
      async (from, to) => {
        if (from === 15) {
          stalePageEntered.resolve();
          await releaseStalePage.promise;
        }
        return allEvents.filter((entry) => entry.blockNumber >= from && entry.blockNumber <= to);
      },
      25,
    ));
    await stalePageEntered.promise;

    expect(await store.invalidate(scope, 1)).toBe(2);
    const recreated = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: allEvents.filter((entry) => entry.blockNumber <= 20),
    }).checkpoint;
    expect(await store.compareAndSwap(scope, 2, recreated)).toBe(3);
    releaseStalePage.resolve();

    await expect(stale).resolves.toMatchObject({ contextGraphId: '9' });
    expect(store.commits).not.toContain(2);
    expect(store.record?.token).toBeGreaterThan(3);
    expect((store.record!.value as { cursor: { throughBlockNumber: number } }).cursor)
      .toMatchObject({ throughBlockNumber: 25 });
  });

  it('detaches caller cancellation from a shared scan', async () => {
    const store = new MemoryAuthorityIndexStore();
    const index = new ContextGraphAuthorityIndex(store);
    const reader = {};
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let reads = 0;
    const readPage = async (from: number, to: number) => {
      reads += 1;
      if (reads === 1) {
        entered.resolve();
        await release.promise;
      }
      return allEvents.filter((entry) => entry.blockNumber >= from && entry.blockNumber <= to);
    };
    const abort = new AbortController();
    const cancelled = index.resolve({ ...makeInput(9n, reader, readPage), signal: abort.signal });
    const survivor = index.resolve(makeInput(10n, reader, readPage));
    await entered.promise;
    abort.abort(new Error('caller left'));
    await expect(cancelled).rejects.toThrow('caller left');
    release.resolve();
    await expect(survivor).resolves.toMatchObject({ contextGraphId: '10' });
    expect(reads).toBe(4);
  });

  it('does not start durable or RPC work for an already-aborted caller', async () => {
    const calls = { loads: 0, commits: 0, invalidations: 0, blockHashes: 0, pages: 0 };
    const store: ContextGraphAuthorityIndexStore = {
      load: async () => { calls.loads += 1; return undefined; },
      compareAndSwap: async () => { calls.commits += 1; return 1; },
      invalidate: async () => { calls.invalidations += 1; return 1; },
    };
    const abort = new AbortController();
    abort.abort(new Error('caller already left'));
    const input = makeInput(9n, {}, async () => { calls.pages += 1; return []; });

    await expect(new ContextGraphAuthorityIndex(store).resolve({
      ...input,
      signal: abort.signal,
      readBlockHash: async () => { calls.blockHashes += 1; return blockHash(10); },
    })).rejects.toThrow('caller already left');
    expect(calls).toEqual({
      loads: 0, commits: 0, invalidations: 0, blockHashes: 0, pages: 0,
    });
  });

  it('aborts the shared transport when its owning lifecycle is cleared', async () => {
    const store = new MemoryAuthorityIndexStore();
    const index = new ContextGraphAuthorityIndex(store);
    const entered = Promise.withResolvers<void>();
    const pending = index.resolve(makeInput(
      9n,
      {},
      async (_from, _to, lifecycleSignal) => {
        entered.resolve();
        return new Promise<readonly ContextGraphAuthorityIndexEvent[]>((resolve, reject) => {
          lifecycleSignal.addEventListener(
            'abort',
            () => reject(lifecycleSignal.reason),
            { once: true },
          );
        });
      },
    ));
    await entered.promise;
    index.clear();

    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Context Graph authority index lifecycle cleared',
    });
    expect(store.commits).toEqual([]);
  });
});
