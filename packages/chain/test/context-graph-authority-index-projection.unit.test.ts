// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { ContextGraphAuthorityIndex } from '../src/context-graph-authority-index.js';
import { ContextGraphAuthorityIndexRetryableError } from
  '../src/context-graph-authority-index-errors.js';
import type { ContextGraphAuthorityIndexId } from '../src/chain-adapter.js';
import {
  CONTEXT_GRAPH_AUTHORITY_INDEX_HEAD_TIMESTAMP_TOLERANCE_MS,
  ContextGraphAuthorityIndexProjectionCache,
  contextGraphAuthorityIndexScope,
  resolveContextGraphAuthorityIndexTickMs,
  type ContextGraphAuthorityIndexCompletedProjection,
  type ContextGraphAuthorityProjectionServedEvidence,
} from '../src/context-graph-authority-index-projection.js';
import type {
  RawContextGraphAuthorityIndexEvent as ContextGraphAuthorityIndexEvent,
} from '../src/context-graph-authority-index-reducer.js';
import { MemoryAuthorityIndexStore } from './helpers/context-graph-authority-index.js';

const OWNER = `0x${'11'.repeat(20)}`;
const NEXT_OWNER = `0x${'22'.repeat(20)}`;
const AUTHORITY = `0x${'33'.repeat(20)}`;
const NAME_9 = `0x${'99'.repeat(32)}`;
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
    /** Seconds the head block's own timestamp trails the wall clock. */
    headLagSeconds: 2,
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
    `0x${(chain.fork * 1_000_000 + block).toString(16).padStart(64, '0')}`
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
      view,
    });
  };

  const read = (
    contextGraphId: bigint = 9n,
    signal?: AbortSignal,
    ownRefresh: () => Promise<ContextGraphAuthorityIndexCompletedProjection> = refresh,
  ) => index.projection({
    scope,
    signal,
    accepts: (cached) => cached.view.has(id(contextGraphId)),
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
});

describe('finalized Context Graph authority projection cache', () => {
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

  it('pays one failed refresh per tick during an outage, not one per read', async () => {
    const h = makeHarness();
    const cached = await h.read();
    h.failRefresh(new Error('provider pool is down'));

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
      return { ...before, head: { ...before.head, number: 26 } };
    });
    expect(h.reads.refreshes).toBe(2);
    expect(after).not.toBe(before);
  });

  it('keys by deployment and contract, never by the bare numeric id', async () => {
    const store = new MemoryAuthorityIndexStore();
    const h = makeHarness({ store });
    await h.read();
    // Same index, same numeric id 9, another ContextGraphStorage address.
    let rotatedRefreshes = 0;
    await expect(h.index.projection({
      scope: 'evm:31337:0xhub:0xrotated',
      accepts: (cached) => cached.view.has(id(9n)),
      refresh: async () => {
        rotatedRefreshes += 1;
        throw new Error('rotated contract must be scanned, not answered');
      },
    })).rejects.toThrow('rotated contract must be scanned');
    expect(rotatedRefreshes).toBe(1);
  });

  it('does not retain a projection scanned for another scope than the one that was read', async () => {
    const h = makeHarness();
    const foreign = async () => ({ ...(await h.refresh()), scope: 'evm:31337:0xhub:0xrotated' });
    await h.read(9n, undefined, foreign);
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
    h.failRefresh(new Error('provider pool is down'));
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
});
