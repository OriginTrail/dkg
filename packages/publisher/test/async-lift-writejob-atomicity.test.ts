import { beforeEach, describe, expect, it } from 'vitest';
import {
  OxigraphStore,
  UnsupportedTripleStoreCapabilityError,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
} from '../src/index.js';
import {
  DEFAULT_CONTROL_GRAPH_URI,
  jobSubject,
  requestSubject,
  serializeJob,
  serializeJobRecord,
} from '../src/async-lift-control-plane.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from './_helpers/ka-vm-publish.js';

// #1863 — writeJob persists a job transition via the atomic
// tryReplaceSubjectAtomically capability so a lock-free reader racing a
// transition never observes the job subject transiently empty (a false
// `kind:'none'` intent-lookup miss / dedup gap). A store that cannot guarantee
// one commit boundary (no replaceSubject, or a non-transactional endpoint that
// refuses it) takes the bounded delete-then-insert fallback.
describe('#1863 async-lift writeJob atomicity', () => {
  let now = 1_000;
  let ids = 0;
  // The facts a recovering client retains (never the jobId or intentKey).
  const facts = { contextGraphId: 'music-social', name: 'albums' };

  beforeEach(() => {
    now = 1_000;
    ids = 0;
  });

  function makePublisher(
    store: TripleStore,
    config: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator'> = {},
  ): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++now,
      idGenerator: () => `job-${++ids}`,
      ...config,
    });
  }

  it('replaces the job subject atomically — a racing reader never sees a false none', async () => {
    const inner = new OxigraphStore();
    let replaceSubjectCalls = 0;
    let jobGraphDeletes = 0;
    let armed = false;
    let releaseGate!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let reachedGate!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });

    // Delegate to the real store, but gate the atomic replaceSubject so we can
    // observe the store deterministically WHILE the transition is parked, before
    // it applies.
    const store = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'replaceSubject') {
          return async (graphUri: string, subject: string, quads: unknown, options?: unknown) => {
            replaceSubjectCalls++;
            if (armed) {
              reachedGate();
              await released;
            }
            return (target as unknown as {
              replaceSubject: (g: string, s: string, q: unknown, o?: unknown) => Promise<void>;
            }).replaceSubject(graphUri, subject, quads, options);
          };
        }
        if (prop === 'deleteByPattern') {
          return async (pattern: { graph?: string }, options?: unknown) => {
            if (pattern?.graph === DEFAULT_CONTROL_GRAPH_URI) jobGraphDeletes++;
            return (target as unknown as {
              deleteByPattern: (p: unknown, o?: unknown) => Promise<unknown>;
            }).deleteByPattern(pattern, options);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as TripleStore;

    const publisher = makePublisher(store);
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');

    armed = true;
    const transition = publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await reached; // the atomic replace is parked BEFORE it applies

    // Mid-transition the store still holds the complete prior (claimed) job.
    const lookup = await publisher.lookupKnowledgeAssetVmPublishJobByIntent(facts);
    expect(lookup.kind).not.toBe('none');
    expect(await publisher.getStatus(jobId)).not.toBeNull();

    releaseGate();
    await transition;

    // The atomic path never delete-then-inserts the job subject.
    expect(jobGraphDeletes).toBe(0);
    expect(replaceSubjectCalls).toBeGreaterThanOrEqual(1);
    expect((await publisher.getStatus(jobId))?.status).toBe('validated');
  });

  it('falls back to delete-then-insert when the store has no replaceSubject capability', async () => {
    const inner = new OxigraphStore();
    let jobGraphDeletes = 0;

    const store = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'replaceSubject') return undefined; // capability absent
        if (prop === 'deleteByPattern') {
          return async (pattern: { graph?: string }, options?: unknown) => {
            if (pattern?.graph === DEFAULT_CONTROL_GRAPH_URI) jobGraphDeletes++;
            return (target as unknown as {
              deleteByPattern: (p: unknown, o?: unknown) => Promise<unknown>;
            }).deleteByPattern(pattern, options);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as TripleStore;

    const publisher = makePublisher(store);
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });

    expect((await publisher.getStatus(jobId))?.status).toBe('validated');
    expect((await publisher.lookupKnowledgeAssetVmPublishJobByIntent(facts)).kind).toBe('active');
    expect(jobGraphDeletes).toBeGreaterThan(0);
  });

  it('falls back when a store implements replaceSubject but refuses it (non-atomic backend)', async () => {
    // Mirrors SparqlHttpStore with atomicUpdates:false: replaceSubject is present
    // but raises a clean capability refusal, so the publisher must delete-then-insert.
    const inner = new OxigraphStore();
    let replaceSubjectCalls = 0;
    let jobGraphDeletes = 0;

    const store = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'replaceSubject') {
          return async () => {
            replaceSubjectCalls++;
            throw new UnsupportedTripleStoreCapabilityError('replaceSubject', 'SparqlHttpStore');
          };
        }
        if (prop === 'deleteByPattern') {
          return async (pattern: { graph?: string }, options?: unknown) => {
            if (pattern?.graph === DEFAULT_CONTROL_GRAPH_URI) jobGraphDeletes++;
            return (target as unknown as {
              deleteByPattern: (p: unknown, o?: unknown) => Promise<unknown>;
            }).deleteByPattern(pattern, options);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as TripleStore;

    const publisher = makePublisher(store);
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });

    expect((await publisher.getStatus(jobId))?.status).toBe('validated');
    expect((await publisher.lookupKnowledgeAssetVmPublishJobByIntent(facts)).kind).toBe('active');
    // The capability was attempted (and refused), then the fallback ran.
    expect(replaceSubjectCalls).toBeGreaterThan(0);
    expect(jobGraphDeletes).toBeGreaterThan(0);
  });

  it('at creation, the request row is present before the job subject becomes observable', async () => {
    // #1863 ordering invariant: persistJobRecord inserts the request rows BEFORE
    // the atomic job-subject replace, so a lock-free reader at creation never sees
    // a job referencing an absent request (dangling requestRef). Gate the creation
    // replaceSubject and observe the store at the moment the job is about to become
    // observable: the request must already be present, the job subject must not.
    const inner = new OxigraphStore();
    let armed = false;
    let reachedGate!: () => void;
    const reached = new Promise<void>((resolve) => { reachedGate = resolve; });
    let releaseGate!: () => void;
    const released = new Promise<void>((resolve) => { releaseGate = resolve; });

    const store = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'replaceSubject') {
          return async (graphUri: string, subject: string, quads: unknown, options?: unknown) => {
            if (armed) { armed = false; reachedGate(); await released; }
            return (target as unknown as {
              replaceSubject: (g: string, s: string, q: unknown, o?: unknown) => Promise<void>;
            }).replaceSubject(graphUri, subject, quads, options);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as TripleStore;

    const publisher = makePublisher(store);
    armed = true;
    const creation = publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await reached; // parked at the creation replaceSubject, AFTER the request insert

    // Request present; job subject not yet observable.
    const reqRows = await inner.query(
      `SELECT ?p WHERE { GRAPH <${DEFAULT_CONTROL_GRAPH_URI}> { <${requestSubject('job-1')}> ?p ?o } }`,
    );
    expect(reqRows.type === 'bindings' ? reqRows.bindings.length : 0).toBeGreaterThan(0);
    const jobBefore = await inner.query(
      `SELECT ?p WHERE { GRAPH <${DEFAULT_CONTROL_GRAPH_URI}> { <${jobSubject('job-1')}> ?p ?o } }`,
    );
    expect(jobBefore.type === 'bindings' ? jobBefore.bindings.length : -1).toBe(0);

    releaseGate();
    await creation;

    // After creation both are present.
    const jobAfter = await inner.query(
      `SELECT ?p WHERE { GRAPH <${DEFAULT_CONTROL_GRAPH_URI}> { <${jobSubject('job-1')}> ?p ?o } }`,
    );
    expect(jobAfter.type === 'bindings' ? jobAfter.bindings.length : 0).toBeGreaterThan(0);
  });

  it('serializeJobRecord splits exhaustively into exactly the job and request subjects', async () => {
    const publisher = makePublisher(new OxigraphStore());
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const job = (await publisher.getStatus(jobId))!;

    const record = serializeJobRecord(job, DEFAULT_CONTROL_GRAPH_URI);
    expect(record.jobRef).toBe(jobSubject(jobId));
    expect(record.requestRef).toBe(requestSubject(jobId));
    expect(record.jobQuads.every((q) => q.subject === jobSubject(jobId))).toBe(true);
    expect(record.requestQuads.every((q) => q.subject === requestSubject(jobId))).toBe(true);
    expect(record.jobQuads.length).toBeGreaterThan(0);
    expect(record.requestQuads.length).toBeGreaterThan(0);
    // Nothing dropped: the two groups partition the full serializeJob output.
    expect(record.jobQuads.length + record.requestQuads.length).toBe(
      serializeJob(job, DEFAULT_CONTROL_GRAPH_URI).length,
    );
  });
});
