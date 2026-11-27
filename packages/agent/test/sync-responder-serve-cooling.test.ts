import { describe, expect, it, vi } from 'vitest';
import {
  OxigraphStore,
  StoreOperationTimeoutError,
  StoreSchedulerBusyError,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { formatSyncNotServable, readSyncNotServable } from '../src/sync/not-servable.js';
import {
  createSyncResponderCooling,
  syncNotServableReasonOf,
  SYNC_RESPONDER_COOLING_BASE_MS,
  SYNC_RESPONDER_COOLING_MAX_MS,
  type SyncResponderRequestShape,
} from '../src/sync/responder/serve-cooling.js';
import { SyncRowSnapshotBudgetError } from '../src/sync/responder/snapshot-budget.js';
import {
  DKG_NS,
  linesFromNquads,
  registerTestSyncHandler,
  TEST_SYNC_DENIED,
} from './_helpers/sync-responder.js';

/**
 * A request whose store query ran into the store deadline would run into it
 * again. The responder remembers the request's shape and refuses it, without
 * running anything, for a period that grows with each consecutive failure.
 */

function storeDeadline(): StoreOperationTimeoutError {
  return new StoreOperationTimeoutError({
    backend: 'oxigraph-server',
    operation: 'query',
    storeOperation: 'query',
    timeoutMs: 30_000,
  });
}

const META: SyncResponderRequestShape = {
  contextGraphId: 'cooling-graph',
  plane: 'durable',
  phase: 'meta',
  selection: 'full',
  stage: 'start',
};

class TestBusyError extends Error {}

function cooling(start = 1_000_000) {
  let now = start;
  const warnings: string[] = [];
  const ledger = createSyncResponderCooling({
    busyError: (message) => new TestBusyError(message),
    logWarn: (message) => warnings.push(message),
    now: () => now,
  });
  return {
    ledger,
    warnings,
    advance: (ms: number) => { now += ms; },
  };
}

describe('what a failed request says about its shape', () => {
  it('reads a store query that ran into its deadline as evidence, at any depth of the cause chain', () => {
    expect(syncNotServableReasonOf(storeDeadline())).toBe('store-deadline');
    expect(syncNotServableReasonOf(new Error('page failed', { cause: storeDeadline() }))).toBe('store-deadline');
    // A managed server's own evaluator deadline carries no client timeout.
    expect(syncNotServableReasonOf(new StoreOperationTimeoutError({
      backend: 'oxigraph-server',
      operation: 'query',
      message: 'Managed Oxigraph query exceeded its server-side query deadline',
    }))).toBe('store-deadline');
  });

  it('does not read a store that never started the query, or was interrupted, as evidence', () => {
    expect(syncNotServableReasonOf(new StoreOperationTimeoutError({
      backend: 'oxigraph-server',
      operation: 'query',
      outcome: 'not_started',
      message: 'Managed Oxigraph is recovering; query was not started',
    }))).toBeUndefined();
    expect(syncNotServableReasonOf(new StoreOperationTimeoutError({
      backend: 'oxigraph-server',
      operation: 'query',
      outcome: 'indeterminate',
      message: 'Managed Oxigraph recovery interrupted query; outcome is indeterminate',
    }))).toBeUndefined();
    expect(syncNotServableReasonOf(new StoreOperationTimeoutError({
      backend: 'blazegraph',
      operation: 'query',
      timeoutMs: 30_000,
      outcome: 'not_started',
    }))).toBeUndefined();
    expect(syncNotServableReasonOf(new StoreSchedulerBusyError(
      'queue_wait_timeout',
      'background',
      'sync.responder.readDurableMetaGraphSnapshot',
      { storeOperation: 'query' },
    ))).toBeUndefined();
  });

  it('reads a request beyond the paging bounds as too large, and transient pressure as nothing', () => {
    const budget = (reason: SyncRowSnapshotBudgetError['reason']) => new SyncRowSnapshotBudgetError({
      key: 'k', reason, rows: 10, bytesEstimate: 10, limit: 1,
    });
    expect(syncNotServableReasonOf(budget('snapshot_rows'))).toBe('too-large');
    expect(syncNotServableReasonOf(budget('snapshot_bytes'))).toBe('too-large');
    expect(syncNotServableReasonOf(budget('global_rows'))).toBeUndefined();
    expect(syncNotServableReasonOf(budget('global_bytes'))).toBeUndefined();
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    expect(syncNotServableReasonOf(aborted)).toBeUndefined();
    expect(syncNotServableReasonOf(new Error('boom'))).toBeUndefined();
    expect(syncNotServableReasonOf('boom')).toBeUndefined();
    const hostile = { get cause(): never { throw new Error('unreadable'); } };
    expect(syncNotServableReasonOf(hostile)).toBeUndefined();
  });
});

describe('sync responder cooling', () => {
  it('lets the failing request keep its error, then refuses the shape without running it', async () => {
    const { ledger, warnings, advance } = cooling();
    const failure = storeDeadline();
    const work = vi.fn(async () => { throw failure; });

    await expect(ledger.run(META, work)).rejects.toBe(failure);
    expect(work).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"cooling-graph"');
    expect(warnings[0]).toContain('store-deadline, 1 in a row');
    expect(ledger.coolingCount()).toBe(1);

    advance(60_000);
    const refusal = await ledger.run(META, work).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(TestBusyError);
    expect(readSyncNotServable(refusal)).toEqual({
      reason: 'store-deadline',
      retryAfterMs: SYNC_RESPONDER_COOLING_BASE_MS - 60_000,
    });
    // Nothing ran and nothing new was logged: the refusal costs nothing.
    expect(work).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
  });

  it('runs one probe when a period ends and doubles the period up to the cap while it keeps failing', async () => {
    const { ledger, warnings, advance } = cooling();
    const work = vi.fn(async () => { throw storeDeadline(); });
    const periods: number[] = [];
    for (let failure = 1; failure <= 5; failure += 1) {
      await expect(ledger.run(META, work)).rejects.toBeInstanceOf(StoreOperationTimeoutError);
      expect(work).toHaveBeenCalledTimes(failure);
      const refusal = await ledger.run(META, work).catch((error: unknown) => error);
      periods.push(readSyncNotServable(refusal)!.retryAfterMs!);
      advance(periods[periods.length - 1]!);
    }
    expect(periods).toEqual([
      SYNC_RESPONDER_COOLING_BASE_MS,
      2 * SYNC_RESPONDER_COOLING_BASE_MS,
      4 * SYNC_RESPONDER_COOLING_BASE_MS,
      SYNC_RESPONDER_COOLING_MAX_MS,
      SYNC_RESPONDER_COOLING_MAX_MS,
    ]);
    expect(warnings[4]).toContain('5 in a row');
  });

  it('forgets a shape once a request of it is served', async () => {
    const { ledger, advance } = cooling();
    await expect(ledger.run(META, async () => { throw storeDeadline(); })).rejects.toThrow();
    advance(SYNC_RESPONDER_COOLING_BASE_MS);
    await expect(ledger.run(META, async () => 'served')).resolves.toBe('served');
    expect(ledger.coolingCount()).toBe(0);
    // The next failure starts from the base period again.
    await expect(ledger.run(META, async () => { throw storeDeadline(); })).rejects.toThrow();
    const refusal = await ledger.run(META, async () => 'unreached').catch((error: unknown) => error);
    expect(readSyncNotServable(refusal)!.retryAfterMs).toBe(SYNC_RESPONDER_COOLING_BASE_MS);
  });

  it('keeps cooling when a request that was already running is served after the failure', async () => {
    const { ledger } = cooling();
    let serve!: () => void;
    // A request of the same shape that is cheap for its own reasons, in flight
    // while another one runs into the deadline.
    const running = ledger.run(META, () => new Promise<string>((resolve) => { serve = () => resolve('rows'); }));
    await expect(ledger.run(META, async () => { throw storeDeadline(); })).rejects.toThrow();
    serve();
    await expect(running).resolves.toBe('rows');
    expect(ledger.coolingCount()).toBe(1);
    const work = vi.fn(async () => 'unreached');
    await expect(ledger.run(META, work)).rejects.toBeInstanceOf(TestBusyError);
    expect(work).not.toHaveBeenCalled();
  });

  it('takes a failure of work the request started but did not wait for as evidence', async () => {
    const { ledger, warnings } = cooling();
    let report!: (error: unknown) => void;
    // The request leaves; what it started goes on and then fails.
    await expect(ledger.run(META, async (reportFailure) => {
      report = reportFailure;
      throw new Error('requester stopped waiting');
    })).rejects.toThrow('requester stopped waiting');
    expect(ledger.coolingCount()).toBe(0);
    report(storeDeadline());
    expect(ledger.coolingCount()).toBe(1);
    expect(warnings).toHaveLength(1);
    await expect(ledger.run(META, async () => 'unreached')).rejects.toBeInstanceOf(TestBusyError);
  });

  it('counts one failure once when it reaches the request and its reporter', async () => {
    const { ledger, warnings } = cooling();
    const failure = storeDeadline();
    await expect(ledger.run(META, async (reportFailure) => {
      reportFailure(failure);
      throw failure;
    })).rejects.toBe(failure);
    expect(warnings).toHaveLength(1);
    const refusal = await ledger.run(META, async () => 'unreached').catch((error: unknown) => error);
    expect(readSyncNotServable(refusal)!.retryAfterMs).toBe(SYNC_RESPONDER_COOLING_BASE_MS);
  });

  it('counts requests that overlapped one failure once', async () => {
    const { ledger, warnings } = cooling();
    let failBoth!: () => void;
    const gate = new Promise<void>((resolve) => { failBoth = resolve; });
    const work = async () => { await gate; throw storeDeadline(); };
    const first = ledger.run(META, work).catch((error: unknown) => error);
    const second = ledger.run(META, work).catch((error: unknown) => error);
    failBoth();
    expect(await first).toBeInstanceOf(StoreOperationTimeoutError);
    expect(await second).toBeInstanceOf(StoreOperationTimeoutError);
    expect(warnings).toHaveLength(1);
    const refusal = await ledger.run(META, work).catch((error: unknown) => error);
    expect(readSyncNotServable(refusal)!.retryAfterMs).toBe(SYNC_RESPONDER_COOLING_BASE_MS);
  });

  it('keeps shapes apart: another phase, graph, plane or asset selection is still run', async () => {
    const { ledger } = cooling();
    await expect(ledger.run(META, async () => { throw storeDeadline(); })).rejects.toThrow();
    const others: SyncResponderRequestShape[] = [
      { ...META, phase: 'data' },
      { ...META, contextGraphId: 'another-graph' },
      { ...META, plane: 'shared-memory' },
      { ...META, selection: 'delta' },
      { ...META, selection: 'exact:abc' },
      { ...META, stage: 'continuation' },
    ];
    for (const shape of others) await expect(ledger.run(shape, async () => 'served')).resolves.toBe('served');
    await expect(ledger.run({ ...META, selection: 'exact:abc' }, async () => { throw storeDeadline(); }))
      .rejects.toThrow();
    await expect(ledger.run({ ...META, selection: 'exact:def' }, async () => 'served')).resolves.toBe('served');
    await expect(ledger.run({ ...META, selection: 'exact:abc' }, async () => 'unreached'))
      .rejects.toBeInstanceOf(TestBusyError);
  });

  it('keeps the sessions being served apart from a start that cannot be served, and the reverse', async () => {
    const { ledger } = cooling();
    const next: SyncResponderRequestShape = { ...META, stage: 'continuation' };
    await expect(ledger.run(META, async () => { throw storeDeadline(); })).rejects.toThrow();
    // Later pages of sessions that already hold their state are still read.
    await expect(ledger.run(next, async () => 'page')).resolves.toBe('page');
    // Serving them says nothing about a start: it stays refused.
    await expect(ledger.run(META, async () => 'unreached')).rejects.toBeInstanceOf(TestBusyError);
    // A later page that runs into the deadline cools later pages only.
    await expect(ledger.run(next, async () => { throw storeDeadline(); })).rejects.toThrow();
    await expect(ledger.run(next, async () => 'unreached')).rejects.toBeInstanceOf(TestBusyError);
    expect(ledger.coolingCount()).toBe(2);
  });

  it('remembers a request beyond the paging bounds the same way', async () => {
    const { ledger, warnings } = cooling();
    const tooLarge = new SyncRowSnapshotBudgetError({
      key: 'k', reason: 'snapshot_rows', rows: 3_000_000, bytesEstimate: 0, limit: 2_000_000,
    });
    const work = vi.fn(async () => { throw tooLarge; });
    await expect(ledger.run(META, work)).rejects.toBe(tooLarge);
    const refusal = await ledger.run(META, work).catch((error: unknown) => error);
    expect(readSyncNotServable(refusal)).toMatchObject({ reason: 'too-large' });
    expect(work).toHaveBeenCalledTimes(1);
    expect(warnings[0]).toContain('too-large');
  });

  it('does not cool for failures that say nothing about the request', async () => {
    const { ledger, warnings } = cooling();
    const work = vi.fn(async () => { throw new Error('transient'); });
    await expect(ledger.run(META, work)).rejects.toThrow('transient');
    await expect(ledger.run(META, work)).rejects.toThrow('transient');
    expect(work).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([]);
    expect(ledger.coolingCount()).toBe(0);
  });

  it('forgets a shape nobody asked for again within a whole cap', async () => {
    const { ledger, advance } = cooling();
    await expect(ledger.run(META, async () => { throw storeDeadline(); })).rejects.toThrow();
    advance(SYNC_RESPONDER_COOLING_BASE_MS + SYNC_RESPONDER_COOLING_MAX_MS);
    // Another shape's failure prunes the stale record.
    await expect(ledger.run({ ...META, phase: 'data' }, async () => { throw storeDeadline(); })).rejects.toThrow();
    await expect(ledger.run(META, async () => { throw storeDeadline(); })).rejects.toThrow();
    const refusal = await ledger.run(META, async () => 'unreached').catch((error: unknown) => error);
    expect(readSyncNotServable(refusal)!.retryAfterMs).toBe(SYNC_RESPONDER_COOLING_BASE_MS);
  });
});

describe('sync responder cooling memory', () => {
  it('stays bounded: the oldest record is dropped once more shapes have failed than it keeps', async () => {
    const { ledger } = cooling();
    const fail = (index: number) => ledger.run(
      { ...META, contextGraphId: `graph-${index}` },
      async () => { throw storeDeadline(); },
    ).catch(() => undefined);
    for (let index = 0; index <= 256; index += 1) await fail(index);
    expect(ledger.coolingCount()).toBe(256);
    // The first shape was forgotten, so it is run again; the latest is refused.
    await expect(ledger.run({ ...META, contextGraphId: 'graph-0' }, async () => 'served')).resolves.toBe('served');
    await expect(ledger.run({ ...META, contextGraphId: 'graph-256' }, async () => 'unreached'))
      .rejects.toBeInstanceOf(TestBusyError);
  });
});

describe('the not-servable reply', () => {
  it('round-trips its reason and the time left', () => {
    expect(readSyncNotServable(new Error(formatSyncNotServable('store-deadline', 1_234.2))))
      .toEqual({ reason: 'store-deadline', retryAfterMs: 1_235 });
    expect(readSyncNotServable(new Error(formatSyncNotServable('too-large', -5))))
      .toEqual({ reason: 'too-large', retryAfterMs: 0 });
    // The transport may wrap the text.
    expect(readSyncNotServable(`pooled: ${formatSyncNotServable('too-large', 60_000)}`))
      .toEqual({ reason: 'too-large', retryAfterMs: 60_000 });
  });

  it('is worded as a busy responder, which every requester already backs off from', () => {
    const text = formatSyncNotServable('store-deadline', 1).toLowerCase();
    expect(text).toContain('sync responder');
    expect(text).toContain('busy');
  });

  it('reads the plain text of a responder without the reply', () => {
    expect(readSyncNotServable(new Error('oxigraph-server query exceeded its store deadline after 30000ms')))
      .toEqual({ reason: 'store-deadline' });
    expect(readSyncNotServable(new Error('Managed Oxigraph query exceeded its server-side query deadline')))
      .toEqual({ reason: 'store-deadline' });
    // The typed budget refusal as the handler sends it.
    const tooLarge = new SyncRowSnapshotBudgetError({
      key: 'k', reason: 'snapshot_rows', rows: 3_000_000, bytesEstimate: 0, limit: 2_000_000,
    });
    expect(readSyncNotServable(new Error(tooLarge.message))).toEqual({ reason: 'too-large' });
    const tooManyBytes = new SyncRowSnapshotBudgetError({
      key: 'k', reason: 'snapshot_bytes', rows: 0, bytesEstimate: 9, limit: 1,
    });
    expect(readSyncNotServable(new Error(tooManyBytes.message))).toEqual({ reason: 'too-large' });
  });

  it('reads nothing into other failures', () => {
    expect(readSyncNotServable(new Error('sync responder busy: "graph" is not served yet'))).toBeNull();
    expect(readSyncNotServable(new Error('sync responder queue wait exceeded'))).toBeNull();
    // Pressure on the responder's shared budget passes; it is retried.
    expect(readSyncNotServable(new Error(new SyncRowSnapshotBudgetError({
      key: 'k', reason: 'global_rows', rows: 9, bytesEstimate: 0, limit: 1,
    }).message))).toBeNull();
    expect(readSyncNotServable(new Error('sync responder snapshot limit exceeded (active=64/64)'))).toBeNull();
    expect(readSyncNotServable(new Error('request timeout'))).toBeNull();
    expect(readSyncNotServable(undefined)).toBeNull();
    expect(readSyncNotServable({ message: 'exceeded its store deadline' })).toBeNull();
  });
});

describe('sync handler with cooling', () => {
  async function fixture() {
    const cgId = 'cooling-handler';
    const metaGraph = `did:dkg:context-graph:${cgId}/_meta`;
    const store = new OxigraphStore();
    await store.insert([
      { graph: metaGraph, subject: 'did:dkg:activity:one', predicate: `${DKG_NS}label`, object: '"one"' },
      { graph: `did:dkg:context-graph:other/_meta`, subject: 'did:dkg:activity:two', predicate: `${DKG_NS}label`, object: '"two"' },
    ]);
    // The store runs every query except reads of this one metadata graph while
    // `failing` is set: those end in the store's typed deadline error.
    const state = { failing: true, metaReads: 0 };
    const original = store.query.bind(store);
    (store as { query: TripleStore['query'] }).query = async (sparql, options) => {
      if (sparql.includes(`<${metaGraph}>`) && options?.source !== 'sync.responder.readRegisteredSubGraphNames') {
        state.metaReads += 1;
        if (state.failing) throw storeDeadline();
      }
      return original(sparql, options);
    };
    const authorized = { value: true };
    const cap = registerTestSyncHandler(store, { authorize: async () => authorized.value });
    const meta = (
      contextGraphId: string,
      syncSessionId: string,
      remotePeerId?: string,
      offset = 0,
      limit = 100,
    ) => cap.invoke({
      contextGraphId,
      includeSharedMemory: false,
      phase: 'meta',
      offset,
      limit,
      syncSessionId,
    }, remotePeerId);
    return { cgId, metaGraph, store, state, authorized, meta };
  }

  it('runs a request that hit the store deadline once, then answers without touching the store', async () => {
    const { cgId, store, state, meta } = await fixture();

    await expect(meta(cgId, 'first')).rejects.toMatchObject({ code: 'STORE_OPERATION_TIMEOUT' });
    expect(state.metaReads).toBe(1);

    // The same request from the same peer, and from two other ones: what a
    // request costs does not depend on who sends it.
    for (const [attempt, peer] of [
      ['second', undefined],
      ['third', '12D3KooWCoolingTestSecondRequesterPeer'],
      ['fourth', '12D3KooWCoolingTestThirdRequesterPeer'],
    ] as const) {
      const refusal = await meta(cgId, attempt, peer).catch((error: unknown) => error);
      expect(refusal).toMatchObject({ name: 'QuietRetryableHandlerError' });
      const reply = readSyncNotServable(refusal);
      expect(reply?.reason).toBe('store-deadline');
      expect(reply?.retryAfterMs).toBeGreaterThan(SYNC_RESPONDER_COOLING_BASE_MS - 10_000);
      expect(reply?.retryAfterMs).toBeLessThanOrEqual(SYNC_RESPONDER_COOLING_BASE_MS);
    }
    expect(state.metaReads).toBe(1);

    // Another graph is served as before.
    expect(linesFromNquads(await meta('other', 'other-session'))).toHaveLength(1);
    await store.close();
  });

  it('keeps serving the later pages of a session while new sessions of the graph are refused', async () => {
    const { cgId, metaGraph, store, state, meta } = await fixture();
    await store.insert(['two', 'three', 'four'].map((name) => ({
      graph: metaGraph, subject: `did:dkg:activity:${name}`, predicate: `${DKG_NS}label`, object: `"${name}"`,
    })));
    const walking = '12D3KooWCoolingTestWalkingRequesterPeer';
    const starting = '12D3KooWCoolingTestStartingRequesterPeer';

    // One peer starts a walk while the store answers.
    state.failing = false;
    expect(linesFromNquads(await meta(cgId, 'walk', walking, 0, 2))).toHaveLength(2);
    // Another peer's start then runs into the store deadline.
    state.failing = true;
    await expect(meta(cgId, 'start', starting)).rejects.toMatchObject({ code: 'STORE_OPERATION_TIMEOUT' });
    const readsAfterFailure = state.metaReads;

    // The walk goes on from the state its session already holds.
    expect(linesFromNquads(await meta(cgId, 'walk', walking, 2, 2))).toHaveLength(2);
    // A new start is refused without a read, for either peer.
    await expect(meta(cgId, 'start-again', starting)).rejects.toMatchObject({ name: 'QuietRetryableHandlerError' });
    await expect(meta(cgId, 'walk-again', walking)).rejects.toMatchObject({ name: 'QuietRetryableHandlerError' });
    expect(state.metaReads).toBe(readsAfterFailure);
    await store.close();
  });

  it('does not tell a peer it would deny that a graph is cooling', async () => {
    const { cgId, store, state, authorized, meta } = await fixture();
    await expect(meta(cgId, 'first')).rejects.toMatchObject({ code: 'STORE_OPERATION_TIMEOUT' });
    authorized.value = false;
    expect(await meta(cgId, 'denied')).toBe(TEST_SYNC_DENIED);
    expect(state.metaReads).toBe(1);
    await store.close();
  });
});
