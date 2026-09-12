import { afterEach, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import { readPublicSnapshotWalkProgress, runSharedMemorySync, syncPublicSnapshotsForMeta, type PublicSnapshotMetadata } from '../src/sync/requester/shared-memory-sync.js';
import { createRecoveryExecutionAdmission } from '../src/sync/requester/recovery-execution-guard.js';
import { readPublicSnapshotRecoveryResult, recoverPublicSnapshots } from '../src/sync/requester/public-snapshot-recovery.js';
import { didSyncPeerRespond, isSyncBackoffWorthyError, isSyncTransportFailure, toSyncTransportFailureError } from '../src/sync/error-tags.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

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
  const start = (overrides: Partial<Pick<Parameters<typeof syncPublicSnapshotsForMeta>[0], 'deadline' | 'executionBoundary' | 'fetchConcurrency'>> = {}) => syncPublicSnapshotsForMeta({
    ctx: createOperationContext('sync'), remotePeerId: 'peer', contextGraphId: 'pool', metaQuads,
    deadline: Date.now() + 60_000, publicSnapshotStore: store,
    fetchSyncPages,
    deleteCheckpoint: deleted, setCheckpoint: () => {}, onSnapshotReady: ready, ...overrides,
  });
  const startSync = (deadline = Date.now() + 60_000) => runSharedMemorySync({
    mode: { kind: 'ordinary' }, ctx: createOperationContext('sync'), remotePeerId: 'peer', contextGraphIds: ['pool'],
    createContextGraphSyncDeadline: () => deadline, fetchSyncPages,
    processSharedMemoryBatch: async () => ({
      verifiedData: [], verifiedMeta: metaQuads, totalFetchedDataQuads: 0,
      totalFetchedMetaQuads: metaQuads.length, droppedDataTriples: 0, emptyResponses: 0, entityCreators: [],
    }),
    publicSnapshotStore: store, ensureContextGraph: async () => {}, storeInsert: async () => {},
    deleteCheckpoint: deleted, setCheckpoint: () => {}, ensureOwnedMap: () => new Map(),
    logInfo: () => {}, logWarn: () => {}, logDebug: () => {},
  });
  const releaseAll = () => responses.forEach((response, i) => response.resolve(page(i)));
  const waitForStarted = (count: number) => vi.waitFor(() => expect(started).toHaveLength(count));
  return { refs, payloads, responses, started, cacheReads, cache, store, deleted, ready, page, start, startSync, releaseAll, waitForStarted };
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

it.each([false, true])('preserves direct-helper failure identity and complete evidence (frozen=%s)', async frozen => {
  const f = fixture(4);
  const failure = new Error('local persistence failed');
  if (frozen) Object.freeze(failure);
  const put = f.store.putSnapshot;
  f.store.putSnapshot = async input => {
    if (input.digest === f.refs[3]) throw failure;
    return put(input);
  };
  const run = recoverPublicSnapshots({
    snapshots: f.refs.map(ref => ({ ref, digest: ref, count: 1 })), contextGraphId: 'pool',
    deadline: Date.now() + 60_000, store: f.store, executionBoundary: createRecoveryExecutionAdmission(),
    fetchSnapshot: async snapshot => {
      const index = f.refs.indexOf(snapshot.ref); f.started.push(index); return f.responses[index]!.promise;
    },
    deleteCheckpoint: f.deleted, onSnapshotReady: f.ready,
  }).catch(error => error);
  try {
    await f.waitForStarted(4);
    f.responses[0]!.resolve(f.page(0, { completed: false, timedOut: true, resumedFromOffset: 3 }));
    f.responses[1]!.resolve(f.page(1)); f.responses[2]!.resolve(f.page(2));
    await vi.waitFor(() => expect(f.cache.size).toBe(2));
    f.responses[3]!.resolve(f.page(3));
    expect(await run).toBe(failure);
    expect(readPublicSnapshotRecoveryResult(failure)).toEqual({
      bytesReceived: 400, resumedPhases: 1, timedOutPhases: 1, completedPhases: 2,
      checkpointAdvances: 0, readySnapshots: 2, totalSnapshots: 4, missingCount: 2,
      missingSample: [f.refs[0], f.refs[3]], completed: false, yieldedAtDeadline: false,
    });
    expect(readPublicSnapshotWalkProgress(failure)).toEqual({
      readySnapshots: 2, totalSnapshots: 4, missingCount: 2, missingSample: [f.refs[0], f.refs[3]],
    });
    readPublicSnapshotRecoveryResult(failure)!.missingSample.length = 0;
    expect(readPublicSnapshotWalkProgress(failure)?.missingSample).toEqual([f.refs[0], f.refs[3]]);
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
    expect(await run).toMatchObject({ readySnapshots: 2, missingCount: 14, missingSample: f.refs.slice(2, 12), completed: false, yieldedAtDeadline: false });
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
    expect(await run).toMatchObject({ readySnapshots: 0, missingCount: 8, yieldedAtDeadline: true, timedOutPhases: 0 });
    expect(f.started).toEqual([]);
  } finally { cacheGate.resolve(null); f.releaseAll(); await run; }
});

it('joins active siblings after a hard failure and attaches ordered complete progress', async () => {
  const f = fixture(); const failure = new Error('snapshot zero is corrupt');
  const primary = new Error('snapshot three is corrupt');
  const run = f.start(); const outcome = run.then(value => ({ value }), error => ({ error }));
  let settled = false; void outcome.then(() => { settled = true; });
  try {
    await f.waitForStarted(4);
    f.responses[3]!.reject(primary); f.responses[1]!.resolve(f.page(1));
    await vi.waitFor(() => expect(f.ready).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    expect(f.started).toEqual([0, 1, 2, 3]);
    f.responses[0]!.reject(failure);
    f.responses[2]!.resolve(f.page(2)); f.responses[1]!.resolve(f.page(1));
    const result = await outcome;
    expect(result).toMatchObject({ error: { cause: primary, errors: [primary, failure] } });
    if (!('error' in result)) throw new Error('Expected concurrent failures');
    expect(readPublicSnapshotWalkProgress(result.error)).toEqual({ readySnapshots: 2, totalSnapshots: 8,
      missingCount: 6, missingSample: [f.refs[0], ...f.refs.slice(3)] });
    expect(f.started).toEqual([0, 1, 2, 3]);
  } finally { f.releaseAll(); await outcome; }
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
      yieldedAtDeadline: false, missingSample: [f.refs[0], ...f.refs.slice(4)] });
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
    ? Object.assign(new Error('peer denied snapshot'), { syncDenied: true })
    : toSyncTransportFailureError(new Error('stream reset'));
  const local = new Error('local snapshot persistence failed');
  const put = f.store.putSnapshot;
  f.store.putSnapshot = async input => {
    if (input.digest === f.refs[0]) throw local;
    return put(input);
  };
  const run = f.start().then(value => ({ value }), error => ({ error }));
  try {
    await f.waitForStarted(4);
    f.responses[3]!.reject(primary);
    f.responses[1]!.resolve(f.page(1));
    await vi.waitFor(() => expect(f.ready).toHaveBeenCalledTimes(1));
    f.responses[0]!.resolve(f.page(0)); f.responses[2]!.resolve(f.page(2));
    const outcome = await run;
    expect(outcome).toHaveProperty('error');
    if (!('error' in outcome)) throw new Error('Expected concurrent failures');
    if (kind === 'denied') {
      expect(outcome.error.syncDenied).toBe(true);
      expect(didSyncPeerRespond(outcome.error)).toBe(true);
    } else {
      expect(isSyncTransportFailure(outcome.error)).toBe(true);
      expect(isSyncBackoffWorthyError(outcome.error)).toBe(true);
    }
    expect(outcome.error.cause).toBe(primary);
    expect(outcome.error.errors).toEqual([primary, local]);
    expect(readPublicSnapshotWalkProgress(outcome.error)).toMatchObject({ readySnapshots: 2, missingCount: 6 });
    expect(f.started).toEqual([0, 1, 2, 3]);
  } finally { f.releaseAll(); await run; }
});
