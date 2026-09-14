import { afterEach, expect, it, vi } from 'vitest';
import { createOperationContext, OversizedRdfLiteralError } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import { readPublicSnapshotWalkProgress, runSharedMemorySync, syncPublicSnapshotsForMeta, type PublicSnapshotMetadata } from '../src/sync/requester/shared-memory-sync.js';
import { createRecoveryExecutionAdmission } from '../src/sync/requester/recovery-execution-guard.js';
import { PUBLIC_SNAPSHOT_FETCH_CONCURRENCY, settlePublicSnapshots } from '../src/sync/requester/public-snapshot-recovery.js';
import { didSyncPeerRespond, isSyncBackoffWorthyError, isSyncDeniedError, isSyncTransportFailure, toSyncDeniedError, toSyncTransportFailureError } from '../src/sync/error-tags.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { composeSyncWorkAdmission } from '../src/sync/work-admission.js';

afterEach(() => vi.restoreAllMocks());
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(count = 8) {
  const payloads = Array.from({ length: count }, (_, i): Quad[] => [
    { subject: `urn:pool:${i}`, predicate: 'urn:p', object: '"value"', graph: '' },
  ]);
  const refs = payloads.map(workspacePublicQuadsDigest);
  const metaQuads = refs.flatMap((ref, i) => [
    ['publicSnapshotRef', ref], ['publicQuadsDigest', ref], ['publicQuadsCount', '1'],
  ].map(([name, value]): Quad => ({ subject: `urn:op:${i}`, predicate: `http://dkg.io/ontology/${name}`, object: `"${value}"`, graph: '' })));
  const responses = refs.map(() => deferred<SyncPageResult>());
  const started: number[] = [];
  const cacheReads: number[] = [];
  const cache = new Map<string, Quad[]>();
  const store: WorkspacePublicSnapshotStore = {
    getSnapshot: async ref => { cacheReads.push(refs.indexOf(ref)); return cache.get(ref) ?? null; },
    putSnapshot: async ({ digest, quads }) => { cache.set(digest, [...quads]); return { ref: digest, byteLength: 100 }; },
  };
  const deleted = vi.fn();
  const ready = vi.fn(async (_snapshot: PublicSnapshotMetadata, _source: 'cache' | 'network') => {});
  const page = (index: number, overrides: Partial<SyncPageResult> = {}): SyncPageResult => ({
    quads: payloads[index]!, bytesReceived: 100, resumedFromOffset: 0, responderSessionStartedFresh: true,
    nextOffset: 1, checkpointKey: refs[index]!, completed: true, timedOut: false, ...overrides,
  });
  const fetchSyncPages: Parameters<typeof syncPublicSnapshotsForMeta>[0]['fetchSyncPages'] = async (_ctx, _peer, cg, _shared, phase, _graph, _deadline, options) => {
    if (phase !== 'snapshot') return { ...page(0), quads: [], bytesReceived: 0, checkpointKey: `${cg}:${phase}` };
    const index = refs.indexOf(options!.snapshotRef!); started.push(index); return responses[index]!.promise;
  };
  const legacyParams = (overrides: Partial<Pick<Parameters<typeof syncPublicSnapshotsForMeta>[0], 'deadline' | 'executionBoundary' | 'fetchConcurrency'>> = {}) => ({
    ctx: createOperationContext('sync'), remotePeerId: 'peer', contextGraphId: 'pool', metaQuads,
    deadline: Date.now() + 60_000, publicSnapshotStore: store,
    fetchSyncPages,
    deleteCheckpoint: deleted, setCheckpoint: () => {}, onSnapshotReady: ready, ...overrides,
  });
  /**
   * A caller that ASKS for the pool. The limit is stated here, not defaulted by
   * the walk: every pool scenario below is a scenario about a caller that opted
   * in, and `startLegacy` covers the caller that did not.
   */
  const start = (overrides: Partial<Pick<Parameters<typeof syncPublicSnapshotsForMeta>[0], 'deadline' | 'executionBoundary' | 'fetchConcurrency'>> = {}) =>
    syncPublicSnapshotsForMeta({ fetchConcurrency: PUBLIC_SNAPSHOT_FETCH_CONCURRENCY, ...legacyParams(overrides) });
  /** An unchanged consumer: the same call with no pool limit requested. */
  const startLegacy = () => syncPublicSnapshotsForMeta(legacyParams());
  const startSettled = (overrides: { executionBoundary?: ReturnType<typeof createRecoveryExecutionAdmission> } = {}) => settlePublicSnapshots({
    concurrency: PUBLIC_SNAPSHOT_FETCH_CONCURRENCY,
    entries: refs.map(ref => ({ snapshot: { ref, digest: ref, count: 1 }, reuse: false })),
    contextGraphId: 'pool',
    workAdmission: composeSyncWorkAdmission({
      deadline: Date.now() + 60_000,
      scope: { sharing: 'coalescible', key: 'pool' },
    }),
    store,
    executionBoundary: createRecoveryExecutionAdmission(),
    fetchSnapshot: async snapshot => {
      const index = refs.indexOf(snapshot.ref);
      started.push(index);
      return responses[index]!.promise;
    },
    deleteCheckpoint: deleted,
    onSnapshotReady: ready,
    ...overrides,
  });
  const startSync = (
    deadline = Date.now() + 60_000,
    logWarn: Parameters<typeof runSharedMemorySync>[0]['logWarn'] = () => {},
  ) => runSharedMemorySync({
    mode: { kind: 'ordinary' }, ctx: createOperationContext('sync'), remotePeerId: 'peer', contextGraphIds: ['pool'],
    createContextGraphSyncDeadline: () => deadline, fetchSyncPages,
    processSharedMemoryBatch: async () => ({
      verifiedData: [], verifiedMeta: metaQuads, totalFetchedDataQuads: 0,
      totalFetchedMetaQuads: metaQuads.length, droppedDataTriples: 0, emptyResponses: 0, entityCreators: [],
    }),
    publicSnapshotStore: store, ensureContextGraph: async () => {}, storeInsert: async () => {},
    deleteCheckpoint: deleted, setCheckpoint: () => {}, ensureOwnedMap: () => new Map(),
    logInfo: () => {}, logWarn, logDebug: () => {},
  });
  const releaseAll = () => responses.forEach((response, i) => response.resolve(page(i)));
  const waitForStarted = (count: number) => vi.waitFor(() => expect(started).toHaveLength(count));
  return { refs, payloads, responses, started, cacheReads, cache, store, deleted, ready, page, fetchSyncPages, start, startLegacy, startSettled, startSync, releaseAll, waitForStarted };
}

it.each(['ordinary error', 'frozen error', 'primitive'] as const)('retains a timed-out sibling and round metrics after a local %s', async kind => {
  const f = fixture(4);
  const failure = kind === 'primitive' ? 'local write failed'
    : kind === 'frozen error' ? Object.freeze(new Error('local write failed')) : new Error('local write failed');
  const put = f.store.putSnapshot;
  f.store.putSnapshot = async input => {
    if (input.digest === f.refs[3]) throw failure;
    return put(input);
  };
  const run = f.startSync();
  try {
    await f.waitForStarted(4);
    f.responses[0]!.resolve(f.page(0, { completed: false, timedOut: true, resumedFromOffset: 3 }));
    f.responses[1]!.resolve(f.page(1)); f.responses[2]!.resolve(f.page(2));
    await vi.waitFor(() => expect(f.cache.size).toBe(2));
    f.responses[3]!.resolve(f.page(3));
    expect(await run).toMatchObject({
      bytesReceived: 400, snapshotPhaseBytesReceived: 400, resumedPhases: 1,
      timedOutPhases: 1, completedPhases: 2, checkpointAdvances: 0,
      backoffWorthyFailures: 1, snapshotPlaneIncomplete: 0, failedPhases: 1,
      swmCoverage: { snapshotsResolved: 0, snapshotsTotal: 4, missingCount: 4 },
    });
  } finally { f.releaseAll(); await run; }
});

it('logs a pool-surfaced permanent rejection as a missed seam without backing the peer off', async () => {
  const f = fixture(2);
  const warnings: string[] = [];
  const put = f.store.putSnapshot;
  f.store.putSnapshot = async input => {
    if (input.digest === f.refs[1]) throw new OversizedRdfLiteralError({ actualBytes: 100, maxBytes: 10 });
    return put(input);
  };
  const run = f.startSync(Date.now() + 60_000, (_ctx, message) => { warnings.push(message); });
  try {
    await f.waitForStarted(2);
    f.releaseAll();
    expect(await run).toMatchObject({
      completedPhases: 1, backoffWorthyFailures: 0, deniedPhases: 0, failedPhases: 1,
      swmCoverage: { snapshotsTotal: 2, missingCount: 2 },
    });
    expect(warnings).toEqual([
      expect.stringContaining('SWM sync for context graph "pool" from peer failed'),
      expect.stringContaining('PERMANENT ingest rejection for "pool" reached the SWM sync catch'),
    ]);
  } finally { f.releaseAll(); await run; }
});

it('retains deadline-yield evidence when an admitted sibling fails locally', async () => {
  const f = fixture(4); let now = 100;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const cacheGate = deferred<null>();
  f.store.getSnapshot = async ref => ref === f.refs[0] ? cacheGate.promise : null;
  const put = f.store.putSnapshot;
  f.store.putSnapshot = async input => {
    if (input.digest === f.refs[3]) throw new Error('local write failed');
    return put(input);
  };
  const run = f.startSync(200);
  try {
    await f.waitForStarted(3);
    now = 200; cacheGate.resolve(null); f.releaseAll();
    expect(await run).toMatchObject({
      bytesReceived: 300, snapshotPhaseBytesReceived: 300, completedPhases: 2,
      timedOutPhases: 0, backoffWorthyFailures: 0, snapshotPlaneIncomplete: 1,
    });
  } finally { cacheGate.resolve(null); f.releaseAll(); await run; }
});

it.each([false, true])('preserves typed failure identity and complete settled evidence (frozen=%s)', async frozen => {
  const f = fixture(4);
  const failure = new Error('local persistence failed');
  if (frozen) Object.freeze(failure);
  const put = f.store.putSnapshot;
  f.store.putSnapshot = async input => {
    if (input.digest === f.refs[3]) throw failure;
    return put(input);
  };
  const run = f.startSettled();
  try {
    await f.waitForStarted(4);
    f.responses[0]!.resolve(f.page(0, { completed: false, timedOut: true, resumedFromOffset: 3 }));
    f.responses[1]!.resolve(f.page(1)); f.responses[2]!.resolve(f.page(2));
    await vi.waitFor(() => expect(f.cache.size).toBe(2));
    f.responses[3]!.resolve(f.page(3));
    const outcome = await run;
    expect(outcome.kind).toBe('failure');
    if (outcome.kind !== 'failure') throw new Error('Expected a typed recovery failure');
    expect(outcome.error).toBe(failure);
    expect(outcome.result).toEqual({
      bytesReceived: 400, resumedPhases: 1, timedOutPhases: 1, completedPhases: 2,
      readySnapshots: 2, totalSnapshots: 4, missingCount: 2,
      missingSample: [f.refs[0], f.refs[3]], completed: false,
      // One classification for the round: the peer's timed-out page outranks a
      // plain shortfall, and no position yielded on our own allowance.
      outcome: 'timed-out',
    });
  } finally { f.releaseAll(); await run; }
});

it.each(['network', 'cache'] as const)('holds each pool slot through asynchronous %s materialization and drains callbacks', async source => {
  const f = fixture();
  if (source === 'cache') f.refs.forEach((ref, i) => f.cache.set(ref, f.payloads[i]!));
  const gates = f.refs.map(() => deferred<void>());
  const entered: number[] = [];
  let active = 0; let peak = 0; let settled = false;
  f.ready.mockImplementation(async snapshot => {
    const index = f.refs.indexOf(snapshot.ref);
    entered.push(index); active++; peak = Math.max(peak, active);
    try { await gates[index]!.promise; } finally { active--; }
  });
  f.releaseAll();
  const run = f.start();
  void run.then(() => { settled = true; }, () => { settled = true; });
  try {
    await vi.waitFor(() => expect(entered).toHaveLength(4));
    expect(f.cacheReads).toEqual([0, 1, 2, 3]);
    expect(f.started).toEqual(source === 'network' ? [0, 1, 2, 3] : []);
    expect(active).toBe(4); expect(settled).toBe(false);
    gates[1]!.resolve();
    await vi.waitFor(() => expect(entered).toHaveLength(5));
    expect(active).toBe(4); expect(peak).toBe(4); expect(settled).toBe(false);
    gates.slice(0, 7).forEach(gate => gate.resolve());
    await vi.waitFor(() => expect(entered).toHaveLength(8));
    expect(active).toBe(1); expect(settled).toBe(false);
    gates[7]!.resolve();
    expect(await run).toMatchObject({ readySnapshots: 8, missingCount: 0, completed: true });
    expect(active).toBe(0); expect(peak).toBe(4);
  } finally { gates.forEach(gate => gate.resolve()); f.releaseAll(); await run.catch(() => {}); }
});

/**
 * The mirror of the scenario above for a caller that requested NO pool.
 *
 * `onSnapshotReady` stands in for any non-reentrant caller port — the legacy
 * hook that opens a transaction, awaits a commit and closes it. Before the
 * bounded pool this helper entered it once at a time; an unchanged consumer
 * must still see peak concurrency 1, on the cache path as well as the network
 * one, without being asked to pass a new option for it.
 */
it.each(['network', 'cache'] as const)('keeps caller %s ports at peak concurrency 1 when no pool limit is requested', async source => {
  const f = fixture(4);
  if (source === 'cache') f.refs.forEach((ref, i) => f.cache.set(ref, f.payloads[i]!));
  const gates = f.refs.map(() => deferred<void>());
  const entered: number[] = [];
  let active = 0; let peak = 0; let settled = false;
  f.ready.mockImplementation(async snapshot => {
    const index = f.refs.indexOf(snapshot.ref);
    entered.push(index); active++; peak = Math.max(peak, active);
    try { await gates[index]!.promise; } finally { active--; }
  });
  f.releaseAll();
  const run = f.startLegacy();
  void run.then(() => { settled = true; }, () => { settled = true; });
  try {
    await vi.waitFor(() => expect(entered).toHaveLength(1));
    // Nothing beyond the held position is admitted: no second cache read, no
    // second dispatch, and above all no second callback.
    expect(active).toBe(1); expect(settled).toBe(false);
    expect(f.cacheReads).toEqual([0]);
    expect(f.started).toEqual(source === 'network' ? [0] : []);
    gates[0]!.resolve();
    await vi.waitFor(() => expect(entered).toHaveLength(2));
    expect(active).toBe(1); expect(peak).toBe(1); expect(settled).toBe(false);
    gates.forEach(gate => gate.resolve());
    expect(await run).toMatchObject({ readySnapshots: 4, missingCount: 0, completed: true });
    expect(entered).toEqual([0, 1, 2, 3]);
    expect(f.cacheReads).toEqual([0, 1, 2, 3]);
    expect(f.started).toEqual(source === 'network' ? [0, 1, 2, 3] : []);
    expect(active).toBe(0); expect(peak).toBe(1);
  } finally { gates.forEach(gate => gate.resolve()); f.releaseAll(); await run.catch(() => {}); }
});

/** The production round owns its ports, asks for the pool, and still gets it. */
it('keeps the production shared-memory round on the bounded pool it requests', async () => {
  const f = fixture(); const run = f.startSync();
  try {
    await f.waitForStarted(4); expect(f.started).toEqual([0, 1, 2, 3]);
    f.responses[2]!.resolve(f.page(2));
    await f.waitForStarted(5); expect(f.started).toEqual([0, 1, 2, 3, 4]);
    f.releaseAll();
    expect(await run).toMatchObject({
      bytesReceived: 800, snapshotPhaseBytesReceived: 800, failedPhases: 0,
    });
  } finally { f.releaseAll(); await run; }
});

it('admits four snapshot fetches and reuses each slot without exceeding the cap', async () => {
  const f = fixture(); const run = f.start();
  try {
    await f.waitForStarted(4); expect(f.started).toEqual([0, 1, 2, 3]);
    f.responses[2]!.resolve(f.page(2));
    await f.waitForStarted(5); expect(f.started).toEqual([0, 1, 2, 3, 4]);
    f.releaseAll();
    expect(await run).toMatchObject({ readySnapshots: 8, missingCount: 0, bytesReceived: 800, completed: true });
    expect(f.cache.size).toBe(8);
  } finally { f.releaseAll(); await run; }
});

it('reports missing refs in manifest order when short prefixes finish out of order', async () => {
  const f = fixture(16); const run = f.start();
  try {
    await f.waitForStarted(4);
    f.responses[3]!.resolve(f.page(3, { quads: [] }));
    await f.waitForStarted(5);
    f.responses[0]!.resolve(f.page(0));
    f.responses[1]!.resolve(f.page(1));
    f.responses.forEach((response, i) => response.resolve(f.page(i, { quads: [] })));
    expect(await run).toMatchObject({ readySnapshots: 2, missingCount: 14, missingSample: f.refs.slice(2, 12), completed: false, phaseFailureCause: 'transport', localYieldFailedPhases: 0 });
    expect(f.cache.size).toBe(2);
    expect(f.started).toHaveLength(16);
  } finally { f.releaseAll(); await run; }
});

it('checks the round deadline again before dispatch after an asynchronous cache miss', async () => {
  const f = fixture(); let now = 100;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const cacheGate = deferred<null>();
  let cacheReads = 0;
  f.store.getSnapshot = async () => { cacheReads++; return cacheGate.promise; };
  const run = f.start({ deadline: 200 });
  try {
    await vi.waitFor(() => expect(cacheReads).toBe(4));
    now = 200; cacheGate.resolve(null);
    expect(await run).toMatchObject({
      readySnapshots: 0, missingCount: 8, timedOutPhases: 0,
      localYield: true, phaseFailureCause: 'local-budget', localYieldFailedPhases: 1,
    });
    expect(f.started).toEqual([]);
  } finally { cacheGate.resolve(null); f.releaseAll(); await run; }
});

it('joins active siblings after a hard failure and returns ordered complete progress', async () => {
  const f = fixture(); const failure = new Error('snapshot zero is corrupt');
  const primary = new Error('snapshot three is corrupt');
  const run = f.startSettled();
  let settled = false; void run.then(() => { settled = true; });
  try {
    await f.waitForStarted(4);
    f.responses[3]!.reject(primary); f.responses[1]!.resolve(f.page(1));
    await vi.waitFor(() => expect(f.ready).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    expect(f.started).toEqual([0, 1, 2, 3]);
    f.responses[0]!.reject(failure);
    f.responses[2]!.resolve(f.page(2)); f.responses[1]!.resolve(f.page(1));
    const result = await run;
    expect(result).toMatchObject({ kind: 'failure', error: { cause: primary, errors: [primary, failure] } });
    if (result.kind !== 'failure') throw new Error('Expected concurrent failures');
    expect(result.result).toMatchObject({ readySnapshots: 2, totalSnapshots: 8,
      missingCount: 6, missingSample: [f.refs[0], ...f.refs.slice(3)] });
    expect(f.started).toEqual([0, 1, 2, 3]);
  } finally { f.releaseAll(); await run; }
});

it('joins admitted snapshots and stops further dispatch when a fetch is incomplete', async () => {
  const f = fixture(); const run = f.start();
  try {
    await f.waitForStarted(4);
    f.responses[0]!.resolve(f.page(0, { completed: false, timedOut: true }));
    f.responses[1]!.resolve(f.page(1));
    await vi.waitFor(() => expect(f.ready).toHaveBeenCalledTimes(1));
    f.releaseAll();
    expect(await run).toMatchObject({ readySnapshots: 3, missingCount: 5, timedOutPhases: 1,
      phaseFailureCause: 'transport', localYieldFailedPhases: 0, missingSample: [f.refs[0], ...f.refs.slice(4)] });
    expect(f.started).toEqual([0, 1, 2, 3]);
    expect(f.deleted).toHaveBeenCalledWith(f.refs[0]);
  } finally { f.releaseAll(); await run; }
});

it('joins revoked reads without admitting later checkpoint or materialization mutations', async () => {
  const f = fixture(); const controller = new AbortController(); const revoked = new Error('revoked');
  let revokedChecks = 0;
  const boundary = createRecoveryExecutionAdmission({ signal: controller.signal, assertCurrent: () => {
    if (controller.signal.aborted) { revokedChecks++; throw revoked; }
  } });
  const run = f.start({ executionBoundary: boundary });
  const outcome = run.then(value => ({ value }), error => ({ error }));
  let settled = false; void outcome.then(() => { settled = true; });
  try {
    await f.waitForStarted(4); controller.abort(); f.responses[0]!.resolve(f.page(0));
    await vi.waitFor(() => expect(revokedChecks).toBeGreaterThan(0));
    expect(settled).toBe(false);
    f.releaseAll(); expect(await outcome).toEqual({ error: revoked });
    expect(f.started).toEqual([0, 1, 2, 3]);
    expect(f.cache.size).toBe(0); expect(f.deleted).not.toHaveBeenCalled(); expect(f.ready).not.toHaveBeenCalled();
  } finally { f.releaseAll(); await outcome; }
});

it('settles a boundary revoked mid-flight instead of rejecting with the progress', async () => {
  // The settled API's whole point is that accounted work survives the failure.
  // A revocation after admission is a runtime failure like any other: it comes
  // back through the failure branch, not as a rejected promise.
  const f = fixture(); const controller = new AbortController(); const revoked = new Error('revoked');
  const boundary = createRecoveryExecutionAdmission({ signal: controller.signal, assertCurrent: () => {
    if (controller.signal.aborted) throw revoked;
  } });
  const settled = f.startSettled({ executionBoundary: boundary });
  await f.waitForStarted(4);
  // One position completes, then the boundary is revoked while the rest drain.
  f.responses[0]!.resolve(f.page(0));
  await vi.waitFor(() => expect(f.ready).toHaveBeenCalledTimes(1));
  controller.abort();
  f.releaseAll();

  const outcome = await settled;
  expect(outcome.kind).toBe('failure');
  if (outcome.kind !== 'failure') return;
  expect(outcome.error).toBe(revoked);
  // Complete manifest-ordered progress, including the position that finished.
  expect(outcome.result).toMatchObject({ totalSnapshots: 8, readySnapshots: 1, completed: false });
  expect(outcome.result.missingCount).toBe(7);
});

it('settles a boundary revoked before any position is attempted', async () => {
  const f = fixture(); const revoked = new Error('revoked before work');
  const boundary = createRecoveryExecutionAdmission({
    signal: new AbortController().signal,
    assertCurrent: () => { throw revoked; },
  });

  const outcome = await f.startSettled({ executionBoundary: boundary });
  expect(outcome).toMatchObject({ kind: 'failure', error: revoked });
  expect(outcome.result).toMatchObject({ totalSnapshots: 8, readySnapshots: 0, completed: false });
  expect(f.started).toEqual([]);
});

it.each([0, -1, 1.5, NaN, Infinity, 5])('rejects an invalid or excessive fetch pool limit %s', async fetchConcurrency => {
  const f = fixture();
  await expect(f.start({ fetchConcurrency })).rejects.toThrow('concurrency must be between');
  expect(f.started).toEqual([]);
});

it.each([1, 2])('permits a lower per-round concurrency of %s', async fetchConcurrency => {
  const f = fixture(); const run = f.start({ fetchConcurrency });
  try {
    await f.waitForStarted(fetchConcurrency);
    f.releaseAll(); expect(await run).toMatchObject({ readySnapshots: 8, completed: true });
  } finally { f.releaseAll(); await run; }
});

it.each(['denied', 'transport'] as const)('preserves a later-index %s failure when an earlier snapshot subsequently fails locally', async kind => {
  const f = fixture();
  const primary = kind === 'denied'
    ? toSyncDeniedError(new Error('peer denied snapshot'))
    : toSyncTransportFailureError(new Error('stream reset'));
  const local = new Error('local snapshot persistence failed');
  const put = f.store.putSnapshot;
  f.store.putSnapshot = async input => {
    if (input.digest === f.refs[0]) throw local;
    return put(input);
  };
  const run = f.startSettled();
  try {
    await f.waitForStarted(4);
    f.responses[3]!.reject(primary);
    f.responses[1]!.resolve(f.page(1));
    await vi.waitFor(() => expect(f.ready).toHaveBeenCalledTimes(1));
    f.responses[0]!.resolve(f.page(0)); f.responses[2]!.resolve(f.page(2));
    const outcome = await run;
    expect(outcome.kind).toBe('failure');
    if (outcome.kind !== 'failure') throw new Error('Expected concurrent failures');
    if (kind === 'denied') {
      expect(isSyncDeniedError(outcome.error)).toBe(true);
      expect(didSyncPeerRespond(outcome.error)).toBe(true);
    } else {
      expect(isSyncTransportFailure(outcome.error)).toBe(true);
      expect(isSyncBackoffWorthyError(outcome.error)).toBe(true);
    }
    expect(outcome.error.cause).toBe(primary);
    expect(outcome.error.errors).toEqual([primary, local]);
    expect(outcome.result).toMatchObject({ readySnapshots: 2, missingCount: 6 });
    expect(f.started).toEqual([0, 1, 2, 3]);
  } finally { f.releaseAll(); await run; }
});

it('treats a page-level local yield as its own budget decision and stops further dispatch', async () => {
  const f = fixture(); const run = f.start();
  try {
    await f.waitForStarted(4);
    f.responses[1]!.resolve(f.page(1, { completed: false, timedOut: false, localYield: true }));
    await vi.waitFor(() => expect(f.deleted).toHaveBeenCalledWith(f.refs[1]));
    f.responses[0]!.resolve(f.page(0)); f.responses[2]!.resolve(f.page(2)); f.responses[3]!.resolve(f.page(3));
    expect(await run).toMatchObject({
      readySnapshots: 3, missingCount: 5, timedOutPhases: 0, completed: false,
      localYield: true, phaseFailureCause: 'local-budget', localYieldFailedPhases: 1,
      missingSample: [f.refs[1], ...f.refs.slice(4)],
    });
    expect(f.started).toEqual([0, 1, 2, 3]);
  } finally { f.releaseAll(); await run; }
});

it('keeps a yield beside the peer evidence that classified the round', async () => {
  const f = fixture(); const run = f.start();
  try {
    await f.waitForStarted(4);
    // Our own allowance ran out on one position while the peer timed out on
    // another: the round is the peer's, the yield is still evidence we made.
    f.responses[1]!.resolve(f.page(1, { completed: false, timedOut: false, localYield: true }));
    f.responses[3]!.resolve(f.page(3, { completed: false, timedOut: true }));
    f.responses[0]!.resolve(f.page(0)); f.responses[2]!.resolve(f.page(2));
    expect(await run).toMatchObject({
      readySnapshots: 2, missingCount: 6, timedOutPhases: 1, completed: false,
      outcome: 'timed-out', localYield: true,
      // The legacy fields this helper has always returned follow that one
      // classification: the phase is charged to transport, not to our budget.
      phaseFailureCause: 'transport', localYieldFailedPhases: 0, checkpointAdvances: 0,
      missingSample: [f.refs[1], f.refs[3], ...f.refs.slice(4)],
    });
  } finally { f.releaseAll(); await run; }
});

it('answers the deprecated reader with the progress of the walk that threw', async () => {
  const f = fixture(4); const failure = new Error('local persistence failed');
  const put = f.store.putSnapshot;
  f.store.putSnapshot = async input => {
    if (input.digest === f.refs[3]) throw failure;
    return put(input);
  };
  const run = f.start();
  try {
    await f.waitForStarted(4);
    f.releaseAll();
    expect(await run.catch((error: unknown) => error)).toBe(failure);
    // Beside the error, never on it: the three refs this round did settle are
    // what a continuation caller needs so it neither replays them nor reads a
    // converging peer as stalled.
    expect(readPublicSnapshotWalkProgress(failure)).toEqual({
      readySnapshots: 3, totalSnapshots: 4, missingCount: 1, missingSample: [f.refs[3]],
    });
    expect(Object.keys(failure)).toEqual([]);
    expect(readPublicSnapshotWalkProgress(new Error('never walked'))).toBeUndefined();
  } finally { f.releaseAll(); await run.catch(() => {}); }
});

it('settles an empty manifest as a complete round without a store', async () => {
  const f = fixture(0);
  await expect(syncPublicSnapshotsForMeta({
    ctx: createOperationContext('sync'), remotePeerId: 'peer', contextGraphId: 'pool', metaQuads: [],
    deadline: Date.now() + 60_000, fetchSyncPages: f.fetchSyncPages,
    deleteCheckpoint: f.deleted, setCheckpoint: () => {}, onSnapshotReady: f.ready,
  })).resolves.toEqual({
    bytesReceived: 0, resumedPhases: 0, timedOutPhases: 0, completedPhases: 0,
    readySnapshots: 0, totalSnapshots: 0, missingCount: 0, missingSample: [],
    completed: true, outcome: 'completed', checkpointAdvances: 0, localYieldFailedPhases: 0,
  });
  expect(f.started).toEqual([]);
  expect(f.ready).not.toHaveBeenCalled();
});

it('counts prepared reuse entries as ready without cache reads, dispatch or callbacks', async () => {
  const f = fixture(4); f.releaseAll();
  const result = await syncPublicSnapshotsForMeta({
    ctx: createOperationContext('sync'), remotePeerId: 'peer', contextGraphId: 'pool',
    snapshotWalk: { entries: f.refs.map((ref, i) => ({ snapshot: { ref, digest: ref, count: 1 }, reuse: i % 2 === 0 })) },
    deadline: Date.now() + 60_000, publicSnapshotStore: f.store, fetchSyncPages: f.fetchSyncPages,
    deleteCheckpoint: f.deleted, setCheckpoint: () => {}, onSnapshotReady: f.ready,
  });
  expect(result).toMatchObject({ readySnapshots: 4, totalSnapshots: 4, completed: true, completedPhases: 2, bytesReceived: 200 });
  expect(result).not.toHaveProperty('localYield');
  expect(result).not.toHaveProperty('phaseFailureCause');
  expect(f.cacheReads).toEqual([1, 3]);
  expect(f.started).toEqual([1, 3]);
  expect(f.ready.mock.calls.map(([snapshot, source]) => [f.refs.indexOf(snapshot.ref), source])).toEqual([[1, 'network'], [3, 'network']]);
});
