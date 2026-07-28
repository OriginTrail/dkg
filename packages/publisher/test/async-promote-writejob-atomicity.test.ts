/**
 * #1933 — async-promote-queue `writeJob` atomicity.
 *
 * `writeJob` persists a job transition via the atomic `tryReplaceSubjectAtomically`
 * capability (ONE commit boundary) so a crash between the old delete-then-insert's two
 * separate commits can never strand the job subject empty (the row would be permanently
 * lost on restart), and a store client NOT holding the queue's in-process mutation lock
 * never observes the subject transiently empty. A store that cannot guarantee one commit
 * boundary (no `replaceSubject`, or a non-transactional endpoint that refuses it) takes the
 * bounded delete-then-insert fallback — still safe in-process because every promote-queue
 * transition and read serializes under `withMutationLock`.
 *
 * Parity with the async-lift publisher (#1863/#1919), adapted to the promote job's SINGLE
 * subject (no immutable request subject → no request-first ordering to prove).
 *
 * TEST HYGIENE: `withMutationLock` is a process-global static Map keyed by graphUri, so each
 * test uses a DISTINCT `graphUri`; a test that parks the lock (test 2) can never deadlock a
 * later test sharing the default control-plane graph.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  OxigraphStore,
  UnsupportedTripleStoreCapabilityError,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  PROMOTE_PAYLOAD,
  assertPromoteJobRecordSingleSubject,
  expectBindings,
  jobSubject,
  parseJobPayload,
  serializeJob,
} from '../src/async-promote-queue-utils.js';
import {
  type AsyncPromoteQueueConfig,
  type PromoteRequest,
} from '../src/async-promote-queue-types.js';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';

// Real store methods the proxies delegate to (kept typed so tests avoid `any`).
type RealStore = {
  replaceSubject: (g: string, s: string, q: unknown, o?: unknown) => Promise<void>;
  deleteByPattern: (p: unknown, o?: unknown) => Promise<unknown>;
};

describe('#1933 async-promote-queue writeJob atomicity', () => {
  let now: number;
  let ids: number;

  beforeEach(() => {
    now = 1_000_000;
    ids = 0;
  });

  function createQueue(store: TripleStore, graphUri: string, overrides: Partial<AsyncPromoteQueueConfig> = {}): TripleStoreAsyncPromoteQueue {
    return new TripleStoreAsyncPromoteQueue(store, {
      graphUri,
      now: () => now,
      idGenerator: () => `job-${++ids}`,
      ...overrides,
    });
  }

  function makeRequest(overrides: Partial<PromoteRequest> = {}): PromoteRequest {
    return {
      contextGraphId: 'graphify',
      subGraphName: 'code',
      assertionName: 'graphify-code-shard-1',
      entities: 'all',
      ...overrides,
    };
  }

  /**
   * Wrap an inner store, counting `replaceSubject` calls and control-graph
   * `deleteByPattern` calls. `mode` selects the capability behaviour:
   *  - `real`   — delegate to the real (atomic) replaceSubject.
   *  - `absent` — no replaceSubject capability at all (tryReplaceSubjectAtomically → false).
   *  - `refuse` — replaceSubject present but raises a clean capability refusal
   *               (SparqlHttpStore with atomicUpdates:false parity).
   */
  function countingStore(
    inner: OxigraphStore,
    graphUri: string,
    mode: 'real' | 'absent' | 'refuse',
  ): { store: TripleStore; counts: { replaceSubject: number; jobGraphDeletes: number } } {
    const counts = { replaceSubject: 0, jobGraphDeletes: 0 };
    const store = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'replaceSubject') {
          if (mode === 'absent') return undefined;
          return async (g: string, s: string, q: unknown, o?: unknown) => {
            counts.replaceSubject++;
            if (mode === 'refuse') {
              throw new UnsupportedTripleStoreCapabilityError('replaceSubject', 'SparqlHttpStore');
            }
            return (target as unknown as RealStore).replaceSubject(g, s, q, o);
          };
        }
        if (prop === 'deleteByPattern') {
          return async (pattern: { graph?: string }, o?: unknown) => {
            if (pattern?.graph === graphUri) counts.jobGraphDeletes++;
            return (target as unknown as RealStore).deleteByPattern(pattern, o);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as TripleStore;
    return { store, counts };
  }

  it('writeJob routes the transition through replaceSubject, not delete-then-insert', async () => {
    // The orchestration proof: a queued→running transition goes through the atomic
    // capability, never a control-graph deleteByPattern+insert. (Internal commit atomicity
    // of replaceSubject is a storage-layer concern, proven at that layer.)
    const graphUri = 'urn:test:promote:atomic-routes-through-replace';
    const { store, counts } = countingStore(new OxigraphStore(), graphUri, 'real');
    const queue = createQueue(store, graphUri);

    const jobId = await queue.enqueue(makeRequest());
    await queue.claimNext('worker-1');

    expect(counts.replaceSubject).toBeGreaterThanOrEqual(2); // enqueue + claim
    expect(counts.jobGraphDeletes).toBe(0);
    expect((await queue.getStatus(jobId))?.state).toBe('running');
  });

  it('a store client racing the parked replace never sees the subject transiently empty', async () => {
    // Park the claim transition AT the capability call, then read the INNER store RAW
    // (bypassing the queue's mutation lock — the queue's own getStatus would deadlock on the
    // held lock). The subject must still carry the PRIOR (queued) payload, never empty.
    const graphUri = 'urn:test:promote:parked-replace-never-empty';
    const inner = new OxigraphStore();
    let jobGraphDeletes = 0;
    let armed = false;
    let reachedGate!: () => void;
    const reached = new Promise<void>((resolve) => { reachedGate = resolve; });
    let releaseGate!: () => void;
    const released = new Promise<void>((resolve) => { releaseGate = resolve; });

    const store = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'replaceSubject') {
          return async (g: string, s: string, q: unknown, o?: unknown) => {
            if (armed) { armed = false; reachedGate(); await released; }
            return (target as unknown as RealStore).replaceSubject(g, s, q, o);
          };
        }
        if (prop === 'deleteByPattern') {
          return async (pattern: { graph?: string }, o?: unknown) => {
            if (pattern?.graph === graphUri) jobGraphDeletes++;
            return (target as unknown as RealStore).deleteByPattern(pattern, o);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as TripleStore;

    const queue = createQueue(store, graphUri);
    const jobId = await queue.enqueue(makeRequest());

    armed = true;
    const claim = queue.claimNext('worker-1');
    await reached; // parked at the claim's replaceSubject, before it commits

    // The prior queued row is still fully present (no delete-then-insert empty window).
    const rows = expectBindings(await inner.query(
      `SELECT ?payload WHERE { GRAPH <${graphUri}> { <${jobSubject(jobId)}> <${PROMOTE_PAYLOAD}> ?payload } }`,
    ));
    expect(rows.length).toBeGreaterThan(0);
    expect(parseJobPayload(rows[0]?.['payload'])?.state).toBe('queued');

    releaseGate();
    const claimed = await claim;
    expect(claimed?.state).toBe('running');
    expect(jobGraphDeletes).toBe(0);
    expect((await queue.getStatus(jobId))?.state).toBe('running');
  });

  it('falls back to delete-then-insert when the store has no replaceSubject capability', async () => {
    const graphUri = 'urn:test:promote:fallback-no-capability';
    const { store, counts } = countingStore(new OxigraphStore(), graphUri, 'absent');
    const queue = createQueue(store, graphUri);

    const jobId = await queue.enqueue(makeRequest());
    await queue.claimNext('worker-1');

    expect((await queue.getStatus(jobId))?.state).toBe('running');
    expect(counts.replaceSubject).toBe(0);
    expect(counts.jobGraphDeletes).toBeGreaterThan(0);
  });

  it('falls back when the store implements replaceSubject but refuses it (non-atomic backend)', async () => {
    const graphUri = 'urn:test:promote:fallback-refused';
    const { store, counts } = countingStore(new OxigraphStore(), graphUri, 'refuse');
    const queue = createQueue(store, graphUri);

    const jobId = await queue.enqueue(makeRequest());
    await queue.claimNext('worker-1');

    expect((await queue.getStatus(jobId))?.state).toBe('running');
    // The capability was attempted (and refused), then the bounded fallback ran.
    expect(counts.replaceSubject).toBeGreaterThan(0);
    expect(counts.jobGraphDeletes).toBeGreaterThan(0);
  });

  it('cancel RETAINS the row and routes through the atomic replace (never a delete)', async () => {
    // cancel rewrites queued→failed/cancelled VIA writeJob; the atomic replace preserves the
    // retain semantics by construction (a replace, not a delete). Guards against a regression
    // that turns cancel into a genuine removal.
    const graphUri = 'urn:test:promote:cancel-retains-row';
    const { store, counts } = countingStore(new OxigraphStore(), graphUri, 'real');
    const queue = createQueue(store, graphUri);

    const jobId = await queue.enqueue(makeRequest());
    await queue.cancel(jobId);

    const cancelled = await queue.getStatus(jobId);
    expect(cancelled).not.toBeNull();
    expect(cancelled?.state).toBe('failed');
    expect(cancelled?.reason).toBe('cancelled');
    // No control-graph delete fired across enqueue+cancel; both went through replaceSubject.
    expect(counts.jobGraphDeletes).toBe(0);
    expect(counts.replaceSubject).toBeGreaterThan(0);
  });

  it('clearTerminalJob still deletes a terminal row (genuine-delete path untouched)', async () => {
    const graphUri = 'urn:test:promote:clear-terminal-still-deletes';
    const { store, counts } = countingStore(new OxigraphStore(), graphUri, 'real');
    const queue = createQueue(store, graphUri);

    const jobId = await queue.enqueue(makeRequest());
    await queue.cancel(jobId); // queued → failed (terminal)

    const outcome = await queue.clearTerminalJob(jobId);
    expect(outcome.outcome).toBe('cleared');
    expect(await queue.getStatus(jobId)).toBeNull();
    // The clear's deleteJob is a genuine control-graph delete (writes never delete here).
    expect(counts.jobGraphDeletes).toBeGreaterThan(0);
  });

  it('the single-subject guard accepts serializeJob output and is fail-loud on a stray subject', async () => {
    const graphUri = 'urn:test:promote:single-subject-guard';
    const queue = createQueue(new OxigraphStore(), graphUri);
    const jobId = await queue.enqueue(makeRequest());
    const job = (await queue.getStatus(jobId))!;

    const jobRef = jobSubject(jobId);
    const jobQuads = serializeJob(job, graphUri);
    expect(jobQuads.length).toBeGreaterThan(0);
    expect(jobQuads.every((q) => q.subject === jobRef)).toBe(true);
    // serializeJob's output is exactly one subject → the writer's guard passes.
    expect(() => assertPromoteJobRecordSingleSubject(jobId, jobRef, jobQuads)).not.toThrow();

    // Guard (future-proofing tripwire): a stray-subject quad must throw at the boundary
    // rather than reach the STRICT single-subject replace / leak past the fallback delete.
    const strayQuad: Quad = {
      subject: jobSubject('some-other-job'),
      predicate: 'urn:dkg:promote-queue:state',
      object: '"queued"',
      graph: graphUri,
    };
    expect(() =>
      assertPromoteJobRecordSingleSubject(jobId, jobRef, [...jobQuads, strayQuad]),
    ).toThrow(/outside the job subject/);
  });
});
