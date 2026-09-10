// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  ContextGraphAuthorityHistoryCache,
  resolveContextGraphAuthorityHistory,
} from '../src/context-graph-authority-history.js';
import {
  ContextGraphAuthorityIndex,
  normalizeContextGraphAuthorityIndexCheckpoint,
  reduceContextGraphAuthorityIndexPage,
  type ContextGraphAuthorityIndexEvent,
  type ContextGraphAuthorityIndexStore,
} from '../src/context-graph-authority-index.js';
import { applyContextGraphAuthorityGenerationEvent } from '../src/context-graph-authority-generation.js';

const ZERO = `0x${'0'.repeat(40)}`;
const OWNER = `0x${'11'.repeat(20)}`;
const NEXT_OWNER = `0x${'22'.repeat(20)}`;
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
  return {
    name,
    contextGraphId,
    blockNumber,
    blockHash: blockHash(blockNumber),
    index,
    ...extra,
  } as ContextGraphAuthorityIndexEvent;
}

function creation(
  contextGraphId: bigint,
  blockNumber: number,
  index: number,
  nameHash: string,
): ContextGraphAuthorityIndexEvent {
  return event('ContextGraphCreated', contextGraphId, blockNumber, index, { nameHash });
}

describe('contract-wide Context Graph authority index reducer', () => {
  it('groups unsorted logs by graph and preserves the authority generation semantics', () => {
    const result = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [
        event('AgentParticipantRemoved', 9n, 13, 0),
        creation(10n, 11, 1, NAME_10),
        event('PublishAuthorityUpdated', 9n, 12, 2),
        event('Transfer', 9n, 10, 0, { from: ZERO, to: OWNER }),
        event('AgentParticipantAdded', 9n, 11, 2),
        creation(9n, 10, 1, NAME_9),
        event('Transfer', 9n, 12, 1, { from: OWNER, to: NEXT_OWNER }),
      ],
    });

    expect(result.checkpoint.cursor).toEqual({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      stateCount: 2,
    });
    expect(result.checkpoint.states).toEqual([
      {
        contextGraphId: '9',
        nameHash: NAME_9,
        ownershipEra: 1,
        policyVersion: 2,
        rosterVersion: 3,
        sourceBlockNumber: 12,
        sourceBlockHash: blockHash(12),
      },
      {
        contextGraphId: '10',
        nameHash: NAME_10,
        ownershipEra: 0,
        policyVersion: 0,
        rosterVersion: 0,
        sourceBlockNumber: 11,
        sourceBlockHash: blockHash(11),
      },
    ]);
    expect(Object.isFrozen(result.checkpoint)).toBe(true);
    expect(Object.isFrozen(result.checkpoint.states)).toBe(true);
    expect(result.checkpoint.states.every(Object.isFrozen)).toBe(true);
  });

  it('matches the legacy per-graph reducer for the same event history', async () => {
    const index = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [
        event('AgentParticipantRemoved', 9n, 13, 0),
        event('PublishAuthorityUpdated', 9n, 12, 2),
        event('AgentParticipantAdded', 9n, 11, 2),
        creation(9n, 10, 1, NAME_9),
        event('Transfer', 9n, 12, 1, { from: OWNER, to: NEXT_OWNER }),
      ],
    }).checkpoint.states[0]!;
    const history = await resolveContextGraphAuthorityHistory({
      cache: new ContextGraphAuthorityHistoryCache(),
      cacheKey: 'parity:9',
      readScope: {},
      contextGraphId: 9n,
      finalized: { number: 20, hash: blockHash(20) },
      pageSize: 100,
      loadColdFromBlock: async () => 10,
      readBlockHash: async (blockNumber) => blockHash(blockNumber),
      readCreationEvents: async () => [{
        blockNumber: 10,
        blockHash: blockHash(10),
        index: 1,
        nameHash: NAME_9,
      }],
      readEvents: async ({ name }) => ({
        Transfer: [{ blockNumber: 12, blockHash: blockHash(12), index: 1 }],
        PublishAuthorityUpdated: [{
          blockNumber: 12, blockHash: blockHash(12), index: 2,
        }],
        AgentParticipantAdded: [{ blockNumber: 11, blockHash: blockHash(11), index: 2 }],
        AgentParticipantRemoved: [{ blockNumber: 13, blockHash: blockHash(13), index: 0 }],
        PublishPolicyUpdated: [],
      })[name],
    });
    const { contextGraphId: _, ...indexGeneration } = index;
    const { throughBlockNumber: _number, throughBlockHash: _hash, ...legacyGeneration } =
      history.state;
    expect(indexGeneration).toEqual(legacyGeneration);
  });

  it('reduces an exactly contiguous suffix without mutating the prior checkpoint', () => {
    const first = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [creation(9n, 10, 1, NAME_9), creation(10n, 11, 1, NAME_10)],
    });
    const suffix = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 25,
      throughBlockHash: blockHash(25),
      previous: first.checkpoint,
      events: [event('PublishPolicyUpdated', 10n, 22, 4)],
    });

    expect(suffix.checkpoint.states).toHaveLength(2);
    expect(suffix.checkpoint.states[1]).toMatchObject({
      contextGraphId: '10',
      policyVersion: 1,
      sourceBlockNumber: 22,
    });
    expect(first.checkpoint.states[1]).toMatchObject({
      contextGraphId: '10',
      policyVersion: 0,
    });

    const emptySuffix = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 30,
      throughBlockHash: blockHash(30),
      previous: suffix.checkpoint,
      events: [],
    });
    expect(emptySuffix.checkpoint.cursor.stateCount).toBe(2);
  });

  it('ignores mint, burn, and self-transfer logs', () => {
    const result = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 15,
      throughBlockHash: blockHash(15),
      events: [
        event('Transfer', 9n, 10, 0, { from: ZERO, to: OWNER }),
        creation(9n, 10, 1, NAME_9),
        event('Transfer', 9n, 11, 0, { from: OWNER, to: OWNER }),
        event('Transfer', 9n, 12, 0, { from: OWNER, to: ZERO }),
      ],
    });
    expect(result.checkpoint.states[0]).toMatchObject({
      ownershipEra: 0,
      policyVersion: 0,
      rosterVersion: 0,
      sourceBlockNumber: 10,
    });
  });

  it('fails closed on gaps, overlaps, deployment changes, and malformed prior state', () => {
    const first = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [creation(9n, 10, 1, NAME_9)],
    });
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      previous: first.checkpoint,
      events: [],
    })).toThrow('empty, overlapping, or non-contiguous');
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 11,
      throughBlockNumber: 25,
      throughBlockHash: blockHash(25),
      previous: first.checkpoint,
      events: [],
    })).toThrow('deployment block changed');
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 25,
      throughBlockHash: blockHash(25),
      previous: {
        ...first.checkpoint,
        cursor: { ...first.checkpoint.cursor, stateCount: 2 },
      },
      events: [],
    })).toThrow('previous checkpoint is malformed');
  });

  it('fails closed on duplicate positions, duplicate creation, and pre-creation changes', () => {
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [
        creation(9n, 10, 1, NAME_9),
        event('AgentParticipantAdded', 9n, 10, 1),
      ],
    })).toThrow('duplicate log position');

    const first = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [creation(9n, 10, 1, NAME_9)],
    });
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 25,
      throughBlockHash: blockHash(25),
      previous: first.checkpoint,
      events: [creation(9n, 22, 1, NAME_9)],
    })).toThrow('more than one creation event');

    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [event('PublishPolicyUpdated', 9n, 12, 0)],
    })).toThrow('precedes creation');
  });

  it('validates page events and the terminal page anchor', () => {
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [creation(9n, 21, 0, NAME_9)],
    })).toThrow('outside its page or is malformed');
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [{
        ...creation(9n, 20, 0, NAME_9),
        blockHash: blockHash(19),
      }],
    })).toThrow('disagrees with the page anchor');
    expect(() => reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20),
      events: [event('Transfer', 9n, 12, 0, { from: 'bad', to: OWNER })],
    })).toThrow('invalid address');
  });

  it('normalizes durable checkpoints and rejects count, id, hash, and source corruption', () => {
    const valid = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 20,
      throughBlockHash: blockHash(20).toUpperCase().replace('0X', '0x'),
      events: [creation(9n, 10, 1, NAME_9.toUpperCase().replace('0X', '0x'))],
    }).checkpoint;
    expect(normalizeContextGraphAuthorityIndexCheckpoint(valid)).toEqual(valid);
    expect(normalizeContextGraphAuthorityIndexCheckpoint({
      ...valid,
      cursor: { ...valid.cursor, stateCount: 2 },
    })).toBeUndefined();
    expect(normalizeContextGraphAuthorityIndexCheckpoint({
      ...valid,
      states: [{ ...valid.states[0], contextGraphId: '09' }],
    })).toBeUndefined();
    expect(normalizeContextGraphAuthorityIndexCheckpoint({
      ...valid,
      states: [{ ...valid.states[0], sourceBlockNumber: 21 }],
    })).toBeUndefined();
    expect(normalizeContextGraphAuthorityIndexCheckpoint({
      ...valid,
      cursor: { ...valid.cursor, throughBlockHash: 'bad' },
    })).toBeUndefined();
    expect(normalizeContextGraphAuthorityIndexCheckpoint({
      ...valid,
      states: [{
        ...valid.states[0],
        ownershipEra: 1,
        policyVersion: 0,
        rosterVersion: 0,
      }],
    })).toBeUndefined();
    expect(normalizeContextGraphAuthorityIndexCheckpoint({
      ...valid,
      states: [{ ...valid.states[0], contextGraphId: (1n << 256n).toString(10) }],
    })).toBeUndefined();
  });

  it('decodes opaque durable reads only at the chain-owned boundary', async () => {
    const store: ContextGraphAuthorityIndexStore = {
      load: async () => ({ token: 1, value: { cursor: 'not-a-cursor', states: [] } }),
      compareAndSwap: async () => 2,
      invalidate: async () => 2,
    };
    expect(normalizeContextGraphAuthorityIndexCheckpoint((await store.load('scope'))?.value))
      .toBeUndefined();
  });

  it('rejects counter overflow before a checkpoint can be emitted', () => {
    expect(() => applyContextGraphAuthorityGenerationEvent({
      nameHash: NAME_9,
      ownershipEra: 0,
      policyVersion: Number.MAX_SAFE_INTEGER,
      rosterVersion: 0,
      sourceBlockNumber: 10,
      sourceBlockHash: blockHash(10),
    }, {
      name: 'PublishPolicyUpdated',
      blockNumber: 22,
      blockHash: blockHash(22),
    }, 'Context Graph 9')).toThrow('safe integer range');
  });
});

class MemoryAuthorityIndexStore implements ContextGraphAuthorityIndexStore {
  record: Readonly<{ token: number; value: unknown | null }> | undefined;
  readonly commits: number[] = [];
  readonly invalidations: number[] = [];

  async load(): Promise<Readonly<{ token: number; value: unknown | null }> | undefined> {
    return this.record;
  }

  async compareAndSwap(
    _scope: string,
    expectedToken: number | undefined,
    value: unknown,
  ): Promise<number | undefined> {
    if (this.record?.token !== expectedToken) return undefined;
    const nextToken = expectedToken === undefined ? 1 : expectedToken + 1;
    this.record = Object.freeze({ token: nextToken, value });
    this.commits.push(nextToken);
    return nextToken;
  }

  async invalidate(_scope: string, expectedToken: number): Promise<number | undefined> {
    if (this.record?.token !== expectedToken) return undefined;
    const nextToken = expectedToken + 1;
    this.record = Object.freeze({ token: nextToken, value: null });
    this.invalidations.push(nextToken);
    return nextToken;
  }
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

  it('reloads the CAS winner and resumes from its suffix with concurrent providers', async () => {
    const store = new MemoryAuthorityIndexStore();
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

    const first = new ContextGraphAuthorityIndex(store).resolve(
      makeInput(9n, {}, reader(rangesA)),
    );
    const second = new ContextGraphAuthorityIndex(store).resolve(
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
    expect(store.record?.token).toBeGreaterThanOrEqual(4);
    expect((store.record!.value as { cursor: { throughBlockNumber: number } }).cursor)
      .toMatchObject({ throughBlockNumber: 25 });
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
