import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
} from '../src/index.js';
import type { LiftJob } from '../src/lift-job.js';
import {
  CONTROL_LIFECYCLE_KEY,
  DEFAULT_CONTROL_GRAPH_URI,
  jobSubject,
  knowledgeAssetVmPublishLifecycleKey,
  serializeJob,
} from '../src/async-lift-control-plane.js';
import { KA_VM_BROADCAST_TX, KA_VM_VALIDATION, kaVmPublishRequest } from './_helpers/ka-vm-publish.js';

// #1828 — durable-admission recovery: exact intent lookup keyed on the lifecycle
// facts a client retains, with a materialized index and deterministic
// none/active/superseded/conflict classification.
describe('#1828 async lift intent lookup', () => {
  let now = 1_000;
  let ids = 0;
  let store: OxigraphStore;

  beforeEach(() => {
    now = 1_000;
    ids = 0;
    store = new OxigraphStore();
  });

  function createPublisher(
    config: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator'> = {},
  ): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++now,
      idGenerator: () => `job-${++ids}`,
      ...config,
    });
  }

  // The facts a recovering client retains (never the jobId or intentKey).
  const facts = { contextGraphId: 'music-social', name: 'albums' };

  async function driveToFailed(request: ReturnType<typeof kaVmPublishRequest>): Promise<string> {
    const publisher = createPublisher({ recoveryLookupTimeoutMs: 10 });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobId, 'broadcast', { broadcast: KA_VM_BROADCAST_TX });
    now += 20;
    await publisher.recover();
    const job = await publisher.getStatus(jobId);
    expect(job?.status).toBe('failed');
    return jobId;
  }

  it('materializes only the lifecycleKey index triple on admission (Chunk 1)', async () => {
    const publisher = createPublisher();
    const request = kaVmPublishRequest();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    const lifecycle = await store.query(
      `SELECT ?lk WHERE { GRAPH <${DEFAULT_CONTROL_GRAPH_URI}> { <${jobSubject(jobId)}> <${CONTROL_LIFECYCLE_KEY}> ?lk } }`,
    );
    expect(lifecycle.type).toBe('bindings');
    if (lifecycle.type !== 'bindings') return;
    expect(lifecycle.bindings).toHaveLength(1);
    // No separate intentKey triple is materialized — exactness is payload-derived,
    // so the index carries only the lookup key (guards against re-adding the triple).
    const intent = await store.query(
      `SELECT ?ik WHERE { GRAPH <${DEFAULT_CONTROL_GRAPH_URI}> { <${jobSubject(jobId)}> <urn:dkg:publisher:intentKey> ?ik } }`,
    );
    expect(intent.type).toBe('bindings');
    if (intent.type !== 'bindings') return;
    expect(intent.bindings).toHaveLength(0);
  });

  // #1828 review (otReviewAgent + branarakic): components are joined with U+001F, so
  // a component carrying that delimiter would shift boundaries and collide two
  // distinct intents onto one lifecycle subject. The key builder is the single choke
  // point (admission dedup, index, lookup), so it fails closed there.
  it('rejects a lifecycle-key component that contains the U+001F delimiter', () => {
    expect(() =>
      knowledgeAssetVmPublishLifecycleKey({ contextGraphId: 'music-social', name: 'al' + String.fromCharCode(0x1f) + 'bums' }),
    ).toThrow(/U\+001F delimiter/);
    expect(() =>
      knowledgeAssetVmPublishLifecycleKey({ contextGraphId: 'music-social', name: 'albums' }),
    ).not.toThrow();
  });

  it('admission rejects a name carrying the U+001F delimiter (no silent collision)', async () => {
    const publisher = createPublisher();
    await expect(
      publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'al' + String.fromCharCode(0x1f) + 'bums' })),
    ).rejects.toThrow(/U\+001F delimiter/);
  });

  // #1828 review (otReviewAgent): the fail-closed key guard must reject bad INCOMING
  // requests without letting one malformed PERSISTED job (a legacy pre-guard
  // admission whose name carries U+001F) poison unrelated admissions or abort the
  // boot backfill.
  it('a legacy delimiter-bearing job does not poison an unrelated admission or the backfill', async () => {
    const publisher = createPublisher();
    const sep = String.fromCharCode(0x1f);

    // Persist a pre-guard legacy job directly (bypassing the now-guarded enqueue),
    // built from a real accepted job's shape so it is well-formed apart from the
    // delimiter. serializeJob leaves it un-indexed (the defensive index skip).
    const seedId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'seed' }));
    const seed = await publisher.getStatus(seedId);
    if (!seed || seed.request.jobType !== 'knowledge-asset-vm-publish') throw new Error('seed missing');
    const legacyBad: LiftJob = {
      ...seed,
      jobId: 'legacy-bad',
      request: {
        ...seed.request,
        knowledgeAssetVmPublish: { ...seed.request.knowledgeAssetVmPublish, name: `bad${sep}name` },
      },
    };
    await store.insert(serializeJob(legacyBad, DEFAULT_CONTROL_GRAPH_URI));

    // Unrelated valid admission still succeeds (the malformed legacy job is skipped
    // in the dedup scan, not thrown on).
    const okId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'albums' }));
    expect(typeof okId).toBe('string');

    // Boot backfill does not abort on the malformed job.
    const indexed = await publisher.ensureVmPublishIntentIndex();
    expect(indexed).toBeGreaterThanOrEqual(0);
  });

  // #1828 review (otReviewAgent): writeJob deletes the job subject BEFORE serializing
  // the replacement, so if the key guard threw inside serializeJob a legacy
  // delimiter-bearing job would be ERASED on its next transition (data loss). The
  // defensive index skip keeps serializeJob total, so writeJob's re-insert restores it.
  it('claiming a legacy delimiter-bearing job does not erase it (writeJob delete-then-insert)', async () => {
    const publisher = createPublisher();
    const sep = String.fromCharCode(0x1f);
    const seedId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'seed' }));
    const seed = await publisher.getStatus(seedId);
    if (!seed || seed.request.jobType !== 'knowledge-asset-vm-publish') throw new Error('seed missing');
    // Make the injected legacy job the only claimable one, then inject it directly.
    await publisher.cancel(seedId);
    const legacyBad: LiftJob = {
      ...seed,
      jobId: 'legacy-bad',
      request: {
        ...seed.request,
        knowledgeAssetVmPublish: { ...seed.request.knowledgeAssetVmPublish, name: `bad${sep}name` },
      },
    };
    await store.insert(serializeJob(legacyBad, DEFAULT_CONTROL_GRAPH_URI));

    // claimNext runs writeJob (delete subject, then serialize + insert) on it.
    const claimed = await publisher.claimNext('wallet-1');
    expect(claimed?.jobId).toBe('legacy-bad');
    // The record survived the delete-then-insert (not erased by a mid-serialize throw).
    expect(await publisher.getStatus('legacy-bad')).not.toBeNull();
  });

  it('recovers the live in-flight job from facts alone (AC1)', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const result = await publisher.lookupKnowledgeAssetVmPublishJobByIntent(facts);
    expect(result.kind).toBe('active');
    if (result.kind !== 'active') return;
    expect(result.job.jobId).toBe(jobId);
    expect(result.superseded).toEqual([]);
  });

  it('returns none for unknown facts (AC2)', async () => {
    const publisher = createPublisher();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const result = await publisher.lookupKnowledgeAssetVmPublishJobByIntent({
      contextGraphId: 'music-social',
      name: 'does-not-exist',
    });
    expect(result.kind).toBe('none');
  });

  it('reports exactIntentMatch only when the caller passes an intentKey (AC3)', async () => {
    const publisher = createPublisher();
    const request = kaVmPublishRequest();
    await publisher.enqueueKnowledgeAssetVmPublish(request);
    const noKey = await publisher.lookupKnowledgeAssetVmPublishJobByIntent(facts);
    expect(noKey.kind === 'active' && noKey.exactIntentMatch).toBeUndefined();
    const match = await publisher.lookupKnowledgeAssetVmPublishJobByIntent({ ...facts, intentKey: request.intentKey });
    expect(match.kind === 'active' && match.exactIntentMatch).toBe(true);
    const wrong = await publisher.lookupKnowledgeAssetVmPublishJobByIntent({ ...facts, intentKey: `sha256:${'ff'.repeat(32)}` });
    expect(wrong.kind === 'active' && wrong.exactIntentMatch).toBe(false);
  });

  it('finds the job after a restart and for terminal jobs (AC4)', async () => {
    const jobId = await driveToFailed(kaVmPublishRequest());
    // Fresh instance over the same durable store — models a daemon restart.
    const restarted = createPublisher();
    const result = await restarted.lookupKnowledgeAssetVmPublishJobByIntent(facts);
    expect(result.kind).toBe('superseded');
    if (result.kind !== 'superseded') return;
    expect(result.jobs.map((j) => j.jobId)).toEqual([jobId]);
  });

  it('returns the active job with terminal siblings as superseded', async () => {
    const request = kaVmPublishRequest();
    const failedId = await driveToFailed(request);
    // Add an active job under the same lifecycle subject (a real re-admission
    // scenario after a terminal failure). Built from the stored request wrapper.
    const failed = (await createPublisher().getStatus(failedId))!;
    const activeClone: LiftJob = {
      jobId: 'active-1',
      jobSlug: 'active-1',
      request: failed.request,
      status: 'accepted',
      timestamps: { acceptedAt: 5, updatedAt: 5 },
      retries: { retryCount: 0, maxRetries: 10 },
      controlPlane: { jobRef: jobSubject('active-1') },
    };
    await store.insert(serializeJob(activeClone, DEFAULT_CONTROL_GRAPH_URI));

    const result = await createPublisher().lookupKnowledgeAssetVmPublishJobByIntent(facts);
    expect(result.kind).toBe('active');
    if (result.kind !== 'active') return;
    expect(result.job.jobId).toBe('active-1');
    expect(result.superseded.map((j) => j.jobId)).toEqual([failedId]);
  });

  it('classifies a retryable failed job as active (admission still owns the subject)', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const accepted = (await publisher.getStatus(jobId))!;
    // A failed-but-retryable job (retries remaining) is exactly what admission's
    // findActive would reaccept, so recovery must surface it as the live job.
    const failureBase = {
      code: 'workspace_unavailable',
      phase: 'validation',
      mode: 'retryable',
      resolution: 'reset_to_accepted',
      message: 'transient store outage',
      errorPayloadRef: `urn:dkg:publisher:error:${jobId}`,
      failedFromState: 'validated',
    };
    const insertFailed = async (retryable: boolean, retryCount: number): Promise<void> => {
      await store.deleteByPattern({ subject: jobSubject(jobId), graph: DEFAULT_CONTROL_GRAPH_URI });
      const failed = {
        ...accepted,
        status: 'failed',
        failure: { ...failureBase, retryable },
        retries: { retryCount, maxRetries: 10 },
      } as unknown as LiftJob;
      await store.insert(serializeJob(failed, DEFAULT_CONTROL_GRAPH_URI));
    };

    await insertFailed(true, 0);
    const recoverable = await publisher.lookupKnowledgeAssetVmPublishJobByIntent(facts);
    expect(recoverable.kind).toBe('active');
    if (recoverable.kind === 'active') expect(recoverable.job.jobId).toBe(jobId);

    // Exhausted retries → genuinely superseded (admission would not reaccept it).
    await insertFailed(true, 10);
    expect((await publisher.lookupKnowledgeAssetVmPublishJobByIntent(facts)).kind).toBe('superseded');

    // Non-retryable failure → superseded even with retries nominally remaining.
    await insertFailed(false, 0);
    expect((await publisher.lookupKnowledgeAssetVmPublishJobByIntent(facts)).kind).toBe('superseded');
  });

  it('partitions the recovery identity by subGraphName (Chunk 1)', async () => {
    const publisher = createPublisher();
    const research = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ subGraphName: 'research' }));
    const production = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ subGraphName: 'production' }));

    const r = await publisher.lookupKnowledgeAssetVmPublishJobByIntent({ ...facts, subGraphName: 'research' });
    expect(r.kind).toBe('active');
    if (r.kind === 'active') expect(r.job.jobId).toBe(research);

    const p = await publisher.lookupKnowledgeAssetVmPublishJobByIntent({ ...facts, subGraphName: 'production' });
    expect(p.kind).toBe('active');
    if (p.kind === 'active') expect(p.job.jobId).toBe(production);

    // The no-subGraphName lane is a distinct lifecycle subject from both.
    expect((await publisher.lookupKnowledgeAssetVmPublishJobByIntent(facts)).kind).toBe('none');
  });

  it('classifies more than one active job as a conflict (broken invariant, AC2)', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const original = (await publisher.getStatus(jobId))!;
    const dup: LiftJob = { ...original, jobId: 'dup-1', jobSlug: 'dup-1', controlPlane: { jobRef: jobSubject('dup-1') } };
    await store.insert(serializeJob(dup, DEFAULT_CONTROL_GRAPH_URI));

    const result = await publisher.lookupKnowledgeAssetVmPublishJobByIntent(facts);
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') return;
    expect(result.jobs).toHaveLength(2);
  });

  it('is read-only: a lookup performs no enqueue/retry/repair (AC6)', async () => {
    const publisher = createPublisher();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const before = await publisher.getStats();
    await publisher.lookupKnowledgeAssetVmPublishJobByIntent({ ...facts, intentKey: `sha256:${'ab'.repeat(32)}` });
    const after = await publisher.getStats();
    expect(after).toEqual(before);
  });

  it('boot backfill inserts only missing index rows and reports the real count (Chunk 3)', async () => {
    const publisher = createPublisher();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    // Simulate a pre-index job by stripping the lifecycle index triple.
    await store.deleteByPattern({ predicate: CONTROL_LIFECYCLE_KEY, graph: DEFAULT_CONTROL_GRAPH_URI });
    expect((await publisher.lookupKnowledgeAssetVmPublishJobByIntent(facts)).kind).toBe('none');

    // First run repairs the one missing job and reports exactly it.
    expect(await publisher.ensureVmPublishIntentIndex()).toBe(1);
    expect((await publisher.lookupKnowledgeAssetVmPublishJobByIntent(facts)).kind).toBe('active');

    // Second run finds nothing missing → repairs 0 (not a full reindex) and does
    // not duplicate the index (still 'active', never 'conflict').
    expect(await publisher.ensureVmPublishIntentIndex()).toBe(0);
    expect((await publisher.lookupKnowledgeAssetVmPublishJobByIntent(facts)).kind).toBe('active');
  });

  it('is indexed: a lookup issues a single object-bound query, not a full scan (AC5)', async () => {
    const publisher = createPublisher();
    for (let i = 0; i < 200; i++) {
      await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: `album-${i}` }));
    }
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'target' }));

    let queryCount = 0;
    let lastSql = '';
    const origQuery = store.query.bind(store);
    (store as unknown as { query: (q: string) => unknown }).query = (q: string) => {
      queryCount += 1;
      lastSql = q;
      return origQuery(q);
    };
    const result = await publisher.lookupKnowledgeAssetVmPublishJobByIntent({ ...facts, name: 'target' });
    expect(result.kind).toBe('active');
    expect(queryCount).toBe(1);
    expect(lastSql).toContain(CONTROL_LIFECYCLE_KEY);
    expect(lastSql).not.toContain('?status');
  });
});
