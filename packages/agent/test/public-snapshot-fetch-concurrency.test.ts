import { afterEach, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import { readPublicSnapshotWalkProgress, syncPublicSnapshotsForMeta } from '../src/sync/requester/shared-memory-sync.js';
import { createRecoveryExecutionAdmission } from '../src/sync/requester/recovery-execution-guard.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

afterEach(() => vi.restoreAllMocks());
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
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
  const cache = new Map<string, Quad[]>();
  const store: WorkspacePublicSnapshotStore = {
    getSnapshot: async ref => cache.get(ref) ?? null,
    putSnapshot: async ({ digest, quads }) => { cache.set(digest, [...quads]); return { ref: digest, byteLength: 100 }; },
  };
  const deleted = vi.fn();
  const ready = vi.fn(async () => {});
  const page = (index: number, overrides: Partial<SyncPageResult> = {}): SyncPageResult => ({
    quads: payloads[index]!, bytesReceived: 100, resumedFromOffset: 0, responderSessionStartedFresh: true,
    nextOffset: 1, checkpointKey: refs[index]!, completed: true, timedOut: false, ...overrides,
  });
  const start = (overrides: Partial<Pick<Parameters<typeof syncPublicSnapshotsForMeta>[0], 'deadline' | 'executionBoundary' | 'fetchConcurrency'>> = {}) => syncPublicSnapshotsForMeta({
    ctx: createOperationContext('sync'), remotePeerId: 'peer', contextGraphId: 'pool', metaQuads,
    deadline: Date.now() + 60_000, publicSnapshotStore: store,
    fetchSyncPages: async (_ctx, _peer, _cg, _shared, _phase, _graph, _deadline, options) => {
      const index = refs.indexOf(options!.snapshotRef!); started.push(index); return responses[index]!.promise;
    },
    deleteCheckpoint: deleted, setCheckpoint: () => {}, onSnapshotReady: ready, ...overrides,
  });
  const releaseAll = () => responses.forEach((response, i) => response.resolve(page(i)));
  return { refs, responses, started, cache, store, deleted, ready, page, start, releaseAll };
}

it('admits four snapshot fetches and reuses each slot without exceeding the cap', async () => {
  const f = fixture(); const run = f.start();
  try {
    await flush(); expect(f.started).toEqual([0, 1, 2, 3]);
    f.responses[2]!.resolve(f.page(2));
    await flush(); expect(f.started).toEqual([0, 1, 2, 3, 4]);
    f.releaseAll();
    expect(await run).toMatchObject({ readySnapshots: 8, missingCount: 0, bytesReceived: 800, completed: true });
    expect(f.cache.size).toBe(8);
  } finally { f.releaseAll(); await run; }
});

it('reports missing refs in manifest order when short prefixes finish out of order', async () => {
  const f = fixture(16); const run = f.start();
  try {
    await flush();
    f.responses[3]!.resolve(f.page(3, { quads: [] }));
    await flush();
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
  f.store.getSnapshot = async () => cacheGate.promise;
  const run = f.start({ deadline: 200 });
  await flush(); now = 200; cacheGate.resolve(null);
  try {
    await flush(); expect(f.started).toEqual([]);
    expect(await run).toMatchObject({ readySnapshots: 0, missingCount: 8, yieldedAtDeadline: true, timedOutPhases: 0 });
  } finally { f.releaseAll(); await run; }
});

it('joins active siblings after a hard failure and attaches ordered complete progress', async () => {
  const f = fixture(); const failure = new Error('snapshot zero is corrupt');
  const run = f.start(); const outcome = run.then(value => ({ value }), error => ({ error }));
  let settled = false; void outcome.then(() => { settled = true; });
  try {
    await flush(); f.responses[3]!.reject(new Error('snapshot three is corrupt')); await flush();
    expect(settled).toBe(false);
    expect(f.started).toEqual([0, 1, 2, 3]);
    f.responses[0]!.reject(failure);
    f.responses[2]!.resolve(f.page(2)); f.responses[1]!.resolve(f.page(1));
    expect(await outcome).toEqual({ error: failure });
    expect(readPublicSnapshotWalkProgress(failure)).toEqual({ readySnapshots: 2, totalSnapshots: 8,
      missingCount: 6, missingSample: [f.refs[0], ...f.refs.slice(3)] });
    expect(f.started).toEqual([0, 1, 2, 3]);
  } finally { f.releaseAll(); await outcome; }
});

it('joins admitted snapshots and stops further dispatch when a fetch is incomplete', async () => {
  const f = fixture(); const run = f.start();
  try {
    await flush(); f.responses[0]!.resolve(f.page(0, { completed: false, timedOut: true })); await flush();
    f.releaseAll();
    expect(await run).toMatchObject({ readySnapshots: 3, missingCount: 5, timedOutPhases: 1,
      yieldedAtDeadline: false, missingSample: [f.refs[0], ...f.refs.slice(4)] });
    expect(f.started).toEqual([0, 1, 2, 3]);
    expect(f.deleted).toHaveBeenCalledWith(f.refs[0]);
  } finally { f.releaseAll(); await run; }
});

it('joins revoked reads without admitting later checkpoint or materialization mutations', async () => {
  const f = fixture(); const controller = new AbortController(); const revoked = new Error('revoked');
  const boundary = createRecoveryExecutionAdmission({ signal: controller.signal, assertCurrent: () => { if (controller.signal.aborted) throw revoked; } });
  const run = f.start({ executionBoundary: boundary });
  const outcome = run.then(value => ({ value }), error => ({ error }));
  let settled = false; void outcome.then(() => { settled = true; });
  try {
    await flush(); controller.abort(); f.responses[0]!.resolve(f.page(0)); await flush();
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
    await flush(); expect(f.started).toHaveLength(fetchConcurrency);
    f.releaseAll(); expect(await run).toMatchObject({ readySnapshots: 8, completed: true });
  } finally { f.releaseAll(); await run; }
});
