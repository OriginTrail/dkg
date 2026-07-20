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
  serializeJob,
} from '../src/async-lift-control-plane.js';

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

  function kaVmPublishRequest(overrides: Record<string, unknown> = {}) {
    const authorAddress = '0x1111111111111111111111111111111111111111';
    const kaNumber = 7n;
    const kaUal = `did:dkg:31337/${authorAddress}/${kaNumber.toString()}`;
    return {
      contextGraphId: 'music-social',
      name: 'albums',
      shareOperationId: 'share-op-1',
      roots: [] as string[],
      contentScopeVersion: 2 as const,
      kaUal,
      assertionVersion: '1',
      publicTripleCount: 2,
      privateTripleCount: 0,
      seal: {
        merkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
        authorAddress: authorAddress as `0x${string}`,
        signature: { r: (`0x${'34'.repeat(32)}`) as `0x${string}`, vs: (`0x${'56'.repeat(32)}`) as `0x${string}` },
        schemeVersion: 1,
        reservedKaId: ((BigInt(authorAddress) << 96n) | kaNumber).toString() as `${bigint}`,
      },
      sealChainId: '31337' as `${bigint}`,
      sealKav10Address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
      sealMerkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
      intentKey: `sha256:${'ab'.repeat(32)}`,
      wmCurrentAssertion: '12'.repeat(32),
      swmCurrentAssertion: '12'.repeat(32),
      kaNumber: kaNumber.toString(),
      reservedUal: kaUal,
      ...overrides,
    };
  }

  // The facts a recovering client retains (never the jobId or intentKey).
  const facts = { contextGraphId: 'music-social', name: 'albums' };

  async function driveToFailed(request: ReturnType<typeof kaVmPublishRequest>): Promise<string> {
    const publisher = createPublisher({ recoveryLookupTimeoutMs: 10 });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: [],
        canonicalRootMap: {},
        swmQuadCount: 2,
        authorityProofRef: 'knowledge-asset-lifecycle',
        transitionType: 'CREATE',
      },
    });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: `0x${'ef'.repeat(32)}` as `0x${string}`, walletId: 'wallet-1' },
    });
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
