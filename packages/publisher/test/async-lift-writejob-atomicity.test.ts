import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
} from '../src/index.js';
import {
  CONTROL_LIFECYCLE_KEY,
  CONTROL_PAYLOAD,
  CONTROL_STATUS,
  DEFAULT_CONTROL_GRAPH_URI,
} from '../src/async-lift-control-plane.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from './_helpers/ka-vm-publish.js';

// #1863 — writeJob persists a job transition as a single-subject atomic replace
// (DELETE WHERE + INSERT DATA in one store.update() transaction) so a lock-free
// reader racing a transition never observes the job subject transiently empty
// (which surfaced as a false `kind:'none'` intent-lookup miss / dedup gap).
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

  it('rewrites the job subject in one atomic update — a racing reader never sees a false none', async () => {
    const inner = new OxigraphStore();
    let updateCalls = 0;
    let jobGraphDeletes = 0;
    let capturedSparql = '';
    let armed = false;
    let releaseGate!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let reachedGate!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });

    // Delegate everything to the real store (bound there, so its state stays
    // coherent), but gate the single atomic `update()` so we can observe the
    // store deterministically WHILE the transition is parked, before it applies.
    const store = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'update') {
          return async (sparql: string, options?: unknown) => {
            updateCalls++;
            if (armed) {
              capturedSparql = sparql;
              reachedGate();
              await released;
            }
            return (target as unknown as {
              update: (s: string, o?: unknown) => Promise<void>;
            }).update(sparql, options);
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
    await reached; // the atomic update() is now parked BEFORE it applies

    // Mid-transition the store still holds the complete prior (claimed) job:
    // the intent lookup and getStatus resolve against fully-prior state, never
    // a transiently-empty subject.
    const lookup = await publisher.lookupKnowledgeAssetVmPublishJobByIntent(facts);
    expect(lookup.kind).not.toBe('none');
    expect(await publisher.getStatus(jobId)).not.toBeNull();

    releaseGate();
    await transition;

    // The atomic path never delete-then-inserts the job subject.
    expect(jobGraphDeletes).toBe(0);
    expect(updateCalls).toBeGreaterThanOrEqual(1);

    // The payload, the status AND the CONTROL_LIFECYCLE_KEY intent-index row all
    // land in the SAME INSERT DATA — the index row (whose transient absence caused
    // the false `none`) is never written separately from the rest of the subject.
    const insertData = capturedSparql.slice(capturedSparql.indexOf('INSERT DATA'));
    expect(insertData).toContain(CONTROL_PAYLOAD);
    expect(insertData).toContain(CONTROL_STATUS);
    expect(insertData).toContain(CONTROL_LIFECYCLE_KEY);

    expect((await publisher.getStatus(jobId))?.status).toBe('validated');
  });

  it('falls back to delete-then-insert on a store without update() and still persists correctly', async () => {
    const inner = new OxigraphStore();
    let jobGraphDeletes = 0;
    let updateCalls = 0;

    // Hide the update() capability so tryUpdateWithTouchedGraphs takes the
    // bounded pre-#1863 delete-then-insert fallback. Every other method still
    // delegates to the real store.
    const store = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'update') return undefined;
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

    // Correct final state via the fallback path.
    expect((await publisher.getStatus(jobId))?.status).toBe('validated');
    const lookup = await publisher.lookupKnowledgeAssetVmPublishJobByIntent(facts);
    expect(lookup.kind).toBe('active');
    // Fallback exercised: the job subject WAS delete-then-inserted, and the
    // atomic update() path was never taken.
    expect(jobGraphDeletes).toBeGreaterThan(0);
    expect(updateCalls).toBe(0);
  });

  it('takes the fallback on an update()-capable but NON-atomic store (atomicUpdateGroups !== true)', async () => {
    // The #1863 review 🔴: a store may expose update() yet apply DELETE WHERE;
    // INSERT DATA sequentially (e.g. SparqlHttpStore with atomicUpdates:false),
    // which would re-expose the transient window. The publisher must gate on the
    // declared group-atomicity capability, not on update() existence, and route
    // such a store to the delete-then-insert fallback.
    const inner = new OxigraphStore();
    let jobGraphDeletes = 0;
    let updateCalls = 0;

    const store = new Proxy(inner, {
      get(target, prop) {
        // update() EXISTS and works — but the store declares it is NOT atomic.
        if (prop === 'atomicUpdateGroups') return false;
        if (prop === 'update') {
          return async (sparql: string, options?: unknown) => {
            updateCalls++;
            return (target as unknown as {
              update: (s: string, o?: unknown) => Promise<void>;
            }).update(sparql, options);
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
    // The non-atomic update() path was NEVER taken; delete-then-insert was.
    expect(updateCalls).toBe(0);
    expect(jobGraphDeletes).toBeGreaterThan(0);
  });
});
