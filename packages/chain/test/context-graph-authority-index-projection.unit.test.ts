// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';

import { ContextGraphAuthorityIndex } from '../src/context-graph-authority-index.js';
import { ContextGraphAuthorityIndexRetryableError } from
  '../src/context-graph-authority-index-errors.js';
import { RpcEndpointsExhaustedError } from '../src/chain-rpc-transport-error.js';
import type { ContextGraphAuthorityIndexId } from '../src/chain-adapter.js';
import {
  CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS,
  ContextGraphAuthorityIndexProjectionCache,
  resolveProjectionFetchedAtMs,
  contextGraphAuthorityIndexScope,
  resolveContextGraphAuthorityIndexTickMs,
  type ContextGraphAuthorityIndexCompletedProjection,
  type ContextGraphAuthorityProjectionServedEvidence,
} from '../src/context-graph-authority-index-projection.js';
import {
  reduceContextGraphAuthorityIndexPage,
  type RawContextGraphAuthorityIndexEvent as ContextGraphAuthorityIndexEvent,
} from '../src/context-graph-authority-index-reducer.js';
import {
  MemoryAuthorityIndexStore,
  ScopedAuthorityIndexStore,
} from './helpers/context-graph-authority-index.js';

const OWNER = `0x${'11'.repeat(20)}`;
const NEXT_OWNER = `0x${'22'.repeat(20)}`;
const AUTHORITY = `0x${'33'.repeat(20)}`;
const NAME_9 = `0x${'ab'.repeat(32)}`;
const ZERO_HASH = `0x${'00'.repeat(32)}`;
const SCOPE = 'evm:31337:0xhub:0xstorage';
const T = 6_000;
const START_MS = 1_800_000_000_000;

const id = (value: bigint): ContextGraphAuthorityIndexId => (
  value.toString(10) as ContextGraphAuthorityIndexId
);

function creation(contextGraphId: bigint, blockNumber: number): ContextGraphAuthorityIndexEvent {
  return {
    name: 'ContextGraphCreated',
    contextGraphId,
    blockNumber,
    blockHash: '',
    index: 1,
    owner: OWNER,
    nameHash: contextGraphId === 9n ? NAME_9 : `0x${contextGraphId.toString(16).padStart(64, '0')}`,
    participantAgents: [OWNER],
    accessPolicy: 1,
    publishPolicy: 0,
    publishAuthority: AUTHORITY,
    publishAuthorityAccountId: 7n,
  } as ContextGraphAuthorityIndexEvent;
}

function transfer(contextGraphId: bigint, blockNumber: number): ContextGraphAuthorityIndexEvent {
  return {
    name: 'Transfer',
    contextGraphId,
    blockNumber,
    blockHash: '',
    index: 1,
    from: OWNER,
    to: NEXT_OWNER,
  } as ContextGraphAuthorityIndexEvent;
}

/**
 * A chain the test moves by hand, a wall clock the test moves by hand, and a
 * `refresh` that is the production shape: one real index scan to the head.
 */
function makeHarness(options: Readonly<{
  holdback?: number;
  tickMs?: number;
  scope?: string;
  store?: MemoryAuthorityIndexStore;
}> = {}) {
  const clock = { nowMs: START_MS };
  const chain = {
    head: 25,
    fork: 0,
    forkFrom: 0,
    /** Seconds the head block's own timestamp trails the wall clock. */
    headLagSeconds: 2,
    anchorUnavailable: false,
    withoutTimestamp: false,
    events: [creation(9n, 10)] as ContextGraphAuthorityIndexEvent[],
  };
  const reads = { refreshes: 0, hashes: [] as number[], pages: [] as Array<readonly [number, number]> };
  const served: ContextGraphAuthorityProjectionServedEvidence[] = [];
  const store = options.store ?? new MemoryAuthorityIndexStore();
  const index = new ContextGraphAuthorityIndex(store, undefined, {
    tickMs: options.tickMs ?? T,
    now: () => clock.nowMs,
  });
  const scope = options.scope ?? SCOPE;
  const blockHash = (block: number): string => (
    `0x${((block >= chain.forkFrom ? chain.fork : 0) * 1_000_000 + block)
      .toString(16).padStart(64, '0')}`
  );
  let refreshGate: Promise<void> | undefined;
  let refreshFailure: Error | undefined;

  const refresh = async (): Promise<ContextGraphAuthorityIndexCompletedProjection> => {
    reads.refreshes += 1;
    if (refreshGate !== undefined) await refreshGate;
    if (refreshFailure !== undefined) throw refreshFailure;
    const head = chain.head;
    const view = await index.view({
      scope,
      readScope: chain,
      deploymentBlockNumber: 10,
      finalized: { number: head, hash: blockHash(head) },
      pageSize: 100,
      durableReorgHoldbackBlocks: options.holdback ?? 0,
      readBlockHash: async (blockNumber) => {
        reads.hashes.push(blockNumber);
        return blockHash(blockNumber);
      },
      readPage: async (from, to) => {
        reads.pages.push([from, to]);
        return chain.events
          .filter((e) => e.blockNumber >= from && e.blockNumber <= to)
          .map((e) => ({ ...e, blockHash: blockHash(e.blockNumber) }));
      },
    });
    return Object.freeze({
      scope,
      chainId: '31337',
      contractAddress: '0xstorage',
      finalized: { number: head, hash: blockHash(head) },
      head: {
        number: head,
        hash: blockHash(head),
        timestampSeconds: chain.withoutTimestamp
          ? Number.NaN
          : Math.floor(clock.nowMs / 1_000) - chain.headLagSeconds,
      },
      requiresAnchorValidation: (options.holdback ?? 0) > 0,
      view,
      origin: Object.freeze({ kind: 'scan' as const }),
    });
  };

  const read = (
    contextGraphId: bigint = 9n,
    signal?: AbortSignal,
    ownRefresh: () => Promise<ContextGraphAuthorityIndexCompletedProjection> = refresh,
  ) => index.projection({
    scope,
    signal,
    project: (cached) => ({
      complete: cached.view.has(id(contextGraphId)),
      value: cached,
    }),
    validateAnchor: async (cached) => {
      reads.hashes.push(cached.finalized.number);
      if (chain.anchorUnavailable) return undefined;
      return blockHash(cached.finalized.number) === cached.finalized.hash;
    },
    onServed: (evidence) => { served.push(evidence); },
    refresh: ownRefresh,
  });

  return {
    clock, chain, reads, served, store, index, scope, read, refresh,
    physicalReads: () => reads.hashes.length + reads.pages.length,
    holdRefresh(): () => void {
      let release!: () => void;
      refreshGate = new Promise<void>((resolve) => { release = resolve; });
      return () => { refreshGate = undefined; release(); };
    },
    failRefresh(error: Error | undefined): void { refreshFailure = error; },
  };
}

const turns = async (count = 20): Promise<void> => {
  for (let turn = 0; turn < count; turn += 1) await Promise.resolve();
};

describe('authority projection scope', () => {
  it('normalizes the contract address for every index/cache caller', () => {
    expect(contextGraphAuthorityIndexScope('evm:31337:0xhub', '0xAbCd'))
      .toBe('evm:31337:0xhub:0xabcd');
  });
});

describe('chain.indexTickMs', () => {
  it('defaults to 6s and rejects everything that is not a positive integer', () => {
    expect(resolveContextGraphAuthorityIndexTickMs(undefined)).toBe(6_000);
    expect(resolveContextGraphAuthorityIndexTickMs(250)).toBe(250);
    for (const invalid of [0, -1, 1.5, Number.NaN, Infinity, '6000', null, 2 ** 53]) {
      expect(() => resolveContextGraphAuthorityIndexTickMs(invalid))
        .toThrow('chain.indexTickMs must be a positive integer');
    }
  });

  it('bounds stale-if-error at min(max(3T, 15s), the five-minute RFC-64 interval)', () => {
    expect(new ContextGraphAuthorityIndexProjectionCache({ tickMs: 1_000 }).staleMs).toBe(15_000);
    expect(new ContextGraphAuthorityIndexProjectionCache({ tickMs: 6_000 }).staleMs).toBe(18_000);
    expect(new ContextGraphAuthorityIndexProjectionCache({ tickMs: 60_000 }).staleMs).toBe(180_000);
    expect(new ContextGraphAuthorityIndexProjectionCache({ tickMs: 180_000 }).staleMs)
      .toBe(CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS);
  });

  it('rejects an unusable authority head timestamp tolerance', () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 53]) {
      expect(() => new ContextGraphAuthorityIndexProjectionCache({
        headTimestampToleranceMs: invalid,
      })).toThrow(
        'Context Graph authority head timestamp tolerance must be a positive integer',
      );
    }
  });
});

describe('finalized Context Graph authority projection cache', () => {
  it('keeps name-hash normalization and zero-hash opt-out inside the view', async () => {
    const h = makeHarness();
    const { view } = await h.read();

    expect([...view.statesByNameHashes([`0x${'AB'.repeat(32)}`, ZERO_HASH])])
      .toEqual([[NAME_9, view.resolve(id(9n))]]);
    expect(view.statesByNameHashes([ZERO_HASH]).size).toBe(0);
    expect(() => view.statesByNameHashes(['not-a-hash']))
      .toThrow('Context Graph authority index name hash is invalid');
  });

  it('answers inside T from the last completed projection with zero reads', async () => {
    const h = makeHarness();
    const first = await h.read();
    expect(h.reads.refreshes).toBe(1);
    const physical = h.physicalReads();
    expect(physical).toBeGreaterThan(0);

    h.clock.nowMs += T - 1;
    const second = await h.read();

    expect(second).toBe(first);
    expect(h.reads.refreshes).toBe(1);
    expect(h.physicalReads()).toBe(physical);
    expect(h.served).toEqual([
      { source: 'scan', ageMs: 0 },
      { source: 'cache', ageMs: T - 1 },
    ]);
  });

  it.each([Number.NaN, START_MS + 1])(
    'keeps log provenance when its data timestamp is unusable (%s)',
    async (dataFetchedAtMs) => {
      const h = makeHarness();
      const completed = await h.refresh();
      const evidence: ContextGraphAuthorityProjectionServedEvidence[] = [];
      const cache = new ContextGraphAuthorityIndexProjectionCache({
        tickMs: T,
        now: () => h.clock.nowMs,
      });

      const projection = await cache.read({
        scope: h.scope,
        project: (candidate) => ({ complete: true, value: candidate }),
        refresh: async () => Object.freeze({
          ...completed,
          origin: Object.freeze({ kind: 'log' as const, dataFetchedAtMs }),
        }),
        onServed: (served) => { evidence.push(served); },
      });

      expect(projection.fetchedAtMs).toBe(START_MS);
      expect(evidence).toEqual([{ source: 'log', ageMs: 0 }]);
    },
  );

  it('refreshes once the projection is T old, and sees what the chain did meanwhile', async () => {
    const h = makeHarness();
    expect((await h.read()).view.resolve(id(9n)).owner).toBe(OWNER);
    h.chain.events.push(transfer(9n, 26));
    h.chain.head = 26;

    h.clock.nowMs += T - 1;
    expect((await h.read()).view.resolve(id(9n)).owner).toBe(OWNER);
    h.clock.nowMs += 1;
    const refreshed = await h.read();

    expect(refreshed.view.resolve(id(9n)).owner).toBe(NEXT_OWNER);
    expect(refreshed.head.number).toBe(26);
    expect(h.reads.refreshes).toBe(2);
  });

  it('projects exactly once on the cache-expiry refresh path', async () => {
    const h = makeHarness();
    await h.read();
    h.clock.nowMs += T;
    const project = vi.fn((projection: ContextGraphAuthorityIndexCompletedProjection & {
      fetchedAtMs: number;
    }) => ({ complete: true, value: projection }));

    await h.index.projection({ scope: h.scope, project, refresh: h.refresh });

    expect(project).toHaveBeenCalledTimes(1);
    expect(h.reads.refreshes).toBe(2);
  });

  it('caches a legitimate undefined projection result without rescanning', async () => {
    const h = makeHarness();
    const readUndefined = () => h.index.projection({
      scope: h.scope,
      project: () => ({ complete: true, value: undefined }),
      refresh: h.refresh,
    });

    await expect(readUndefined()).resolves.toBeUndefined();
    await expect(readUndefined()).resolves.toBeUndefined();
    expect(h.reads.refreshes).toBe(1);
  });

  it('propagates a cached projector fault without buying another scan', async () => {
    const h = makeHarness();
    await h.read();

    await expect(h.index.projection({
      scope: h.scope,
      project: () => { throw new Error('projector failed'); },
      refresh: h.refresh,
    })).rejects.toThrow('projector failed');
    expect(h.reads.refreshes).toBe(1);
  });

  it('runs exactly one refresh for N concurrent callers of an expired projection', async () => {
    const h = makeHarness();
    await h.read();
    h.clock.nowMs += T;
    const release = h.holdRefresh();

    const callers = Array.from({ length: 8 }, () => h.read());
    await turns();
    // Every caller is parked on the ONE refresh; nothing resolved instantly.
    expect(h.reads.refreshes).toBe(2);
    release();
    const projections = await Promise.all(callers);

    expect(h.reads.refreshes).toBe(2);
    expect(new Set(projections).size).toBe(1);
    expect(h.served.slice(1).map(({ source }) => source).sort()).toEqual([
      ...Array.from({ length: 7 }, () => 'cache'), 'scan',
    ]);
  });

  it('never fails a waiter with the abort of the caller that started the refresh', async () => {
    const h = makeHarness();
    await h.read();
    h.clock.nowMs += T;
    const initiator = new AbortController();
    let initiatorEntered = false;
    const abandoned = h.read(9n, initiator.signal, () => new Promise((_resolve, reject) => {
      initiatorEntered = true;
      initiator.signal.addEventListener('abort', () => reject(initiator.signal.reason));
    }));
    const abandonedOutcome = abandoned.then(() => 'resolved', (error: Error) => error.message);
    await turns();
    expect(initiatorEntered).toBe(true);

    const waiters = [h.read(), h.read()];
    await turns();
    // Parked behind the initiator, not racing it.
    expect(h.reads.refreshes).toBe(1);

    initiator.abort(new Error('initiator left'));
    expect(await abandonedOutcome).toBe('initiator left');
    const projections = await Promise.all(waiters);

    for (const projection of projections) {
      expect(projection.view.resolve(id(9n)).owner).toBe(OWNER);
      expect(projection.fetchedAtMs).toBe(h.clock.nowMs);
    }
    // The initiator's abort is its own: it is not an RPC failure to back off from.
    expect(h.served.at(-1)?.source).not.toBe('stale-cache');
    // And the waiters coalesced behind the first of them to take over.
    expect(h.reads.refreshes).toBe(2);
    expect(projections[1]).toBe(projections[0]);
  });

  it('lets a caller refresh for itself after two settled unusable refreshes', async () => {
    const h = makeHarness();
    const completed = await h.refresh();
    const withoutTarget = makeHarness({ scope: h.scope });
    withoutTarget.chain.events = [];
    const unusableProjection = await withoutTarget.refresh();
    let attempts = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const unusable = (
      started: () => void,
      gate: Promise<void>,
    ) => async () => {
      attempts += 1;
      started();
      await gate;
      return unusableProjection;
    };

    const first = h.read(9n, undefined, unusable(markFirstStarted, firstGate));
    await firstStarted;
    // Registration order is intentional: this caller takes over first, while
    // the final caller observes and waits behind both unusable refreshes.
    const second = h.read(9n, undefined, unusable(markSecondStarted, secondGate));
    const bounded = h.read(9n, undefined, async () => {
      attempts += 1;
      return completed;
    });

    releaseFirst();
    await secondStarted;
    expect(attempts).toBe(2);
    releaseSecond();

    await expect(bounded).resolves.toMatchObject({ scope: h.scope });
    expect(attempts).toBe(3);
    await Promise.all([first, second]);
  });

  it('does not publish a non-initiating refresh that straddles clear', async () => {
    const h = makeHarness();
    const completed = await h.refresh();
    const cache = new ContextGraphAuthorityIndexProjectionCache({
      tickMs: T,
      now: () => h.clock.nowMs,
    });
    const withHead = (number: number): ContextGraphAuthorityIndexCompletedProjection =>
      Object.freeze({
        ...completed,
        head: Object.freeze({ ...completed.head, number }),
      });

    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let releaseDetached!: () => void;
    let releaseParallel!: () => void;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    let markDetachedStarted!: () => void;
    let markParallelStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const detachedGate = new Promise<void>((resolve) => { releaseDetached = resolve; });
    const parallelGate = new Promise<void>((resolve) => { releaseParallel = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const detachedStarted = new Promise<void>((resolve) => { markDetachedStarted = resolve; });
    const parallelStarted = new Promise<void>((resolve) => { markParallelStarted = resolve; });
    const complete = (projection: ContextGraphAuthorityIndexCompletedProjection) => ({
      complete: true,
      value: projection.head.number,
    });
    const incomplete = (projection: ContextGraphAuthorityIndexCompletedProjection) => ({
      complete: false,
      value: projection.head.number,
    });

    const first = cache.read({
      scope: h.scope,
      project: complete,
      refresh: async () => {
        markFirstStarted();
        await firstGate;
        return withHead(25);
      },
    });
    await firstStarted;

    const second = cache.read({
      scope: h.scope,
      project: incomplete,
      refresh: async () => {
        markSecondStarted();
        await secondGate;
        return withHead(26);
      },
    });
    let detached!: Promise<number>;
    let observations = 0;
    const parallel = cache.read({
      scope: h.scope,
      project: (projection) => {
        observations += 1;
        if (observations === 2) {
          // The second completed projection is still unusable for this caller.
          // Open a successor before it falls through to its own bounded scan,
          // making that final scan a non-initiator beside the successor.
          detached = cache.read({
            scope: h.scope,
            project: incomplete,
            refresh: async () => {
              markDetachedStarted();
              await detachedGate;
              return withHead(28);
            },
          });
        }
        return incomplete(projection);
      },
      refresh: async () => {
        markParallelStarted();
        await parallelGate;
        return withHead(27);
      },
    });

    releaseFirst();
    await secondStarted;
    releaseSecond();
    await Promise.all([detachedStarted, parallelStarted]);

    cache.clear();
    await expect(cache.read({
      scope: h.scope,
      project: complete,
      refresh: async () => withHead(99),
    })).resolves.toBe(99);

    releaseParallel();
    await expect(parallel).resolves.toBe(27);
    await expect(cache.read({
      scope: h.scope,
      project: complete,
      refresh: async () => { throw new Error('cleared refresh leaked into cache'); },
    })).resolves.toBe(99);

    releaseDetached();
    await expect(detached).resolves.toBe(28);
    await expect(cache.read({
      scope: h.scope,
      project: complete,
      refresh: async () => { throw new Error('detached refresh leaked into cache'); },
    })).resolves.toBe(99);
    await expect(first).resolves.toBe(25);
    await expect(second).resolves.toBe(26);
  });

  it('gives a waiter its own abort without touching the refresh it waited on', async () => {
    const h = makeHarness();
    await h.read();
    h.clock.nowMs += T;
    const release = h.holdRefresh();
    const initiator = h.read();
    await turns();
    const waiter = new AbortController();
    const waiting = h.read(9n, waiter.signal);
    await turns();

    waiter.abort(new Error('waiter left'));
    await expect(waiting).rejects.toThrow('waiter left');
    release();

    await expect(initiator).resolves.toMatchObject({ fetchedAtMs: h.clock.nowMs });
    expect(h.reads.refreshes).toBe(2);
  });

  it('serves the last projection through a failed refresh, but never past the bounded stale window', async () => {
    const h = makeHarness();
    const cached = await h.read();
    const outage = Object.assign(new Error('all endpoints exhausted'), {
      code: 'RPC_ENDPOINTS_EXHAUSTED',
    });
    h.failRefresh(outage);

    h.clock.nowMs = START_MS + 18_000;
    expect(await h.read()).toBe(cached);
    expect(h.served.at(-1)).toEqual({ source: 'stale-cache', ageMs: 18_000 });
    expect(h.reads.refreshes).toBe(2);

    h.clock.nowMs = START_MS + 18_001;
    // The refresh's OWN typed error: the RFC-64 circuit breaker keys on it.
    await expect(h.read()).rejects.toBe(outage);
    expect(h.reads.refreshes).toBe(3);

    h.failRefresh(undefined);
    expect((await h.read()).fetchedAtMs).toBe(START_MS + 18_001);
  });

  it('never masks a durable-index admission rejection with stale authority', async () => {
    const h = makeHarness();
    await h.read();
    h.clock.nowMs += T;
    const rejection = new ContextGraphAuthorityIndexRetryableError(
      'finalized head 90 is behind durable cursor 100',
    );
    h.failRefresh(rejection);

    await expect(h.read()).rejects.toBe(rejection);
    expect(h.served.map(({ source }) => source)).toEqual(['scan']);

    h.failRefresh(undefined);
    await expect(h.read()).resolves.toMatchObject({ fetchedAtMs: h.clock.nowMs });
    expect(h.reads.refreshes).toBe(3);
  });

  it('never masks a deterministic refresh fault with stale authority or backoff', async () => {
    const h = makeHarness();
    await h.read();
    h.clock.nowMs += T;
    const fault = new Error('authority response violated its deterministic shape');
    h.failRefresh(fault);

    await expect(h.read()).rejects.toBe(fault);
    await expect(h.read()).rejects.toBe(fault);
    expect(h.served.map(({ source }) => source)).toEqual(['scan']);
    // A deterministic fault is retried and reported on every read; it never
    // arms the one-tick transport-outage backoff.
    expect(h.reads.refreshes).toBe(3);
  });

  it('publishes a lower stabilized head after the retained newer head expires', async () => {
    const h = makeHarness();
    const newer = await h.read();
    h.clock.nowMs += T;
    const lower = await h.read(9n, undefined, async () => {
      h.reads.refreshes += 1;
      return Object.freeze({
        ...newer,
        finalized: { number: 24, hash: `0x${'24'.padStart(64, '0')}` },
        head: { ...newer.head, number: 24, hash: `0x${'24'.padStart(64, '0')}` },
      });
    });
    expect(lower.head.number).toBe(24);

    h.clock.nowMs += 1;
    expect(await h.read()).toBe(lower);
    expect(h.reads.refreshes).toBe(2);
    expect(h.served.at(-1)?.source).toBe('cache');
  });

  it('publishes a lower head once the retained projection is outside the timestamp tolerance', async () => {
    const tickMs = CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS * 2;
    const h = makeHarness({ tickMs });
    const newer = await h.read();
    h.clock.nowMs += CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS + 1;
    const lower = await h.read(9n, undefined, async () => {
      h.reads.refreshes += 1;
      return Object.freeze({
        ...newer,
        finalized: { number: 24, hash: `0x${'24'.padStart(64, '0')}` },
        head: {
          ...newer.head,
          number: 24,
          hash: `0x${'24'.padStart(64, '0')}`,
          timestampSeconds: Math.floor(h.clock.nowMs / 1_000) - 2,
        },
      });
    });
    expect(lower.head.number).toBe(24);

    h.clock.nowMs += 1;
    expect(await h.read()).toBe(lower);
    expect(h.reads.refreshes).toBe(2);
    expect(h.served.at(-1)?.source).toBe('cache');
  });

  it('pays one failed refresh per tick during an outage, not one per read', async () => {
    const h = makeHarness();
    const cached = await h.read();
    h.failRefresh(new RpcEndpointsExhaustedError('provider pool is down'));

    h.clock.nowMs = START_MS + T;
    expect(await h.read()).toBe(cached);
    expect(h.reads.refreshes).toBe(2);
    h.clock.nowMs += T - 1;
    expect(await h.read()).toBe(cached);
    expect(h.reads.refreshes).toBe(2);
    h.clock.nowMs += 1;
    expect(await h.read()).toBe(cached);
    expect(h.reads.refreshes).toBe(3);
    expect(h.served.slice(1).map(({ source }) => source))
      .toEqual(['stale-cache', 'stale-cache', 'stale-cache']);
  });

  it('never reports a failed cold read as absent', async () => {
    const h = makeHarness();
    const outage = new Error('provider pool is down');
    h.failRefresh(outage);
    await expect(h.read()).rejects.toBe(outage);
    expect(h.served).toEqual([]);
  });

  it('refuses a projection whose HEAD is stale in chain time, however fresh its fetch', async () => {
    // A responsive but lagging endpoint: asked just now, answered with a head
    // from well before the tolerance (security review S2).
    const h = makeHarness();
    h.chain.headLagSeconds = CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS / 1_000 + 1;
    const lagging = await h.read();
    expect(lagging.fetchedAtMs).toBe(h.clock.nowMs);

    const outage = new Error('provider pool is down');
    h.failRefresh(outage);
    h.clock.nowMs += 1;
    // 1ms old by fetch time, and still not an answer.
    await expect(h.read()).rejects.toBe(outage);
    expect(h.reads.refreshes).toBe(2);

    // Not a broken chain either: a working refresh is answered, just uncached.
    h.failRefresh(undefined);
    await h.read();
    await h.read();
    expect(h.reads.refreshes).toBe(4);
    expect(h.served.map(({ source }) => source)).toEqual(['scan', 'scan', 'scan']);
  });

  it('keeps answering a head that is inside the chain-time tolerance', async () => {
    const h = makeHarness();
    h.chain.headLagSeconds = CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS / 1_000 - 10;
    await h.read();
    h.clock.nowMs += T - 1;
    await h.read();
    expect(h.reads.refreshes).toBe(1);
  });

  it('publishes and reuses a head whose chain timestamp is in the future', async () => {
    const h = makeHarness();
    h.chain.headLagSeconds = -60;
    const published = await h.read();

    h.clock.nowMs += T - 1;
    expect(await h.read()).toBe(published);
    expect(h.reads.refreshes).toBe(1);
    expect(h.served.map(({ source }) => source)).toEqual(['scan', 'cache']);
  });

  it('never retains a projection whose head carries no chain time', async () => {
    const h = makeHarness();
    h.chain.withoutTimestamp = true;
    await h.read();
    await h.read();
    expect(h.reads.refreshes).toBe(2);
  });

  it('drops the projection when the index is cleared (Hub or contract rotation)', async () => {
    const h = makeHarness();
    await h.read();
    h.index.clear();
    await h.read();
    expect(h.reads.refreshes).toBe(2);
  });

  it('does not invalidate an in-flight refresh for an unrelated scope', async () => {
    const h = makeHarness();
    const cache = new ContextGraphAuthorityIndexProjectionCache({
      tickMs: T,
      now: () => h.clock.nowMs,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let refreshes = 0;
    const input = {
      scope: 'scope-b',
      project: (projection: { scope: string }) => ({ complete: true, value: projection.scope }),
      refresh: async () => {
        refreshes += 1;
        await gate;
        return { ...await h.refresh(), scope: 'scope-b' };
      },
    };
    const pending = cache.read(input);
    await turns();

    cache.drop('scope-a');
    release();
    await expect(pending).resolves.toBe('scope-b');
    await expect(cache.read(input)).resolves.toBe('scope-b');
    expect(refreshes).toBe(1);
  });

  it('drops one scope generation and releases its in-flight slot immediately', async () => {
    const h = makeHarness();
    const cache = new ContextGraphAuthorityIndexProjectionCache({
      tickMs: T,
      now: () => h.clock.nowMs,
    });
    const oldProjection = await h.refresh();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let refreshes = 0;
    const project = (projection: { head: { number: number } }) => ({
      complete: true,
      value: projection.head.number,
    });
    const first = cache.read({
      scope: h.scope,
      project,
      refresh: async () => {
        refreshes += 1;
        await gate;
        return oldProjection;
      },
    });
    await turns();
    cache.drop(h.scope);
    h.chain.head = 26;
    await expect(cache.read({
      scope: h.scope,
      project,
      refresh: async () => {
        refreshes += 1;
        return h.refresh();
      },
    })).resolves.toBe(26);
    release();
    await expect(first).resolves.toBe(25);
    await expect(cache.read({
      scope: h.scope,
      project,
      refresh: async () => {
        refreshes += 1;
        return h.refresh();
      },
    })).resolves.toBe(26);
    expect(refreshes).toBe(2);
  });

  it('does not let a refresh that started before a clear publish after it', async () => {
    const h = makeHarness();
    const release = h.holdRefresh();
    const straddling = h.read(9n, undefined, async () => {
      const completed = await h.refresh();
      h.index.clear();
      return completed;
    });
    release();
    await straddling;
    expect(h.reads.refreshes).toBe(1);
    await h.read();
    expect(h.reads.refreshes).toBe(2);
  });

  it('fences a cold projection refresh when the durable horizon advances', async () => {
    const h = makeHarness();
    const staleProjection = await h.refresh();
    let staleStarted!: () => void;
    const started = new Promise<void>((resolve) => { staleStarted = resolve; });
    let releaseStale!: () => void;
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    const staleRead = h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => {
        staleStarted();
        await staleGate;
        return staleProjection;
      },
    });
    await started;

    h.chain.head = 26;
    const hash = (block: number): string => `0x${block.toString(16).padStart(64, '0')}`;
    await h.index.refresh({
      scope: h.scope,
      readScope: h.chain,
      deploymentBlockNumber: 10,
      finalized: { number: 26, hash: hash(26) },
      pageSize: 100,
      readBlockHash: async (block) => hash(block),
      readPage: async () => [],
    });
    let replacementRefreshes = 0;
    const replacement = h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => {
        replacementRefreshes += 1;
        return {
          ...staleProjection,
          finalized: { number: 26, hash: hash(26) },
          head: { ...staleProjection.head, number: 26, hash: hash(26) },
        };
      },
    });
    await turns();
    expect(replacementRefreshes).toBe(1);
    await expect(replacement).resolves.toBe(26);

    releaseStale();
    await expect(staleRead).rejects.toMatchObject({ reason: 'refresh-horizon-ahead' });
    await expect(h.index.peekProjection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
    })).resolves.toEqual({ hit: true, value: 26 });
  });

  it('fences a projection refresh that starts during a durable scan', async () => {
    const h = makeHarness();
    const staleProjection = await h.refresh();
    const hash = (block: number): string => `0x${block.toString(16).padStart(64, '0')}`;
    let scanStarted!: () => void;
    const startedScan = new Promise<void>((resolve) => { scanStarted = resolve; });
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    h.chain.head = 26;
    const advancing = h.index.refresh({
      scope: h.scope,
      readScope: h.chain,
      deploymentBlockNumber: 10,
      finalized: { number: 26, hash: hash(26) },
      pageSize: 100,
      readBlockHash: async (block) => hash(block),
      readPage: async () => {
        scanStarted();
        await scanGate;
        return [];
      },
    });
    await startedScan;

    let releaseStale!: () => void;
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    const staleRead = h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => {
        await staleGate;
        return staleProjection;
      },
    });
    await turns();
    releaseScan();
    await advancing;
    releaseStale();
    await expect(staleRead).rejects.toMatchObject({ reason: 'refresh-horizon-ahead' });

    let replacementRefreshes = 0;
    await expect(h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => {
        replacementRefreshes += 1;
        return {
          ...staleProjection,
          finalized: { number: 26, hash: hash(26) },
          head: { ...staleProjection.head, number: 26, hash: hash(26) },
        };
      },
    })).resolves.toBe(26);
    expect(replacementRefreshes).toBe(1);
  });

  it('keeps the durable refresh horizon above its persisted holdback cursor', async () => {
    const h = makeHarness();
    const baseProjection = await h.refresh();
    const hash = (block: number): string => `0x${block.toString(16).padStart(64, '0')}`;
    h.chain.head = 1_000;
    await h.index.refresh({
      scope: h.scope,
      readScope: h.chain,
      deploymentBlockNumber: 10,
      finalized: { number: 1_000, hash: hash(1_000) },
      pageSize: 1_000,
      durableReorgHoldbackBlocks: 50,
      readBlockHash: async (block) => hash(block),
      readPage: async (from, to) => h.chain.events
        .filter((event) => event.blockNumber >= from && event.blockNumber <= to)
        .map((event) => ({ ...event, blockHash: hash(event.blockNumber) })),
    });

    const laggingProjection = {
      ...baseProjection,
      finalized: { number: 970, hash: hash(970) },
      head: { ...baseProjection.head, number: 970, hash: hash(970) },
    };
    const laggingRead = () => h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => laggingProjection,
    });
    await expect(laggingRead()).rejects.toMatchObject({ reason: 'refresh-horizon-ahead' });
    await expect(laggingRead()).rejects.toMatchObject({ reason: 'refresh-horizon-ahead' });
    await expect(h.index.peekProjection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
    })).resolves.toEqual({ hit: false });

    let currentRefreshes = 0;
    await expect(h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => {
        currentRefreshes += 1;
        return {
          ...baseProjection,
          finalized: { number: 1_000, hash: hash(1_000) },
          head: { ...baseProjection.head, number: 1_000, hash: hash(1_000) },
        };
      },
    })).resolves.toBe(1_000);
    expect(currentRefreshes).toBe(1);
  });

  it('rolls a failed higher physical refresh back before admitting a healthy lower horizon', async () => {
    const h = makeHarness();
    const baseProjection = await h.refresh();
    const hash = (block: number): string => `0x${block.toString(16).padStart(64, '0')}`;

    await expect(h.index.refresh({
      scope: h.scope,
      readScope: { provider: 'failed-high' },
      deploymentBlockNumber: 10,
      finalized: { number: 1_000, hash: hash(1_000) },
      pageSize: 1_000,
      readBlockHash: async (block) => hash(block),
      readPage: async () => { throw new Error('high provider failed'); },
    })).rejects.toThrow('high provider failed');

    h.chain.head = 26;
    await h.index.refresh({
      scope: h.scope,
      readScope: { provider: 'healthy-lower' },
      deploymentBlockNumber: 10,
      finalized: { number: 26, hash: hash(26) },
      pageSize: 100,
      readBlockHash: async (block) => hash(block),
      readPage: async () => [],
    });

    let refreshes = 0;
    const read = () => h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => {
        refreshes += 1;
        return {
          ...baseProjection,
          finalized: { number: 26, hash: hash(26) },
          head: { ...baseProjection.head, number: 26, hash: hash(26) },
        };
      },
    });
    await expect(read()).resolves.toBe(26);
    await expect(read()).resolves.toBe(26);
    expect(refreshes).toBe(1);
  });

  it('rolls back an active high horizon when its lifecycle stabilization fails', async () => {
    const h = makeHarness();
    const hash = (block: number): string => `0x${block.toString(16).padStart(64, '0')}`;
    const readPage = async (from: number, to: number) => h.chain.events
      .filter((event) => event.blockNumber >= from && event.blockNumber <= to)
      .map((event) => ({ ...event, blockHash: hash(event.blockNumber) }));

    await expect(h.index.refresh({
      scope: h.scope,
      readScope: { provider: 'unstable-high' },
      deploymentBlockNumber: 10,
      finalized: { number: 1_000, hash: hash(1_000) },
      pageSize: 1_000,
      durableReorgHoldbackBlocks: 50,
      readBlockHash: async (block) => hash(block),
      readPage,
      stabilize: async () => {
        throw new ContextGraphAuthorityIndexRetryableError('high anchor moved');
      },
    })).rejects.toThrow('high anchor moved');

    // The failed scan left a reusable H950 durable prefix. H970 may extend it;
    // only a wrongly committed tentative H1000 publication floor can reject it.
    await expect(h.index.view({
      scope: h.scope,
      readScope: { provider: 'healthy-lower' },
      deploymentBlockNumber: 10,
      finalized: { number: 970, hash: hash(970) },
      pageSize: 1_000,
      durableReorgHoldbackBlocks: 20,
      readBlockHash: async (block) => hash(block),
      readPage,
    })).resolves.toSatisfy((view) => view.has(id(9n)));
  });

  it('keeps an inactive view lease alive across projection invalidation', async () => {
    const h = makeHarness();
    const staleProjection = await h.refresh();
    const forkHash = (block: number): string => (
      `0x${(1_000_000 + block).toString(16).padStart(64, '0')}`
    );
    const anchorRead = Promise.withResolvers<void>();
    const releaseAnchor = Promise.withResolvers<void>();
    const rebuilding = h.index.view({
      scope: h.scope,
      readScope: { provider: 'replacement' },
      deploymentBlockNumber: 10,
      finalized: { number: 26, hash: forkHash(26) },
      pageSize: 100,
      readBlockHash: async (block) => {
        anchorRead.resolve();
        await releaseAnchor.promise;
        return forkHash(block);
      },
      readPage: async (from, to) => h.chain.events
        .filter((event) => event.blockNumber >= from && event.blockNumber <= to)
        .map((event) => ({ ...event, blockHash: forkHash(event.blockNumber) })),
    });
    await anchorRead.promise;
    h.index.dropProjections();
    releaseAnchor.resolve();
    await expect(rebuilding).resolves.toSatisfy((view) => view.has(id(9n)));

    await expect(h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => staleProjection,
    })).rejects.toMatchObject({ reason: 'refresh-horizon-ahead' });
  });

  it('lets a later stabilized view finish recovery from a failed rejecting scan', async () => {
    const h = makeHarness();
    const baseProjection = await h.refresh();
    const oldHash = (block: number): string => (
      `0x${block.toString(16).padStart(64, '0')}`
    );
    const newHash = (block: number): string => (
      `0x${(1_000_000 + block).toString(16).padStart(64, '0')}`
    );
    await h.index.refresh({
      scope: h.scope,
      readScope: { provider: 'old-floor' },
      deploymentBlockNumber: 10,
      finalized: { number: 25, hash: oldHash(25) },
      pageSize: 100,
      readBlockHash: async (block) => oldHash(block),
      readPage: async () => [],
    });
    await expect(h.index.view({
      scope: h.scope,
      readScope: { provider: 'failed-replacement' },
      deploymentBlockNumber: 10,
      finalized: { number: 29, hash: newHash(29) },
      pageSize: 100,
      readBlockHash: async (block) => newHash(block),
      readPage: async () => { throw new Error('replacement failed after rejection'); },
    })).rejects.toThrow('replacement failed after rejection');

    await expect(h.index.view({
      scope: h.scope,
      readScope: { provider: 'later-recovery' },
      deploymentBlockNumber: 10,
      finalized: { number: 26, hash: newHash(26) },
      pageSize: 100,
      readBlockHash: async (block) => newHash(block),
      readPage: async (from, to) => h.chain.events
        .filter((event) => event.blockNumber >= from && event.blockNumber <= to)
        .map((event) => ({ ...event, blockHash: newHash(event.blockNumber) })),
    })).resolves.toSatisfy((view) => view.has(id(9n)));
    await expect(h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => ({
        ...baseProjection,
        finalized: { number: 26, hash: newHash(26) },
        head: { ...baseProjection.head, number: 26, hash: newHash(26) },
      }),
    })).resolves.toBe(26);
  });

  it('does not let a pre-invalidation checkpoint clear its pending rejection fence', async () => {
    const h = makeHarness();
    const oldHash = (block: number): string => (
      `0x${block.toString(16).padStart(64, '0')}`
    );
    const newHash = (block: number): string => (
      `0x${(1_000_000 + block).toString(16).padStart(64, '0')}`
    );
    await h.index.refresh({
      scope: h.scope,
      readScope: { provider: 'old-floor' },
      deploymentBlockNumber: 10,
      finalized: { number: 25, hash: oldHash(25) },
      pageSize: 100,
      readBlockHash: async (block) => oldHash(block),
      readPage: async () => [],
    });

    const invalidationEntered = Promise.withResolvers<void>();
    const releaseInvalidation = Promise.withResolvers<void>();
    const originalInvalidate = h.store.invalidate.bind(h.store);
    h.store.invalidate = async (scope, token) => {
      invalidationEntered.resolve();
      await releaseInvalidation.promise;
      return originalInvalidate(scope, token);
    };
    const rejecting = h.index.refresh({
      scope: h.scope,
      readScope: { provider: 'new-rejecting' },
      deploymentBlockNumber: 10,
      finalized: { number: 29, hash: newHash(29) },
      pageSize: 100,
      durableReorgHoldbackBlocks: 4,
      readBlockHash: async (block) => newHash(block),
      readPage: async () => { throw new Error('replacement failed after rejection'); },
    });
    await invalidationEntered.promise;

    // This scan begins after the logical rejection, but while token 1 still
    // exposes the rejected old-fork checkpoint. Its H26-H29 tail never writes.
    await h.index.refresh({
      scope: h.scope,
      readScope: { provider: 'pre-invalidation-old' },
      deploymentBlockNumber: 10,
      finalized: { number: 29, hash: oldHash(29) },
      pageSize: 100,
      durableReorgHoldbackBlocks: 4,
      readBlockHash: async (block) => oldHash(block),
      readPage: async () => [],
    });

    releaseInvalidation.resolve();
    await expect(rejecting).rejects.toThrow('replacement failed after rejection');
    expect(h.store.record?.value).toBeNull();

    // The late tombstone is the durable fact. Neither same-height fork may be
    // admitted until a physical scan proves it rebuilt from that generation.
    for (const hash of [oldHash(29), newHash(29)]) {
      await expect(Promise.resolve().then(() => {
        h.index.assertProjectionAtRefreshHorizon(h.scope, { number: 29, hash });
      })).rejects.toMatchObject({ reason: 'refresh-horizon-ahead' });
    }
  });

  it('does not let a fallback started during trusted invalidation clear the rejection', async () => {
    const oldHash = (block: number): string => (
      `0x${block.toString(16).padStart(64, '0')}`
    );
    const newHash = (block: number): string => (
      `0x${(1_000_000 + block).toString(16).padStart(64, '0')}`
    );
    const checkpoint = reduceContextGraphAuthorityIndexPage({
      deploymentBlockNumber: 10,
      throughBlockNumber: 25,
      throughBlockHash: oldHash(25),
      events: [{ ...creation(9n, 10), blockHash: oldHash(10) }],
    }).checkpoint;
    const trustDomain = 'pending-invalidation-fallback';
    const trustedScope = `${SCOPE}:trusted-bootstrap:${trustDomain}`;
    const store = new ScopedAuthorityIndexStore();
    store.records.set(trustedScope, { token: 3, value: checkpoint });
    store.records.set(SCOPE, { token: 7, value: checkpoint });
    const invalidationEntered = Promise.withResolvers<void>();
    const releaseInvalidation = Promise.withResolvers<void>();
    store.invalidate.mockImplementation(async (scope, token) => {
      if (scope === trustedScope && token === 3) {
        invalidationEntered.resolve();
        await releaseInvalidation.promise;
      }
      if (store.records.get(scope)?.token !== token) return undefined;
      store.records.set(scope, { token: token + 1, value: null });
      return token + 1;
    });
    const index = new ContextGraphAuthorityIndex(store, {
      trustDomain,
      maxTailBlocks: 200,
      fetchSnapshot: async () => { throw new Error('trusted cores unavailable'); },
      localHistoryFallback: true,
    });

    // This scan records the trusted-key rejection, then pauses before its
    // tombstone CAS becomes a durable recovery boundary.
    const rejecting = index.refresh({
      scope: SCOPE,
      readScope: { provider: 'new-rejecting' },
      deploymentBlockNumber: 10,
      finalized: { number: 230, hash: newHash(230) },
      pageSize: 500,
      durableReorgHoldbackBlocks: 4,
      readBlockHash: async (block) => {
        if (block === 25) return newHash(block);
        throw new Error('new-fork follow-up stopped');
      },
      readPage: async () => [],
    });
    await invalidationEntered.promise;

    // This conflicting scan starts under the new rejection revision. Its
    // trusted row is too old to seed H230, so it falls back to the existing
    // plain checkpoint and completes on the old fork while the trusted CAS is
    // still pending. Start time alone must not make that checkpoint a recovery
    // boundary for the rejected trusted key.
    let oldForkPages = 0;
    let oldForkStabilizations = 0;
    await index.refresh({
      scope: SCOPE,
      readScope: { provider: 'old-fallback' },
      deploymentBlockNumber: 10,
      finalized: { number: 230, hash: oldHash(230) },
      pageSize: 500,
      durableReorgHoldbackBlocks: 4,
      readBlockHash: async (block) => oldHash(block),
      readPage: async () => {
        oldForkPages += 1;
        return [];
      },
      stabilize: async () => { oldForkStabilizations += 1; },
    });
    expect(oldForkPages).toBe(2);
    expect(oldForkStabilizations).toBe(1);

    releaseInvalidation.resolve();
    await expect(rejecting).rejects.toThrow('new-fork follow-up stopped');
    expect(store.records.get(trustedScope)).toEqual({ token: 4, value: null });

    // The late trusted tombstone is still the decisive durable fact. The
    // alternate-key scan cannot clear its fence retroactively.
    for (const hash of [oldHash(230), newHash(230)]) {
      await expect(Promise.resolve().then(() => {
        index.assertProjectionAtRefreshHorizon(SCOPE, { number: 230, hash });
      })).rejects.toMatchObject({ reason: 'refresh-horizon-ahead' });
    }
  });

  it('does not let a late waiter launder pre-rejection single-flight work into recovery', async () => {
    const h = makeHarness();
    const oldHash = (block: number): string => (
      `0x${block.toString(16).padStart(64, '0')}`
    );
    const newHash = (block: number): string => (
      `0x${(1_000_000 + block).toString(16).padStart(64, '0')}`
    );
    await h.index.refresh({
      scope: h.scope,
      readScope: { provider: 'old-floor' },
      deploymentBlockNumber: 10,
      finalized: { number: 25, hash: oldHash(25) },
      pageSize: 100,
      readBlockHash: async (block) => oldHash(block),
      readPage: async () => [],
    });

    const oldProvider = { provider: 'shared-old' };
    const oldTailEntered = Promise.withResolvers<void>();
    const releaseOldTail = Promise.withResolvers<void>();
    let oldTailReads = 0;
    const oldRefresh = () => h.index.refresh({
      scope: h.scope,
      readScope: oldProvider,
      deploymentBlockNumber: 10,
      finalized: { number: 29, hash: oldHash(29) },
      pageSize: 100,
      durableReorgHoldbackBlocks: 4,
      readBlockHash: async (block) => oldHash(block),
      readPage: async () => {
        oldTailReads += 1;
        oldTailEntered.resolve();
        await releaseOldTail.promise;
        return [];
      },
    });
    const physicalOwner = oldRefresh();
    await oldTailEntered.promise;

    await expect(h.index.refresh({
      scope: h.scope,
      readScope: { provider: 'new-rejecting' },
      deploymentBlockNumber: 10,
      finalized: { number: 29, hash: newHash(29) },
      pageSize: 100,
      durableReorgHoldbackBlocks: 4,
      readBlockHash: async (block) => newHash(block),
      readPage: async () => { throw new Error('replacement failed after rejection'); },
    })).rejects.toThrow('replacement failed after rejection');
    expect(h.store.record?.value).toBeNull();

    // The waiter starts under the rejection revision but joins physical work
    // that loaded token 1 before that rejection. It must inherit the owner's
    // recovery provenance rather than manufacture its own.
    const lateWaiter = oldRefresh();
    releaseOldTail.resolve();
    await Promise.all([physicalOwner, lateWaiter]);
    expect(oldTailReads).toBe(1);
    expect(h.store.record?.value).toBeNull();

    await expect(Promise.resolve().then(() => {
      h.index.assertProjectionAtRefreshHorizon(h.scope, {
        number: 29,
        hash: oldHash(29),
      });
    })).rejects.toMatchObject({ reason: 'refresh-horizon-ahead' });
  });

  it('lets an active waiter fence through an inactive physical flight owner', async () => {
    const h = makeHarness();
    await h.read();
    const hash = (block: number): string => `0x${block.toString(16).padStart(64, '0')}`;
    const provider = { provider: 'shared' };
    const pageEntered = Promise.withResolvers<void>();
    const releasePage = Promise.withResolvers<void>();
    let pageReads = 0;
    const input = {
      scope: h.scope,
      readScope: provider,
      deploymentBlockNumber: 10,
      finalized: { number: 26, hash: hash(26) },
      pageSize: 100,
      readBlockHash: async (block: number) => hash(block),
      readPage: async () => {
        pageReads += 1;
        pageEntered.resolve();
        await releasePage.promise;
        return [];
      },
    };

    // `view()` owns the one physical page without publishing an active floor.
    const inactiveOwner = h.index.view(input);
    await pageEntered.promise;
    expect(pageReads).toBe(1);
    expect(() => h.index.assertProjectionAtRefreshHorizon(h.scope, {
      number: 25,
      hash: hash(25),
    })).not.toThrow();

    // The active caller joins that flight. Its lease must fence immediately;
    // it must not wait for the inactive owner's physical page to settle.
    const activeJoiner = h.index.refresh(input);
    await expect(Promise.resolve().then(() => {
      h.index.assertProjectionAtRefreshHorizon(h.scope, {
        number: 25,
        hash: hash(25),
      });
    })).rejects.toMatchObject({ reason: 'refresh-horizon-ahead' });
    await expect(h.index.peekProjection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
    })).resolves.toEqual({ hit: false });

    releasePage.resolve();
    await Promise.all([inactiveOwner, activeJoiner]);
    expect(pageReads).toBe(1);
    expect(() => h.index.assertProjectionAtRefreshHorizon(h.scope, {
      number: 26,
      hash: hash(26),
    })).not.toThrow();
  });

  it('does not trust a pre-rejection tombstone descendant until it is re-admitted', async () => {
    const cache = new ContextGraphAuthorityIndexProjectionCache();
    const repositoryKey = `${SCOPE}:durable`;
    const oldHash = `0x${(29).toString(16).padStart(64, '0')}`;
    const newHash = `0x${(1_000_029).toString(16).padStart(64, '0')}`;

    // This physical scan started from tombstone token 2 and committed a first
    // page at token 3 before any rejection existed.
    const preRejection = cache.beginRefreshHorizon(
      SCOPE,
      { number: 29, hash: oldHash },
      false,
    );
    preRejection.admitDurableGeneration(repositoryKey, 'tombstone', 2);
    preRejection.commitDurableGeneration(repositoryKey, 3);

    // A competing provider rejects checkpoint token 3 and begins its
    // conditional invalidation. The old physical scan then wins that CAS by
    // committing token 4, but has not re-admitted token 4 after the rejection.
    const rejecting = cache.beginRefreshHorizon(
      SCOPE,
      { number: 29, hash: newHash },
      true,
    );
    rejecting.markCheckpointRejected(repositoryKey, 3);
    preRejection.commitDurableGeneration(repositoryKey, 4);

    const proof = preRejection.recoveryProof();
    expect(proof).toBeUndefined();
    preRejection.commit({ checkpointRejected: false, recoveryProof: proof });
    await expect(Promise.resolve().then(() => {
      cache.assertAtOrAboveRefreshHorizon(SCOPE, { number: 29, hash: oldHash });
    })).rejects.toMatchObject({ reason: 'refresh-horizon-ahead' });

    // The rejecting scan force-rejects that descendant too, then rebuilds only
    // after its token-4 invalidation establishes tombstone token 5.
    rejecting.markCheckpointRejected(repositoryKey, 4);
    rejecting.markCheckpointRecovery(repositoryKey, 4, 5);
    rejecting.admitDurableGeneration(repositoryKey, 'tombstone', 5);
    rejecting.commitDurableGeneration(repositoryKey, 6);
    const recoveryProof = rejecting.recoveryProof();
    expect(recoveryProof).toBeDefined();
    rejecting.commit({ checkpointRejected: true, recoveryProof });
    expect(() => cache.assertAtOrAboveRefreshHorizon(
      SCOPE,
      { number: 29, hash: newHash },
    )).not.toThrow();
  });

  it('does not let a multi-page root lineage advance past a later rejection', () => {
    const cache = new ContextGraphAuthorityIndexProjectionCache();
    const repositoryKey = `${SCOPE}:durable`;
    const oldHash = `0x${(29).toString(16).padStart(64, '0')}`;
    const newHash = `0x${(1_000_029).toString(16).padStart(64, '0')}`;
    const older = cache.beginRefreshHorizon(SCOPE, { number: 29, hash: oldHash }, false);
    older.admitDurableGeneration(repositoryKey, 'tombstone', 2);
    older.commitDurableGeneration(repositoryKey, 3);

    const rejecting = cache.beginRefreshHorizon(SCOPE, { number: 29, hash: newHash }, true);
    rejecting.admitDurableGeneration(repositoryKey, 'checkpoint', 3);
    older.commitDurableGeneration(repositoryKey, 4);
    rejecting.markCheckpointRejected(repositoryKey, 3);
    older.commitDurableGeneration(repositoryKey, 5);

    const proof = older.recoveryProof();
    expect(proof).toBeUndefined();
    older.commit({ checkpointRejected: false, recoveryProof: proof });
    rejecting.rollback();
    expect(() => cache.assertAtOrAboveRefreshHorizon(
      SCOPE,
      { number: 29, hash: oldHash },
    )).toThrow('behind durable refresh horizon');
  });

  it('does not let a pre-rejection root on another repository clear the fence', () => {
    const cache = new ContextGraphAuthorityIndexProjectionCache();
    const oldHash = `0x${(29).toString(16).padStart(64, '0')}`;
    const newHash = `0x${(1_000_029).toString(16).padStart(64, '0')}`;
    const fallback = cache.beginRefreshHorizon(SCOPE, { number: 29, hash: oldHash }, false);
    fallback.admitDurableGeneration(`${SCOPE}:plain`, 'missing', undefined);

    const rejecting = cache.beginRefreshHorizon(SCOPE, { number: 29, hash: newHash }, true);
    rejecting.markCheckpointRejected(`${SCOPE}:trusted`, 3);
    fallback.commitDurableGeneration(`${SCOPE}:plain`, 1);

    const proof = fallback.recoveryProof();
    expect(proof).toBeUndefined();
    fallback.commit({ checkpointRejected: false, recoveryProof: proof });
    rejecting.rollback();
    expect(() => cache.assertAtOrAboveRefreshHorizon(
      SCOPE,
      { number: 29, hash: oldHash },
    )).toThrow('behind durable refresh horizon');
  });

  it.each([4, 7])(
    'does not use plain-fallback token %i to discharge a trusted-bootstrap rejection',
    async (plainToken) => {
      const oldHash = (block: number): string => (
        `0x${block.toString(16).padStart(64, '0')}`
      );
      const newHash = (block: number): string => (
        `0x${(1_000_000 + block).toString(16).padStart(64, '0')}`
      );
      const checkpoint = (hash: (block: number) => string) => (
        reduceContextGraphAuthorityIndexPage({
          deploymentBlockNumber: 10,
          throughBlockNumber: 25,
          throughBlockHash: hash(25),
          events: [{ ...creation(9n, 10), blockHash: hash(10) }],
        }).checkpoint
      );
      const trustDomain = 'projection-recovery-boundary';
      const trustedScope = `${SCOPE}:trusted-bootstrap:${trustDomain}`;
      const store = new ScopedAuthorityIndexStore();
      store.records.set(trustedScope, { token: 3, value: checkpoint(oldHash) });
      store.records.set(SCOPE, { token: plainToken, value: checkpoint(newHash) });
      let fallbacks = 0;
      let pageReads = 0;
      let stabilizations = 0;
      let cursorReads = 0;
      const plainAdmissionEntered = Promise.withResolvers<void>();
      const releasePlainAdmission = Promise.withResolvers<void>();
      const index = new ContextGraphAuthorityIndex(store, {
        trustDomain,
        maxTailBlocks: 200,
        fetchSnapshot: async () => { throw new Error('trusted cores unavailable'); },
        localHistoryFallback: true,
        onLocalHistoryFallback: () => { fallbacks += 1; },
      });

      const refreshing = index.refresh({
        scope: SCOPE,
        readScope: { provider: 'fallback' },
        deploymentBlockNumber: 10,
        finalized: { number: 29, hash: newHash(29) },
        pageSize: 100,
        durableReorgHoldbackBlocks: 4,
        readBlockHash: async (block) => {
          if (block === 25) {
            cursorReads += 1;
            if (cursorReads === 2) {
              plainAdmissionEntered.resolve();
              await releasePlainAdmission.promise;
            }
          }
          return newHash(block);
        },
        readPage: async () => {
          pageReads += 1;
          return [];
        },
        stabilize: async () => { stabilizations += 1; },
      });

      await plainAdmissionEntered.promise;
      expect(fallbacks).toBe(1);
      expect(store.records.get(trustedScope)).toEqual({ token: 4, value: null });
      expect(store.records.get(SCOPE)?.token).toBe(plainToken);
      await expect(Promise.resolve().then(() => {
        index.assertProjectionAtRefreshHorizon(SCOPE, {
          number: 29,
          hash: newHash(29),
        });
      })).rejects.toMatchObject({ reason: 'refresh-horizon-ahead' });

      // Numeric ordering alone did not recover. Actual plain-scope admission,
      // tail completion and stabilization now prove the independent lineage.
      releasePlainAdmission.resolve();
      await refreshing;
      expect(pageReads).toBe(1);
      expect(stabilizations).toBe(1);
      expect(() => index.assertProjectionAtRefreshHorizon(SCOPE, {
        number: 29,
        hash: newHash(29),
      })).not.toThrow();
    },
  );

  it('lets a later fallback recover after an earlier trusted rejection failed', async () => {
    const oldHash = (block: number): string => (
      `0x${block.toString(16).padStart(64, '0')}`
    );
    const newHash = (block: number): string => (
      `0x${(1_000_000 + block).toString(16).padStart(64, '0')}`
    );
    const checkpoint = (hash: (block: number) => string) => (
      reduceContextGraphAuthorityIndexPage({
        deploymentBlockNumber: 10,
        throughBlockNumber: 25,
        throughBlockHash: hash(25),
        events: [{ ...creation(9n, 10), blockHash: hash(10) }],
      }).checkpoint
    );
    const trustDomain = 'later-fallback-recovery';
    const trustedScope = `${SCOPE}:trusted-bootstrap:${trustDomain}`;
    const store = new ScopedAuthorityIndexStore();
    store.records.set(trustedScope, { token: 3, value: checkpoint(oldHash) });
    store.records.set(SCOPE, { token: 7, value: checkpoint(newHash) });
    let failFirstPlainLoad = true;
    store.load.mockImplementation(async (scope) => {
      if (scope === SCOPE && failFirstPlainLoad) {
        failFirstPlainLoad = false;
        throw new Error('plain repository unavailable once');
      }
      return store.records.get(scope);
    });
    const index = new ContextGraphAuthorityIndex(store, {
      trustDomain,
      maxTailBlocks: 200,
      fetchSnapshot: async () => { throw new Error('trusted cores unavailable'); },
      localHistoryFallback: true,
    });
    let pageReads = 0;
    let stabilizations = 0;
    const input = (readScope: object) => ({
      scope: SCOPE,
      readScope,
      deploymentBlockNumber: 10,
      finalized: { number: 29, hash: newHash(29) },
      pageSize: 100,
      durableReorgHoldbackBlocks: 4,
      readBlockHash: async (block: number) => newHash(block),
      readPage: async () => {
        pageReads += 1;
        return [];
      },
      stabilize: async () => { stabilizations += 1; },
    });

    await expect(index.refresh(input({ provider: 'first' }))).rejects.toThrow(
      'plain repository unavailable once',
    );
    expect(store.records.get(trustedScope)).toEqual({ token: 4, value: null });
    expect(() => index.assertProjectionAtRefreshHorizon(
      SCOPE,
      { number: 29, hash: newHash(29) },
    )).toThrow('behind durable refresh horizon');

    await expect(index.refresh(input({ provider: 'later' }))).resolves.toBeUndefined();
    expect(pageReads).toBe(1);
    expect(stabilizations).toBe(1);
    expect(() => index.assertProjectionAtRefreshHorizon(
      SCOPE,
      { number: 29, hash: newHash(29) },
    )).not.toThrow();
  });

  it('does not let an older rejecting scan overwrite a newer recovery', async () => {
    const h = makeHarness();
    const baseProjection = await h.refresh();
    const oldHash = (block: number): string => (
      `0x${block.toString(16).padStart(64, '0')}`
    );
    const newHash = (block: number): string => (
      `0x${(1_000_000 + block).toString(16).padStart(64, '0')}`
    );
    await h.index.refresh({
      scope: h.scope,
      readScope: { provider: 'old-floor' },
      deploymentBlockNumber: 10,
      finalized: { number: 25, hash: oldHash(25) },
      pageSize: 100,
      readBlockHash: async (block) => oldHash(block),
      readPage: async () => [],
    });
    const rejected = Promise.withResolvers<void>();
    const releaseOld = Promise.withResolvers<void>();
    const older = h.index.view({
      scope: h.scope,
      readScope: { provider: 'older-recovery' },
      deploymentBlockNumber: 10,
      finalized: { number: 29, hash: newHash(29) },
      pageSize: 100,
      readBlockHash: async (block) => newHash(block),
      readPage: async (from, to) => {
        rejected.resolve();
        await releaseOld.promise;
        return h.chain.events
          .filter((event) => event.blockNumber >= from && event.blockNumber <= to)
          .map((event) => ({ ...event, blockHash: newHash(event.blockNumber) }));
      },
    });
    await rejected.promise;
    await expect(h.index.view({
      scope: h.scope,
      readScope: { provider: 'newer-recovery' },
      deploymentBlockNumber: 10,
      finalized: { number: 30, hash: newHash(30) },
      pageSize: 100,
      readBlockHash: async (block) => newHash(block),
      readPage: async (from, to) => h.chain.events
        .filter((event) => event.blockNumber >= from && event.blockNumber <= to)
        .map((event) => ({ ...event, blockHash: newHash(event.blockNumber) })),
    })).resolves.toSatisfy((view) => view.has(id(9n)));
    releaseOld.resolve();
    await expect(older).rejects.toMatchObject({ reason: 'cursor-ahead' });

    await expect(h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => ({
        ...baseProjection,
        finalized: { number: 30, hash: newHash(30) },
        head: { ...baseProjection.head, number: 30, hash: newHash(30) },
      }),
    })).resolves.toBe(30);
  });

  it('re-enters provider refresh once when the durable floor wins after provider return', async () => {
    const h = makeHarness();
    const staleProjection = await h.refresh();
    const hash = (block: number): string => `0x${block.toString(16).padStart(64, '0')}`;
    const currentProjection = {
      ...staleProjection,
      finalized: { number: 26, hash: hash(26) },
      head: { ...staleProjection.head, number: 26, hash: hash(26) },
    };
    let refreshes = 0;

    await expect(h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => {
        refreshes += 1;
        if (refreshes === 1) {
          await h.index.refresh({
            scope: h.scope,
            readScope: { provider: 'background-winner' },
            deploymentBlockNumber: 10,
            finalized: { number: 26, hash: hash(26) },
            pageSize: 100,
            readBlockHash: async (block) => hash(block),
            readPage: async () => [],
          });
          return staleProjection;
        }
        return currentProjection;
      },
    })).resolves.toBe(26);
    expect(refreshes).toBe(2);
  });

  it('keeps a fail-closed fence when checkpoint rejection is followed by scan failure', async () => {
    const h = makeHarness();
    const baseProjection = await h.refresh();
    const oldHash = (block: number): string => (
      `0x${block.toString(16).padStart(64, '0')}`
    );
    const newHash = (block: number): string => (
      `0x${(1_000_000 + block).toString(16).padStart(64, '0')}`
    );

    // Commit an explicit old-fork publication floor at the durable H25 row.
    await h.index.refresh({
      scope: h.scope,
      readScope: { provider: 'old-floor' },
      deploymentBlockNumber: 10,
      finalized: { number: 25, hash: oldHash(25) },
      pageSize: 100,
      readBlockHash: async (block) => oldHash(block),
      readPage: async () => [],
    });

    await expect(h.index.refresh({
      scope: h.scope,
      readScope: { provider: 'failed-replacement' },
      deploymentBlockNumber: 10,
      finalized: { number: 26, hash: newHash(26) },
      pageSize: 100,
      readBlockHash: async (block) => newHash(block),
      readPage: async () => { throw new Error('replacement scan failed'); },
    })).rejects.toThrow('replacement scan failed');
    expect(h.store.invalidations).toHaveLength(1);

    await expect(h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => baseProjection,
    })).rejects.toMatchObject({ reason: 'refresh-horizon-ahead' });
    await expect(h.index.peekProjection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
    })).resolves.toEqual({ hit: false });

    // A later successful rebuild at the rejected boundary clears the tombstone.
    await h.index.refresh({
      scope: h.scope,
      readScope: { provider: 'healthy-replacement' },
      deploymentBlockNumber: 10,
      finalized: { number: 26, hash: newHash(26) },
      pageSize: 100,
      readBlockHash: async (block) => newHash(block),
      readPage: async (from, to) => h.chain.events
        .filter((event) => event.blockNumber >= from && event.blockNumber <= to)
        .map((event) => ({ ...event, blockHash: newHash(event.blockNumber) })),
    });
    await expect(h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => ({
        ...baseProjection,
        finalized: { number: 26, hash: newHash(26) },
        head: { ...baseProjection.head, number: 26, hash: newHash(26) },
      }),
    })).resolves.toBe(26);
  });

  it('keeps the horizon fence when a durable refresh waiter cancels', async () => {
    const h = makeHarness();
    const staleProjection = await h.refresh();
    const hash = (block: number): string => `0x${block.toString(16).padStart(64, '0')}`;
    let scanStarted!: () => void;
    const startedScan = new Promise<void>((resolve) => { scanStarted = resolve; });
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    const controller = new AbortController();
    h.chain.head = 26;
    const advancing = h.index.refresh({
      scope: h.scope,
      readScope: h.chain,
      deploymentBlockNumber: 10,
      finalized: { number: 26, hash: hash(26) },
      pageSize: 100,
      signal: controller.signal,
      readBlockHash: async (block) => hash(block),
      readPage: async () => {
        scanStarted();
        await scanGate;
        return [];
      },
    });
    await startedScan;
    const cancelled = new Error('durable refresh waiter stopped');
    controller.abort(cancelled);
    await expect(advancing).rejects.toBe(cancelled);

    await expect(h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => staleProjection,
    })).rejects.toMatchObject({ reason: 'refresh-horizon-ahead' });
    releaseScan();
    await h.index.whenIdle();

    let replacementRefreshes = 0;
    await expect(h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => {
        replacementRefreshes += 1;
        return {
          ...staleProjection,
          finalized: { number: 26, hash: hash(26) },
          head: { ...staleProjection.head, number: 26, hash: hash(26) },
        };
      },
    })).resolves.toBe(26);
    expect(replacementRefreshes).toBe(1);
  });

  it('keeps the refresh horizon when checkpoint rejection outlives a cancelled waiter', async () => {
    const h = makeHarness();
    // Seed durable old-fork H25, but do not seed the projection cache.
    const staleProjection = await h.refresh();
    const forkHash = (block: number): string => (
      `0x${(1_000_000 + block).toString(16).padStart(64, '0')}`
    );
    h.chain.fork = 1;
    h.chain.head = 26;

    let scanStarted!: () => void;
    const startedScan = new Promise<void>((resolve) => { scanStarted = resolve; });
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    const controller = new AbortController();
    const advancing = h.index.refresh({
      scope: h.scope,
      readScope: {},
      deploymentBlockNumber: 10,
      finalized: { number: 26, hash: forkHash(26) },
      pageSize: 100,
      signal: controller.signal,
      readBlockHash: async (block) => forkHash(block),
      readPage: async (from, to) => {
        // Reaching here proves H25 admission already rejected and tombstoned
        // the old checkpoint, invoking the projection invalidation callback.
        scanStarted();
        await scanGate;
        return h.chain.events
          .filter((event) => event.blockNumber >= from && event.blockNumber <= to)
          .map((event) => ({ ...event, blockHash: forkHash(event.blockNumber) }));
      },
    });
    await startedScan;
    expect(h.store.invalidations).toHaveLength(1);

    let staleStarted!: () => void;
    const startedStale = new Promise<void>((resolve) => { staleStarted = resolve; });
    let releaseStale!: () => void;
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    const staleRead = h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => {
        staleStarted();
        await staleGate;
        return staleProjection;
      },
    });
    await startedStale;

    const cancelled = new Error('durable refresh waiter stopped');
    controller.abort(cancelled);
    await expect(advancing).rejects.toBe(cancelled);

    // Caller-side completion is gone, but lifecycle-owned work still commits.
    releaseScan();
    await h.index.whenIdle();
    expect(h.index.exportSnapshot({
      scope: h.scope,
      deploymentBlockNumber: 10,
      minThroughBlockNumber: 26,
      maxThroughBlockNumber: 26,
    })?.checkpoint.cursor.throughBlockNumber).toBe(26);

    releaseStale();
    await expect(staleRead).rejects.toMatchObject({ reason: 'refresh-horizon-ahead' });
    await expect(h.index.peekProjection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
    })).resolves.toEqual({ hit: false });
  });

  it('reasserts a cancelled higher physical refresh after a lower fork rebuild finishes first', async () => {
    const h = makeHarness();
    const baseProjection = await h.refresh();
    const oldHash = (block: number): string => (
      `0x${block.toString(16).padStart(64, '0')}`
    );
    const newHash = (block: number): string => (
      `0x${(1_000_000 + block).toString(16).padStart(64, '0')}`
    );
    const events = (
      from: number,
      to: number,
      hash: (block: number) => string,
    ) => h.chain.events
      .filter((event) => event.blockNumber >= from && event.blockNumber <= to)
      .map((event) => ({ ...event, blockHash: hash(event.blockNumber) }));

    let highTailStarted!: () => void;
    const startedHighTail = new Promise<void>((resolve) => { highTailStarted = resolve; });
    let releaseHighTail!: () => void;
    const highTailGate = new Promise<void>((resolve) => { releaseHighTail = resolve; });
    const controller = new AbortController();
    const high = h.index.refresh({
      scope: h.scope,
      readScope: { provider: 'high' },
      deploymentBlockNumber: 10,
      finalized: { number: 1_000, hash: oldHash(1_000) },
      pageSize: 1_000,
      durableReorgHoldbackBlocks: 500,
      signal: controller.signal,
      readBlockHash: async (block) => oldHash(block),
      readPage: async (from, to) => {
        if (from === 501) {
          highTailStarted();
          await highTailGate;
        }
        return events(from, to, oldHash);
      },
    });
    await startedHighTail;

    const cancelled = new Error('high refresh waiter left');
    controller.abort(cancelled);
    await expect(high).rejects.toBe(cancelled);

    await h.index.refresh({
      scope: h.scope,
      readScope: { provider: 'low-new-fork' },
      deploymentBlockNumber: 10,
      finalized: { number: 900, hash: newHash(900) },
      pageSize: 1_000,
      readBlockHash: async (block) => newHash(block),
      readPage: async (from, to) => events(from, to, newHash),
    });
    expect(h.store.invalidations).toHaveLength(1);
    expect(h.index.exportSnapshot({
      scope: h.scope,
      deploymentBlockNumber: 10,
      minThroughBlockNumber: 900,
      maxThroughBlockNumber: 900,
    })?.checkpoint.cursor.throughBlockNumber).toBe(900);

    releaseHighTail();
    await h.index.whenIdle();

    const projectionAt = (number: number, hash: string) => ({
      ...baseProjection,
      finalized: { number, hash },
      head: { ...baseProjection.head, number, hash },
    });
    await expect(h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => projectionAt(950, newHash(950)),
    })).rejects.toMatchObject({
      name: 'ContextGraphAuthorityIndexRetryableError',
      reason: 'refresh-horizon-ahead',
    });
    await expect(h.index.projection({
      scope: h.scope,
      project: (candidate) => ({ complete: true, value: candidate.finalized.number }),
      refresh: async () => projectionAt(1_000, oldHash(1_000)),
    })).resolves.toBe(1_000);
  });

  it('drops the projection when admission tombstones the durable checkpoint', async () => {
    const h = makeHarness();
    const before = await h.read();
    // A sibling reader (the core's background refresh) discovers that the
    // block under the durable cursor was reorged away.
    h.chain.fork = 1;
    h.chain.head = 26;
    await h.index.refresh({
      scope: h.scope,
      readScope: {},
      deploymentBlockNumber: 10,
      finalized: { number: 26, hash: `0x${(1_000_026).toString(16).padStart(64, '0')}` },
      pageSize: 100,
      readBlockHash: async (block) => `0x${(1_000_000 + block).toString(16).padStart(64, '0')}`,
      readPage: async () => [],
    });
    expect(h.store.invalidations).toHaveLength(1);

    // Still inside T by the clock — and no longer an answer.
    const after = await h.read(9n, undefined, async () => {
      h.reads.refreshes += 1;
      const hash = `0x${(1_000_026).toString(16).padStart(64, '0')}`;
      return {
        ...before,
        finalized: { number: 26, hash },
        head: { ...before.head, number: 26, hash },
      };
    });
    expect(h.reads.refreshes).toBe(2);
    expect(after).not.toBe(before);
  });

  it('revalidates and rebuilds a cached tail after a reorg above the durable cursor', async () => {
    const h = makeHarness({ holdback: 8 });
    h.chain.events.push(transfer(9n, 20));
    const before = await h.read();
    expect(before.view.resolve(id(9n)).owner).toBe(NEXT_OWNER);

    // Durable cursor is 17. Replace only the unpersisted tail at 18..25.
    h.chain.fork = 1;
    h.chain.forkFrom = 18;
    h.chain.events = h.chain.events.filter((event) => event.blockNumber < 18);

    const after = await h.read();
    expect(after).not.toBe(before);
    expect(after.view.resolve(id(9n)).owner).toBe(OWNER);
    expect(h.reads.refreshes).toBe(2);
    expect(h.served.at(-1)?.source).toBe('scan');
    expect(h.store.invalidations).toHaveLength(0);
  });

  it('never serves a pre-reorg tail as stale-cache when rebuilding fails', async () => {
    const h = makeHarness({ holdback: 8 });
    h.chain.events.push(transfer(9n, 20));
    await h.read();

    h.chain.fork = 1;
    h.chain.forkFrom = 18;
    h.chain.events = h.chain.events.filter((event) => event.blockNumber < 18);
    const outage = new Error('provider pool is down');
    h.failRefresh(outage);

    await expect(h.read()).rejects.toBe(outage);
    expect(h.served.map((evidence) => evidence.source)).toEqual(['scan']);
  });

  it('retains a warm tail when anchor validation is unavailable', async () => {
    const h = makeHarness({ holdback: 8 });
    const before = await h.read();
    const outage = new Error('provider pool is down');
    h.chain.anchorUnavailable = true;
    h.failRefresh(outage);

    await expect(h.read()).rejects.toBe(outage);
    expect(h.reads.refreshes).toBe(2);

    h.chain.anchorUnavailable = false;
    h.failRefresh(undefined);
    expect(await h.read()).toBe(before);
    expect(h.reads.refreshes).toBe(2);
    expect(h.served.map((evidence) => evidence.source)).toEqual(['scan', 'cache']);
  });

  it('keys by deployment and contract, never by the bare numeric id', async () => {
    const store = new MemoryAuthorityIndexStore();
    const h = makeHarness({ store });
    await h.read();
    // Same index, same numeric id 9, another ContextGraphStorage address.
    let rotatedRefreshes = 0;
    await expect(h.index.projection({
      scope: 'evm:31337:0xhub:0xrotated',
      project: (cached) => ({ complete: cached.view.has(id(9n)), value: cached }),
      refresh: async () => {
        rotatedRefreshes += 1;
        throw new Error('rotated contract must be scanned, not answered');
      },
    })).rejects.toThrow('rotated contract must be scanned');
    expect(rotatedRefreshes).toBe(1);
  });

  it('rejects a projection scanned for another scope than the one that was read', async () => {
    const h = makeHarness();
    const foreign = async () => ({ ...(await h.refresh()), scope: 'evm:31337:0xhub:0xrotated' });
    await expect(h.read(9n, undefined, foreign)).rejects.toThrow(
      'Context Graph authority contract changed during refresh',
    );
    await h.read();
    expect(h.reads.refreshes).toBe(2);
  });

  it('never reports ABSENT from the cache: an unknown id always forces a fresh scan', async () => {
    const h = makeHarness();
    await h.read();
    h.chain.events.push(creation(12n, 26));
    h.chain.head = 26;

    // Registered one block ago, well inside T.
    const projection = await h.read(12n);
    expect(h.reads.refreshes).toBe(2);
    expect(projection.view.resolve(id(12n)).nameHash).toMatch(/^0x0+c$/u);
    // A truly absent id is an explicit failure, never a default.
    const absent = await h.read(13n);
    expect(h.reads.refreshes).toBe(3);
    expect(() => absent.view.resolve(id(13n)))
      .toThrow('Context Graph 13 has no finalized creation event');
    expect(absent.view.states([id(13n)]).size).toBe(0);
  });

  it('never refuses a failed refresh by answering absent', async () => {
    const h = makeHarness();
    await h.read();
    const outage = new Error('provider pool is down');
    h.failRefresh(outage);
    await expect(h.read(13n)).rejects.toBe(outage);
  });

  it('does not let a lagging endpoint replace a newer head', async () => {
    // Held back, the durable cursor (17) sits below the lagging head, so
    // cursor admission cannot be what rejects it.
    const h = makeHarness({ holdback: 8 });
    const newer = await h.read();
    h.clock.nowMs += T - 1;
    h.chain.head = 24;
    // An absent target forces a scan while the retained head is still fresh.
    const lagging = await h.read(13n);
    expect(lagging.head.number).toBe(24);

    h.chain.head = 25;
    h.failRefresh(new RpcEndpointsExhaustedError('provider pool is down'));
    h.clock.nowMs += 1;
    expect(await h.read()).toBe(newer);
  });

  it('publishes immutable projections', async () => {
    const h = makeHarness();
    const projection = await h.read();
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.view)).toBe(true);
    expect(Object.isFrozen(projection.view.resolve(id(9n)))).toBe(true);
    expect(() => { (projection as { fetchedAtMs: number }).fetchedAtMs = 0; }).toThrow(TypeError);

    h.chain.events.push(transfer(9n, 26));
    h.chain.head = 26;
    h.clock.nowMs += T;
    const next = await h.read();
    expect(next).not.toBe(projection);
    expect(projection.view.resolve(id(9n)).owner).toBe(OWNER);
    expect(projection.head.number).toBe(25);
  });

  it('projects byte-identical states and revisions from a cached and a fresh scan of one head', async () => {
    const cachedHarness = makeHarness();
    cachedHarness.chain.events.push(transfer(9n, 20), creation(12n, 22));
    await cachedHarness.read();
    cachedHarness.clock.nowMs += T - 1;
    const cached = await cachedHarness.read();
    expect(cachedHarness.served.at(-1)?.source).toBe('cache');

    const freshHarness = makeHarness();
    freshHarness.chain.events.push(transfer(9n, 20), creation(12n, 22));
    const fresh = await freshHarness.read();
    const targets = [id(9n), id(12n)];

    expect([...cached.view.revisions(targets)]).toEqual([...fresh.view.revisions(targets)]);
    expect([...cached.view.states(targets)]).toEqual([...fresh.view.states(targets)]);
    expect([...cached.view.statesByNameHashes([NAME_9])])
      .toEqual([...fresh.view.statesByNameHashes([NAME_9])]);
    // And identical to the index's own uncached view of the same head.
    const uncachedView = await freshHarness.index.view({
      scope: SCOPE,
      readScope: {},
      deploymentBlockNumber: 10,
      finalized: fresh.finalized,
      pageSize: 100,
      readBlockHash: async (block) => `0x${block.toString(16).padStart(64, '0')}`,
      readPage: async () => { throw new Error('the durable cursor already covers this head'); },
    });
    expect([...cached.view.revisions(targets)])
      .toEqual([...uncachedView.revisions(targets)]);
  });

  it('never lets the tail-inclusive projection reach exportSnapshot', async () => {
    const h = makeHarness({ holdback: 8 });
    // Above the reorg horizon (25 - 8 = 17): projected, never written down.
    h.chain.events.push(transfer(9n, 20));
    const projection = await h.read();
    expect(projection.view.resolve(id(9n)).owner).toBe(NEXT_OWNER);

    const exported = h.index.exportSnapshot({
      scope: SCOPE,
      deploymentBlockNumber: 10,
      minThroughBlockNumber: 10,
      maxThroughBlockNumber: 25,
    });
    expect(exported?.checkpoint.cursor.throughBlockNumber).toBe(17);
    expect(exported?.checkpoint.states.map((state) => state.owner)).toEqual([OWNER]);
    // Asking for exactly the cached head finds nothing servable there.
    expect(() => h.index.exportSnapshot({
      scope: SCOPE,
      deploymentBlockNumber: 10,
      minThroughBlockNumber: 18,
      maxThroughBlockNumber: 25,
    })).toThrow();
  });

  it('refuses to answer from a closed index, even through a refresh that never scans', async () => {
    const h = makeHarness();
    const completed = await h.refresh();
    await h.index.close();
    await expect(h.read(9n, undefined, async () => completed)).rejects.toThrow('closed');
  });

  it('ages a projection from BEFORE its refresh started, never from when it finished', async () => {
    const h = makeHarness();
    const slow = await h.read(9n, undefined, async () => {
      const completed = await h.refresh();
      h.clock.nowMs += 5_000;
      return completed;
    });
    expect(slow.fetchedAtMs).toBe(START_MS);
    expect(h.served).toEqual([{ source: 'scan', ageMs: 5_000 }]);

    // 5s of its 6s were spent scanning.
    h.clock.nowMs += 999;
    await h.read();
    expect(h.reads.refreshes).toBe(1);
    h.clock.nowMs += 1;
    await h.read();
    expect(h.reads.refreshes).toBe(2);
  });

  it('believes only an OLDER reported fetch instant, and still calls a fold a fold', async () => {
    const h = makeHarness();
    // A fold whose reported instant is NOT older than the refresh start. The
    // node's wall clock stepped BACKWARDS (an NTP correction between the tick's
    // head fetch and this read), or the store's clock runs ahead of it — a
    // devnet after `evm_increaseTime` does exactly this.
    //
    // The AGE must fall back to this cache's own pre-refresh stamp. Believing
    // the reported one, `#refresh` reports `Math.max(0, now - future) = 0` —
    // the under-report `dataFetchedAtMs` exists to forbid — `#serve` then
    // computes a NEGATIVE age and misses forever, refolding on every read, and
    // `#publish`'s lagging-endpoint guard INVERTS, because the difference
    // against a retained projection is large and positive, so a LOWER head
    // from a lagging endpoint displaces a newer one.
    //
    // The PROVENANCE must NOT fall back with it. `source` answers "did this
    // answer touch the pool", and the fold touched nothing but local SQLite;
    // `Rfc64AuthorityReadCoordinatorV1.observeProjectionServed` calls
    // `provePool()` unconditionally on `scan`, so a fold relabelled here would
    // zero the RFC-64 breaker's exhaustion count while every endpoint was
    // down. That is why the discriminator is `origin.kind` and not the stamp
    // derived from it: this is the input where the two disagree.
    const folded = await h.read(9n, undefined, async () => ({
      ...(await h.refresh()),
      origin: { kind: 'log' as const, dataFetchedAtMs: h.clock.nowMs + 10_000 },
    }));
    expect(folded.fetchedAtMs).toBe(START_MS);
    expect(h.served).toEqual([{ source: 'log', ageMs: 0 }]);

    // Retained under the believable stamp, so it still ages — and it is still
    // a fold on the way back out of `#serve`, not a `cache` entry.
    h.clock.nowMs += 1_000;
    await h.read();
    expect(h.reads.refreshes).toBe(1);
    expect(h.served.at(-1)).toEqual({ source: 'log', ageMs: 1_000 });
  });
});

/**
 * The ONE expression that turns a completed refresh into a projection. The log
 * fast path's synthetic candidate goes through this too, so the view a read is
 * ADMITTED by and the view the cache ages and reports cannot disagree; these
 * assertions therefore pin both sites at once.
 */
describe('the projection stamp', () => {
  const scan = { kind: 'scan' } as const;
  const log = (dataFetchedAtMs: number) => ({ kind: 'log', dataFetchedAtMs } as const);

  it('falls back to the floor unless the refresh proved its data is older', () => {
    // A live scan reports nothing older: it is fetching now, so the floor is
    // already the conservative answer.
    expect(resolveProjectionFetchedAtMs(START_MS, scan)).toBe(START_MS);
    // A fold proved OLDER — the only claim ever believed.
    expect(resolveProjectionFetchedAtMs(START_MS, log(START_MS - 1))).toBe(START_MS - 1);
    // At or after the floor would move the age towards zero. Refused, both ways.
    expect(resolveProjectionFetchedAtMs(START_MS, log(START_MS))).toBe(START_MS);
    expect(resolveProjectionFetchedAtMs(START_MS, log(START_MS + 10_000))).toBe(START_MS);
    // An instant that is not a safe integer proves nothing at all, and must not
    // leak into an age subtraction as NaN/Infinity/a fraction. This is the case
    // the reader's own copy of this rule used to get wrong: a bare `Math.min`
    // believes every one of these.
    for (const unusable of [Number.NaN, Infinity, -Infinity, START_MS - 0.5, 2 ** 53]) {
      expect(resolveProjectionFetchedAtMs(START_MS, log(unusable))).toBe(START_MS);
    }
  });
});

describe('peekProjection', () => {
  // `projection` answers at any cost: a miss waits for an in-flight refresh and
  // then performs one, which is a live head read plus a paged scan back to the
  // deployment block. `peekProjection` exists for a caller trying to AVOID a
  // single `eth_call`; escalating its miss would cost orders of magnitude more
  // than the read it was skipping, and would do so when the index is coldest.

  const anyProjection = (candidate: unknown) => ({ complete: true, value: candidate });

  it('reports a miss instead of scanning when nothing is retained', async () => {
    const h = makeHarness();

    const peeked = await h.index.peekProjection({
      scope: h.scope,
      project: anyProjection,
    });

    expect(peeked).toEqual({ hit: false });
    expect(h.reads.refreshes).toBe(0);
    expect(h.physicalReads()).toBe(0);
  });

  it('serves a retained projection without any physical read', async () => {
    const h = makeHarness();
    await h.read();
    const physical = h.physicalReads();

    h.clock.nowMs += T - 1;
    const peeked = await h.index.peekProjection({
      scope: h.scope,
      project: anyProjection,
    });

    expect(peeked.hit).toBe(true);
    expect(h.physicalReads()).toBe(physical);
    expect(h.reads.refreshes).toBe(1);
  });

  it('misses rather than scanning once the retained projection is too old', async () => {
    const h = makeHarness();
    await h.read();
    const refreshes = h.reads.refreshes;
    const physical = h.physicalReads();

    // Past the service window the retained projection may not be served.
    // `projection` would rescan here; this must not.
    h.clock.nowMs += CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS * 2;
    const peeked = await h.index.peekProjection({
      scope: h.scope,
      project: anyProjection,
    });

    expect(peeked).toEqual({ hit: false });
    // The miss cost NOTHING: no refresh, and not one more physical read.
    expect(h.reads.refreshes).toBe(refreshes);
    expect(h.physicalReads()).toBe(physical);
  });

  it("misses when the caller's own projection is incomplete", async () => {
    // Completeness is the caller's predicate, not the cache's: a retained
    // projection that does not carry THIS graph is a miss for this caller even
    // though it is perfectly good for another.
    const h = makeHarness();
    await h.read();

    const peeked = await h.index.peekProjection({
      scope: h.scope,
      project: () => ({ complete: false, value: undefined }),
    });

    expect(peeked).toEqual({ hit: false });
    expect(h.reads.refreshes).toBe(1);
  });

  it('does not let an old anchor validator serve or drop a replacement projection', async () => {
    const h = makeHarness({ holdback: 1 });
    await h.read();

    let validatorStarted!: () => void;
    const started = new Promise<void>((resolve) => { validatorStarted = resolve; });
    let releaseValidator!: () => void;
    const validatorGate = new Promise<void>((resolve) => { releaseValidator = resolve; });
    const pending = h.index.peekProjection({
      scope: h.scope,
      project: () => ({ complete: true, value: 'old' }),
      validateAnchor: async () => {
        validatorStarted();
        await validatorGate;
        return false;
      },
    });
    await started;

    h.index.dropProjections();
    h.chain.head = 26;
    const replacement = await h.read();
    releaseValidator();

    await expect(pending).resolves.toEqual({ hit: false });
    await expect(h.read()).resolves.toBe(replacement);
    expect(h.reads.refreshes).toBe(2);
  });

  it('does not serve an incomplete projection replaced during its finality proof', async () => {
    const h = makeHarness();
    await h.read();

    let validationStarted!: () => void;
    const started = new Promise<void>((resolve) => { validationStarted = resolve; });
    let releaseValidation!: () => void;
    const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
    const pending = h.index.peekProjection({
      scope: h.scope,
      project: () => ({ complete: false, value: 'old absence' }),
      validateIncomplete: async () => {
        validationStarted();
        await validationGate;
        return { admitted: true, anchorValidated: true };
      },
    });
    await started;

    h.index.dropProjections();
    h.chain.head = 26;
    const replacement = await h.read();
    releaseValidation();

    await expect(pending).resolves.toEqual({ hit: false });
    await expect(h.read()).resolves.toBe(replacement);
    expect(h.reads.refreshes).toBe(2);
  });

  it('preserves legacy boolean incomplete admission and still validates its tail anchor', async () => {
    const h = makeHarness({ holdback: 1 });
    await h.read();
    const validateAnchor = vi.fn(async () => true);

    await expect(h.index.peekProjection({
      scope: h.scope,
      project: () => ({ complete: false, value: 'cached absence' }),
      validateIncomplete: async () => true,
      validateAnchor,
    })).resolves.toEqual({ hit: true, value: 'cached absence' });
    expect(validateAnchor).toHaveBeenCalledOnce();
  });

  it('honours an already-aborted signal', async () => {
    const h = makeHarness();
    const controller = new AbortController();
    controller.abort();

    await expect(h.index.peekProjection({
      scope: h.scope,
      signal: controller.signal,
      project: anyProjection,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
