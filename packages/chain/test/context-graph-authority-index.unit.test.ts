// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';

import { ContextGraphAuthorityIndex as ContextGraphAuthorityIndexBase } from
  '../src/context-graph-authority-index.js';
import type { ContextGraphAuthorityIndexId } from '../src/chain-adapter.js';
import type { ContextGraphAuthorityIndexStore } from '../src/context-graph-authority-index-checkpoint.js';
import {
  reduceContextGraphAuthorityIndexPage,
  type RawContextGraphAuthorityIndexEvent as ContextGraphAuthorityIndexEvent,
} from '../src/context-graph-authority-index-reducer.js';
import {
  CONTEXT_GRAPH_AUTHORITY_INDEX_BOOTSTRAP_TIMEOUT_MS,
  ContextGraphAuthorityIndexBootstrapUnavailableError,
  type ContextGraphAuthorityIndexBootstrap,
} from '../src/context-graph-authority-index-snapshot.js';
import {
  MemoryAuthorityIndexStore,
  ScopedAuthorityIndexStore,
} from './helpers/context-graph-authority-index.js';

const OWNER = `0x${'11'.repeat(20)}`;
const NEXT_OWNER = `0x${'22'.repeat(20)}`;
const AUTHORITY = `0x${'33'.repeat(20)}`;
const NAME_9 = `0x${'99'.repeat(32)}`;
const NAME_10 = `0x${'aa'.repeat(32)}`;

/** Scanner lifecycle tests select their state explicitly from the canonical view. */
class ContextGraphAuthorityIndex extends ContextGraphAuthorityIndexBase {
  async resolve(
    input: Parameters<ContextGraphAuthorityIndexBase['view']>[0]
      & { readonly contextGraphId: ContextGraphAuthorityIndexId },
  ) {
    return (await this.view(input)).resolve(input.contextGraphId);
  }
}

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
    contextGraphId: contextGraphId.toString(10) as ContextGraphAuthorityIndexId,
    readScope,
    deploymentBlockNumber: 10,
    finalized: { number: finalizedNumber, hash: blockHash(finalizedNumber) },
    pageSize: 5,
    readBlockHash: async (blockNumber: number) => blockHash(blockNumber),
    readPage,
  });

  it('holds the durable cursor below the reorg horizon while still projecting to the anchor', async () => {
    // The anchor is the operator's and at the default depth it is the HEAD, so a
    // cursor written AT the anchor lives on a reorgable block: `admit…Checkpoint`
    // re-reads the hash there, a single-block tip reorg mismatches, and the whole
    // materialized index is discarded and rescanned from the deployment block.
    // The cursor is a memo, not a finality decision, so it stops below a
    // reorg-safe horizon while the READ still projects all the way to the anchor.
    const store = new MemoryAuthorityIndexStore();
    const index = new ContextGraphAuthorityIndex(store);
    const scanned: Array<readonly [number, number]> = [];

    const state = await index.resolve({
      ...makeInput(9n, {}, async (from, to) => {
        scanned.push([from, to]);
        return allEvents.filter((e) => e.blockNumber >= from && e.blockNumber <= to);
      }, 25),
      durableReorgHoldbackBlocks: 8,
    });

    // The projection still reflects every event up to the anchor.
    expect(state.owner).toBe(NEXT_OWNER.toLowerCase());
    expect(scanned.at(-1)?.[1]).toBe(25);
    // But nothing at or above the horizon was written down.
    const persisted = (store.record?.value as { cursor: { throughBlockNumber: number } });
    expect(persisted.cursor.throughBlockNumber).toBe(17);
    expect(persisted.cursor.throughBlockNumber).toBeLessThanOrEqual(25 - 8);
  });

  it('writes the cursor at the anchor when no holdback is configured', async () => {
    // Default 0 is the behaviour before the horizon existed, so a caller that
    // omits it is unchanged rather than newly exposed.
    const store = new MemoryAuthorityIndexStore();
    const index = new ContextGraphAuthorityIndex(store);

    await index.resolve(makeInput(9n, {}, async (from, to) => (
      allEvents.filter((e) => e.blockNumber >= from && e.blockNumber <= to)
    ), 25));

    const persisted = store.record?.value as
      { cursor: { throughBlockNumber: number } } | undefined;
    expect(persisted?.cursor.throughBlockNumber).toBe(25);
  });

  it('keeps raw persisted checkpoints private behind the single projection view', () => {
    const index = new ContextGraphAuthorityIndexBase(new MemoryAuthorityIndexStore());

    expect((index as any).snapshot).toBeUndefined();
    expect(typeof index.view).toBe('function');
    expect((index as any).resolve).toBeUndefined();
    expect((index as any).resolveNameHash).toBeUndefined();
    expect((index as any).revisions).toBeUndefined();
  });

  it('projects unique name commitments from the shared view and fails closed on ambiguity', async () => {
    const index = new ContextGraphAuthorityIndex(new MemoryAuthorityIndexStore());
    const input = makeInput(9n, {}, async (from, to) => allEvents.filter((entry) => (
      entry.blockNumber >= from && entry.blockNumber <= to
    )));
    const view = await index.view(input);

    expect(view.statesByNameHashes([NAME_9]).get(NAME_9)?.contextGraphId).toBe('9');
    expect(view.statesByNameHashes([`0x${'ff'.repeat(32)}`]).size).toBe(0);

    const ambiguous = new ContextGraphAuthorityIndex(new MemoryAuthorityIndexStore());
    const ambiguousView = await ambiguous.view({
      ...input,
      readPage: async (from, to) => [
        ...allEvents,
        creation(11n, 11, 2, NAME_9),
      ].filter((entry) => entry.blockNumber >= from && entry.blockNumber <= to),
    });
    expect(() => ambiguousView.statesByNameHashes([NAME_9]))
      .toThrow('ambiguous across 2 finalized Context Graphs');
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

  it('accepts a valid checkpoint installed by the third invalidation winner', async () => {
    const store = new MemoryAuthorityIndexStore();
    const winner = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 25,
      throughBlockHash: blockHash(25),
      events: allEvents.filter((entry) => entry.blockNumber <= 25),
    }).checkpoint;
    const replacedAnchor = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 25,
      throughBlockHash: blockHash(24),
      events: allEvents.filter((entry) => entry.blockNumber <= 25),
    }).checkpoint;
    store.record = { token: 1, value: replacedAnchor };
    let invalidationAttempts = 0;
    store.invalidate = async (_scope, expectedToken) => {
      invalidationAttempts += 1;
      store.record = {
        token: expectedToken + 1,
        value: invalidationAttempts === 3 ? winner : replacedAnchor,
      };
      return undefined;
    };
    let blockReads = 0;
    let pageReads = 0;
    const input = makeInput(9n, {}, async () => {
      pageReads += 1;
      return [];
    });

    await expect(new ContextGraphAuthorityIndex(store).resolve({
      ...input,
      readBlockHash: async () => {
        blockReads += 1;
        return blockHash(25);
      },
    })).resolves.toMatchObject({ contextGraphId: '9' });
    expect(invalidationAttempts).toBe(3);
    expect(store.record).toEqual({ token: 4, value: winner });
    expect(blockReads).toBe(0);
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

  describe('trusted core bootstrap local-history fallback', () => {
    const SCOPE = makeInput(9n, {}, async () => []).scope;
    /** Where a seeded scan lives; the fallback runs on the plain `SCOPE` instead. */
    const TRUST_DOMAIN_SCOPE = `${SCOPE}:trusted-bootstrap:trusted-core-A`;
    // 251 blocks of history: more than the 200-block tail budget below allows.
    const FINALIZED = 260;
    const readEvents = async (from: number, to: number) => allEvents.filter((entry) => (
      entry.blockNumber >= from && entry.blockNumber <= to
    ));
    /** Every trusted core is down unless an override says otherwise. */
    const unavailableBootstrap = (
      overrides: Partial<ContextGraphAuthorityIndexBootstrap> = {},
    ): ContextGraphAuthorityIndexBootstrap => ({
      trustDomain: 'trusted-core-A',
      maxTailBlocks: 200,
      fetchSnapshot: async () => { throw new Error('trusted cores unavailable'); },
      ...overrides,
    });
    const scan = (
      readPage: (from: number, to: number) => Promise<readonly ContextGraphAuthorityIndexEvent[]>,
      finalizedNumber = FINALIZED,
    ) => ({ ...makeInput(9n, {}, readPage, finalizedNumber), pageSize: 50 });
    type ScanProgress = Parameters<NonNullable<ContextGraphAuthorityIndexBootstrap['onScanProgress']>>[0];

    it('scans unbudgeted local history when no core can seed and the operator opted in', async () => {
      const localStore = new ScopedAuthorityIndexStore();
      const expected = await new ContextGraphAuthorityIndex(localStore).resolve(scan(readEvents));

      const store = new ScopedAuthorityIndexStore();
      const fallbacks: Array<{ scope: string; reason: string }> = [];
      let fetches = 0;
      const index = new ContextGraphAuthorityIndex(store, unavailableBootstrap({
        fetchSnapshot: async () => { fetches += 1; throw new Error('trusted cores unavailable'); },
        localHistoryFallback: true,
        onLocalHistoryFallback: (info) => { fallbacks.push(info); },
      }));
      const ranges: Array<readonly [number, number]> = [];
      const state = await index.resolve(scan(async (from, to) => {
        ranges.push([from, to]);
        return readEvents(from, to);
      }));

      expect(state).toEqual(expected);
      expect(ranges[0]).toEqual([10, 59]);
      expect(ranges.at(-1)).toEqual([260, 260]);
      expect(ranges.reduce((total, [from, to]) => total + to - from + 1, 0)).toBe(251);
      // Committed exactly where an index without bootstrap keeps its own.
      expect(store.records.get(SCOPE)?.value).toEqual(localStore.records.get(SCOPE)?.value);
      expect(store.records.has(TRUST_DOMAIN_SCOPE)).toBe(false);
      expect(fetches).toBe(1);
      expect(fallbacks).toEqual([{
        scope: SCOPE,
        reason: expect.stringContaining('trusted cores unavailable'),
      }]);

      // The fallback checkpoint is durable. The next scan still gives the
      // cores their turn (here the seed failure cooldown answers for them),
      // falls back again and resumes above it instead of rescanning.
      const resumed: Array<readonly [number, number]> = [];
      await index.resolve(scan(async (from, to) => {
        resumed.push([from, to]);
        return readEvents(from, to);
      }, 265));
      expect(resumed).toEqual([[261, 265]]);
      expect(fetches).toBe(1);
      expect(fallbacks).toHaveLength(2);
      expect(store.records.get(SCOPE)?.value).toMatchObject({ cursor: { throughBlockNumber: 265 } });
      expect(store.records.has(TRUST_DOMAIN_SCOPE)).toBe(false);
    });

    it('resumes the fallback from the checkpoint an index without bootstrap left under the plain scope', async () => {
      // 10.0.17 built the complete index in local-history mode, under the plain scope.
      const store = new ScopedAuthorityIndexStore();
      await new ContextGraphAuthorityIndex(store).resolve(scan(readEvents));
      const local = store.records.get(SCOPE);
      expect(local?.value).toMatchObject({ cursor: { throughBlockNumber: FINALIZED } });
      const expected = await new ContextGraphAuthorityIndex(new ScopedAuthorityIndexStore())
        .resolve(scan(readEvents, 265));

      // 10.0.18 on the same store: a discovered trust set, every core down.
      const fallbacks: unknown[] = [];
      const index = new ContextGraphAuthorityIndex(store, unavailableBootstrap({
        localHistoryFallback: true,
        onLocalHistoryFallback: (info) => { fallbacks.push(info); },
      }));
      const ranges: Array<readonly [number, number]> = [];
      const state = await index.resolve(scan(async (from, to) => {
        ranges.push([from, to]);
        return readEvents(from, to);
      }, 265));

      expect(fallbacks).toHaveLength(1);
      // Cursor + 1, not the deployment block: the fresh trust-domain namespace
      // does not cost the edge a rescan of history it already holds.
      expect(ranges).toEqual([[261, 265]]);
      expect(state).toEqual(expected);
      expect(store.records.get(SCOPE)).toMatchObject({
        token: local!.token + 1,
        value: { cursor: { throughBlockNumber: 265 } },
      });
      expect(store.records.has(TRUST_DOMAIN_SCOPE)).toBe(false);
      // An edge never serves, not even its independently scanned fallback checkpoint.
      expect(index.exportSnapshot({
        scope: SCOPE, deploymentBlockNumber: 10, minThroughBlockNumber: 10, maxThroughBlockNumber: 265,
      })).toBeNull();
    });

    it('neither resumes from nor promotes the trust-domain checkpoint when falling back', async () => {
      // An earlier seeded scan left an imported prefix under the trust-domain
      // key, by now too old to continue without a fresh seed.
      const store = new ScopedAuthorityIndexStore();
      const imported = { token: 3, value: reduceContextGraphAuthorityIndexPage({
        deploymentBlockNumber: 10,
        throughBlockNumber: 40,
        throughBlockHash: blockHash(40),
        events: allEvents.filter((entry) => entry.blockNumber <= 40),
      }).checkpoint };
      store.records.set(TRUST_DOMAIN_SCOPE, imported);
      const expected = await new ContextGraphAuthorityIndex(new ScopedAuthorityIndexStore())
        .resolve(scan(readEvents));

      const fallbacks: unknown[] = [];
      const ranges: Array<readonly [number, number]> = [];
      const state = await new ContextGraphAuthorityIndex(store, unavailableBootstrap({
        localHistoryFallback: true,
        onLocalHistoryFallback: (info) => { fallbacks.push(info); },
      })).resolve(scan(async (from, to) => {
        ranges.push([from, to]);
        return readEvents(from, to);
      }));

      expect(fallbacks).toHaveLength(1);
      // The plain scope was empty, so the independent index starts at the
      // deployment block: the imported prefix is not its to build on.
      expect(ranges[0]).toEqual([10, 59]);
      expect(state).toEqual(expected);
      expect(store.records.get(SCOPE)?.value).toMatchObject({ cursor: { throughBlockNumber: FINALIZED } });
      expect(store.records.get(TRUST_DOMAIN_SCOPE)).toBe(imported);
    });

    it('seeds the trust-domain key on a later scan without touching the fallback checkpoint', async () => {
      const store = new ScopedAuthorityIndexStore();
      await new ContextGraphAuthorityIndex(store, unavailableBootstrap({ localHistoryFallback: true }))
        .resolve(scan(readEvents));
      const fallen = store.records.get(SCOPE);
      expect(fallen?.value).toMatchObject({ cursor: { throughBlockNumber: FINALIZED } });
      expect(store.records.has(TRUST_DOMAIN_SCOPE)).toBe(false);

      // The cores are back: the seed lands under the trust-domain key and only
      // the tail above it is scanned. The plain-scope checkpoint is neither
      // read nor rewritten, so the two lineages never mix.
      const seed = reduceContextGraphAuthorityIndexPage({
        deploymentBlockNumber: 10,
        throughBlockNumber: 250,
        throughBlockHash: blockHash(250),
        events: allEvents.filter((entry) => entry.blockNumber <= 250),
      }).checkpoint;
      const fallbacks: unknown[] = [];
      const ranges: Array<readonly [number, number]> = [];
      const state = await new ContextGraphAuthorityIndex(store, unavailableBootstrap({
        fetchSnapshot: async () => ({ version: 1, scope: SCOPE, checkpoint: seed }),
        localHistoryFallback: true,
        onLocalHistoryFallback: (info) => { fallbacks.push(info); },
      })).resolve(scan(async (from, to) => {
        ranges.push([from, to]);
        return readEvents(from, to);
      }, 270));

      expect(fallbacks).toEqual([]);
      expect(ranges).toEqual([[251, 270]]);
      expect(state).toMatchObject({ contextGraphId: '9', ownershipEra: 1 });
      expect(store.records.get(TRUST_DOMAIN_SCOPE)?.value)
        .toMatchObject({ cursor: { throughBlockNumber: 270 } });
      expect(store.records.get(SCOPE)).toBe(fallen);
    });

    it.each([
      {},
      { localHistoryFallback: false },
    ])('keeps failing when no core can seed and the fallback is not enabled: %j', async (flag) => {
      const store = new MemoryAuthorityIndexStore();
      const fallbacks: unknown[] = [];
      let pages = 0;
      const error = await new ContextGraphAuthorityIndex(store, unavailableBootstrap({
        ...flag,
        onLocalHistoryFallback: (info) => { fallbacks.push(info); },
      })).resolve(scan(async () => { pages += 1; return []; })).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(ContextGraphAuthorityIndexBootstrapUnavailableError);
      expect(error).toMatchObject({ code: 'AUTHORITY_INDEX_BOOTSTRAP_UNAVAILABLE' });
      expect(pages).toBe(0);
      expect(fallbacks).toEqual([]);
      expect(store.record).toBeUndefined();
    });

    it('still propagates a lifecycle abort raised while seeding instead of falling back', async () => {
      let started!: () => void;
      const ready = new Promise<void>((resolve) => { started = resolve; });
      const fallbacks: unknown[] = [];
      let pages = 0;
      const index = new ContextGraphAuthorityIndex(new MemoryAuthorityIndexStore(), unavailableBootstrap({
        fetchSnapshot: async (_request, signal) => new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          started();
        }),
        localHistoryFallback: true,
        onLocalHistoryFallback: (info) => { fallbacks.push(info); },
      }));
      const pending = index.resolve(scan(async () => { pages += 1; return []; }));
      await ready;
      index.clear();

      await expect(pending).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Context Graph authority index lifecycle cleared',
      });
      expect(fallbacks).toEqual([]);
      expect(pages).toBe(0);
    });

    it('falls back at the bootstrap deadline when the transport never settles', async () => {
      const expected = await new ContextGraphAuthorityIndex(new ScopedAuthorityIndexStore())
        .resolve(scan(readEvents));
      vi.useFakeTimers();
      try {
        const store = new ScopedAuthorityIndexStore();
        const fallbacks: Array<{ scope: string; reason: string }> = [];
        const ranges: Array<readonly [number, number]> = [];
        const index = new ContextGraphAuthorityIndex(store, unavailableBootstrap({
          fetchSnapshot: async (_request, signal) => new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
          localHistoryFallback: true,
          onLocalHistoryFallback: (info) => { fallbacks.push(info); },
        }));
        const pending = index.resolve(scan(async (from, to) => {
          ranges.push([from, to]);
          return readEvents(from, to);
        }));

        await vi.advanceTimersByTimeAsync(CONTEXT_GRAPH_AUTHORITY_INDEX_BOOTSTRAP_TIMEOUT_MS - 1);
        expect(fallbacks).toEqual([]);
        expect(ranges).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toEqual(expected);
        expect(fallbacks).toEqual([{
          scope: SCOPE,
          reason: expect.stringContaining('snapshot bootstrap deadline exceeded'),
        }]);
        expect(ranges[0]).toEqual([10, 59]);
        expect(ranges.at(-1)).toEqual([260, 260]);
        expect(store.records.get(SCOPE)?.value)
          .toMatchObject({ cursor: { throughBlockNumber: FINALIZED } });
        expect(store.records.has(TRUST_DOMAIN_SCOPE)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports every reduced page of the fallback scan in ascending block order', async () => {
      const progress: ScanProgress[] = [];
      const index = new ContextGraphAuthorityIndex(new MemoryAuthorityIndexStore(), unavailableBootstrap({
        localHistoryFallback: true,
        onScanProgress: (info) => { progress.push(info); },
      }));
      const ranges: Array<readonly [number, number]> = [];
      await index.resolve({
        ...scan(async (from, to) => {
          ranges.push([from, to]);
          return readEvents(from, to);
        }),
        durableReorgHoldbackBlocks: 8,
      });

      // Committed pages up to the horizon, then the in-memory tail page.
      expect(ranges).toEqual([
        [10, 59], [60, 109], [110, 159], [160, 209], [210, 252], [253, 260],
      ]);
      expect(progress.map(({ fromBlockNumber, throughBlockNumber }) => (
        [fromBlockNumber, throughBlockNumber]
      ))).toEqual(ranges);
      expect(progress.slice(1).every((entry, offset) => (
        entry.throughBlockNumber > progress[offset]!.throughBlockNumber
      ))).toBe(true);
      expect(progress.map(({ scannedBlocks }) => scannedBlocks)).toEqual([50, 100, 150, 200, 243, 251]);
      expect(progress.every(({ scope, finalizedNumber }) => (
        scope === SCOPE && finalizedNumber === FINALIZED
      ))).toBe(true);
    });

    it('reports the seeded tail pages too and leaves the fallback idle when a core answers', async () => {
      const seed = reduceContextGraphAuthorityIndexPage({
        deploymentBlockNumber: 10,
        throughBlockNumber: 200,
        throughBlockHash: blockHash(200),
        events: allEvents.filter((entry) => entry.blockNumber <= 200),
      }).checkpoint;
      const progress: Array<readonly [number, number]> = [];
      const fallbacks: unknown[] = [];
      const store = new ScopedAuthorityIndexStore();
      const index = new ContextGraphAuthorityIndex(store, unavailableBootstrap({
        fetchSnapshot: async () => ({ version: 1, scope: SCOPE, checkpoint: seed }),
        localHistoryFallback: true,
        onLocalHistoryFallback: (info) => { fallbacks.push(info); },
        onScanProgress: ({ fromBlockNumber, throughBlockNumber }) => {
          progress.push([fromBlockNumber, throughBlockNumber]);
        },
      }));
      const ranges: Array<readonly [number, number]> = [];
      const state = await index.resolve(scan(async (from, to) => {
        ranges.push([from, to]);
        return readEvents(from, to);
      }));

      expect(state).toMatchObject({ contextGraphId: '9', ownershipEra: 1 });
      expect(ranges).toEqual([[201, 250], [251, 260]]);
      expect(progress).toEqual(ranges);
      expect(fallbacks).toEqual([]);
      // A seeded scan lives under the trust-domain key; the fallback opt-in
      // alone writes nothing under the plain scope.
      expect(store.records.get(TRUST_DOMAIN_SCOPE)?.value)
        .toMatchObject({ cursor: { throughBlockNumber: FINALIZED } });
      expect(store.records.has(SCOPE)).toBe(false);
    });

    it('ignores throwing observers instead of failing the scan', async () => {
      const store = new MemoryAuthorityIndexStore();
      let progressCalls = 0;
      const index = new ContextGraphAuthorityIndex(store, unavailableBootstrap({
        localHistoryFallback: true,
        onLocalHistoryFallback: () => { throw new Error('observer failed'); },
        onScanProgress: () => { progressCalls += 1; throw new Error('observer failed'); },
      }));

      await expect(index.resolve(scan(readEvents)))
        .resolves.toMatchObject({ contextGraphId: '9', ownershipEra: 1 });
      expect(progressCalls).toBe(6);
      expect(store.record?.value).toMatchObject({ cursor: { throughBlockNumber: FINALIZED } });
    });
  });
});
