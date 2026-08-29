/**
 * Async Promote Queue — unit tests.
 *
 * Pin every behaviour the RFC (`docs/specs/SPEC_ASYNC_PROMOTE_QUEUE.md`)
 * and the implementation plan (`docs/specs/SPEC_ASYNC_PROMOTE_QUEUE_IMPLEMENTATION_PLAN.md`)
 * declare. Each `it` names the RFC section / behaviour it pins so reviewers
 * can map test → spec.
 *
 * The tests use the in-memory `OxigraphStore` (no daemon, no HTTP) so
 * each `beforeEach` resets state in O(ms). Time is injected via the
 * queue config — no `vi.useFakeTimers()` because the queue's internal
 * comparisons are pure.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  DEFAULT_PROMOTE_CONTROL_GRAPH_URI,
  PROMOTE_PAYLOAD,
  PROMOTE_STATE,
  PROMOTE_UNIQUENESS_KEY,
  jobSubject,
  legacyUniquenessKey,
  literal,
  serializeJob,
  uniquenessKey,
} from '../src/async-promote-queue-utils.js';
import {
  ASYNC_PROMOTE_QUEUE_FORMAT_VERSION,
  PROMOTE_JOB_STATES,
  PromoteJobConflictError,
  PromoteJobLeaseError,
  type AsyncPromoteQueue,
  type AsyncPromoteQueueConfig,
  type PromoteJob,
  type PromoteRequest,
} from '../src/async-promote-queue-types.js';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';

describe('TripleStoreAsyncPromoteQueue', () => {
  let store: OxigraphStore;
  let now: number;
  let idCounter: number;

  beforeEach(() => {
    store = new OxigraphStore();
    now = 1_000_000;
    idCounter = 0;
  });

  function createQueue(overrides: Partial<AsyncPromoteQueueConfig> = {}): AsyncPromoteQueue {
    return new TripleStoreAsyncPromoteQueue(store, {
      now: () => now,
      idGenerator: () => `job-${++idCounter}`,
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

  function advance(ms: number): void {
    now += ms;
  }

  /**
   * Wrap an OxigraphStore so the first `flush()` after `arm()` parks until
   * `releaseFlush()` is called. Used by the read/write race tests (5a–5c) to
   * hold the claim flush open mid-mutation and prove the observability reads
   * (`getStatus`/`list`/`getStats`) share the queue's mutation lock rather than
   * exposing a transitional `running` row before the flush completes.
   */
  function makeFlushBlockingStore(base: OxigraphStore): {
    store: TripleStore;
    arm: () => void;
    flushStarted: Promise<void>;
    releaseFlush: () => void;
  } {
    let blockNextFlush = false;
    let flushStartedResolve!: () => void;
    let releaseFlushResolve!: () => void;
    const flushStarted = new Promise<void>((resolve) => {
      flushStartedResolve = resolve;
    });
    const flushRelease = new Promise<void>((resolve) => {
      releaseFlushResolve = resolve;
    });
    const store: TripleStore = {
      createGraph: (graphUri) => base.createGraph(graphUri),
      dropGraph: (graphUri) => base.dropGraph(graphUri),
      insert: (quads) => base.insert(quads),
      delete: (quads) => base.delete(quads),
      deleteByPattern: (pattern) => base.deleteByPattern(pattern),
      query: (sparql, options) => base.query(sparql, options),
      hasGraph: (graphUri, options) => base.hasGraph(graphUri, options),
      listGraphs: (options) => base.listGraphs(options),
      deleteBySubjectPrefix: (graphUri, prefix) => base.deleteBySubjectPrefix(graphUri, prefix),
      countQuads: (graphUri) => base.countQuads(graphUri),
      close: () => base.close(),
      flush: async () => {
        if (blockNextFlush) {
          flushStartedResolve();
          await flushRelease;
          blockNextFlush = false;
        }
        await base.flush?.();
      },
    };
    return {
      store,
      arm: () => {
        blockNextFlush = true;
      },
      flushStarted,
      releaseFlush: () => releaseFlushResolve(),
    };
  }

  async function rewriteStoredUniquenessKey(jobId: string, key: string): Promise<void> {
    await store.deleteByPattern({
      subject: jobSubject(jobId),
      predicate: PROMOTE_UNIQUENESS_KEY,
      graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI,
    });
    await store.insert([{
      subject: jobSubject(jobId),
      predicate: PROMOTE_UNIQUENESS_KEY,
      object: literal(key),
      graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI,
    }]);
    await store.flush?.();
  }

  async function rewriteStoredJob(job: PromoteJob): Promise<void> {
    await (createQueue() as unknown as { writeJob(job: PromoteJob): Promise<void> }).writeJob(job);
  }

  async function insertRawStoredJob(job: PromoteJob, key: string): Promise<void> {
    await store.insert(serializeJob(job, DEFAULT_PROMOTE_CONTROL_GRAPH_URI));
    await rewriteStoredUniquenessKey(job.jobId, key);
  }

  // ---------------------------------------------------------------------------
  // §3.1 enqueue
  // ---------------------------------------------------------------------------

  it('1. enqueue() returns a fresh jobId and persists the job in `queued` state', async () => {
    const queue = createQueue();
    const jobId = await queue.enqueue(makeRequest());

    expect(jobId).toBe('job-1');
    const job = await queue.getStatus(jobId);
    expect(job).not.toBeNull();
    expect(job!.state).toBe('queued');
    expect(job!.enqueuedAt).toBe(now);
    expect(job!.attempt.count).toBe(0);
    expect(job!.attempt.maxRetries).toBeGreaterThan(0);
    expect(job!.lease).toBeUndefined();
    expect(job!.commitMarker).toBeUndefined();
    expect(job!.request).toEqual(makeRequest());
  });

  it('1b. queue mutations flush the store so crash recovery sees the latest lease state', async () => {
    let flushes = 0;
    const originalFlush = store.flush.bind(store);
    store.flush = async () => {
      flushes += 1;
      await originalFlush();
    };

    const queue = createQueue();
    const jobId = await queue.enqueue(makeRequest());
    expect(flushes).toBe(1);

    const claimed = await queue.claimNext('worker-1');
    expect(claimed?.jobId).toBe(jobId);
    expect(claimed?.state).toBe('running');
    expect(flushes).toBe(2);

    await queue.recordCommitMarker(jobId, claimed!.lease!.claimToken, 'promoteStarted');
    expect(flushes).toBe(3);
  });

  it('2. enqueue() rejects an empty assertionName as a fatal validation error', async () => {
    const queue = createQueue();
    await expect(queue.enqueue(makeRequest({ assertionName: '' }))).rejects.toThrow(/assertionName/);
    await expect(queue.enqueue(makeRequest({ contextGraphId: '' }))).rejects.toThrow(/contextGraphId/);
    await expect(queue.enqueue(makeRequest({ entities: [] }))).rejects.toThrow(/entities array must not be empty/);
    await expect(queue.enqueue(makeRequest({ agentAddress: '   ' }))).rejects.toThrow(/agentAddress must be a non-empty string/);
  });

  it('3. enqueue() rejects with PromoteJobConflictError when (cgId, subGraphName, assertionName) has an active job', async () => {
    const queue = createQueue();
    const first = await queue.enqueue(makeRequest());

    await expect(queue.enqueue(makeRequest())).rejects.toMatchObject({
      name: 'PromoteJobConflictError',
      existingJobId: first,
    });

    // Same assertion but different subGraphName → allowed.
    const second = await queue.enqueue(makeRequest({ subGraphName: 'meta' }));
    expect(second).toBe('job-2');
    // Same assertion in different CG → allowed.
    const third = await queue.enqueue(makeRequest({ contextGraphId: 'other-cg' }));
    expect(third).toBe('job-3');
  });

  it('3c. enqueue() treats agentAddress as part of the active assertion identity', async () => {
    const queue = createQueue();
    const agentA = `0x${'aa'.repeat(20)}`;
    const agentAUpper = `0x${'AA'.repeat(20)}`;
    const agentB = `0x${'bb'.repeat(20)}`;

    const first = await queue.enqueue(makeRequest({ agentAddress: `  ${agentAUpper}  ` }));
    expect((await queue.getStatus(first))?.request.agentAddress).toBe(agentAUpper);

    // Same cg/subgraph/name, different storage lane -> independent work.
    const second = await queue.enqueue(makeRequest({ agentAddress: agentB }));
    expect(second).toBe('job-2');
    expect((await queue.getStatus(second))?.request.agentAddress).toBe(agentB);

    // Same lane with different address casing -> same active resource.
    await expect(queue.enqueue(makeRequest({ agentAddress: agentA }))).rejects.toMatchObject({
      name: 'PromoteJobConflictError',
      existingJobId: first,
      key: { agentAddress: agentA },
    });

    // Default daemon lane is also independent from explicit agent lanes.
    const third = await queue.enqueue(makeRequest());
    expect(third).toBe('job-3');

    const peerLane = '12D3KooWCaseSensitiveLane';
    const peerLaneJob = await queue.enqueue(makeRequest({
      assertionName: 'peer-lane',
      agentAddress: ` ${peerLane} `,
    }));
    expect((await queue.getStatus(peerLaneJob))?.request.agentAddress).toBe(peerLane);

    await expect(queue.enqueue(makeRequest({
      assertionName: 'peer-lane',
      agentAddress: peerLane,
    }))).rejects.toMatchObject({
      name: 'PromoteJobConflictError',
      existingJobId: peerLaneJob,
      key: { agentAddress: peerLane },
    });

    const peerLaneCaseVariant = await queue.enqueue(makeRequest({
      assertionName: 'peer-lane',
      agentAddress: peerLane.toLowerCase(),
    }));
    expect(peerLaneCaseVariant).toBe('job-5');
  });

  it('3e. enqueue() still detects active rows stored with the pre-canonical lowercased lane key', async () => {
    const queue = createQueue();
    const peerLane = '12D3KooWCaseSensitiveLane';
    const request = makeRequest({ assertionName: 'old-peer-lane', agentAddress: peerLane });
    const oldLowercaseKey = `${legacyUniquenessKey(request)}\u001f${peerLane.toLowerCase()}`;

    await insertRawStoredJob({
      jobId: 'old-key-peer-lane',
      request,
      state: 'queued',
      enqueuedAt: now,
      updatedAt: now,
      attempt: { count: 0, maxRetries: 5 },
      formatVersion: ASYNC_PROMOTE_QUEUE_FORMAT_VERSION,
    }, oldLowercaseKey);

    await expect(queue.enqueue(request)).rejects.toMatchObject({
      name: 'PromoteJobConflictError',
      existingJobId: 'old-key-peer-lane',
      key: { agentAddress: peerLane },
    });
  });

  it('3f. enqueue() snapshots caller-owned requests before async conflict checks and persistence', async () => {
    const queue = createQueue();
    const agentUpper = `0x${'AA'.repeat(20)}`;
    const mutatedAgent = `0x${'bb'.repeat(20)}`;
    const entities = ['urn:entity:original'];
    const request = makeRequest({
      assertionName: 'mutable-enqueue-input',
      agentAddress: agentUpper,
      entities,
    });

    const enqueueing = queue.enqueue(request);
    request.agentAddress = mutatedAgent;
    entities.push('urn:entity:mutated');
    const jobId = await enqueueing;

    const job = await queue.getStatus(jobId);
    expect(job?.request.agentAddress).toBe(agentUpper);
    expect(job?.request.entities).toEqual(['urn:entity:original']);

    await expect(queue.enqueue(makeRequest({
      assertionName: 'mutable-enqueue-input',
      agentAddress: agentUpper,
      entities: ['urn:entity:replacement'],
    }))).rejects.toMatchObject({
      name: 'PromoteJobConflictError',
      existingJobId: jobId,
    });

    const independent = await queue.enqueue(makeRequest({
      assertionName: 'mutable-enqueue-input',
      agentAddress: mutatedAgent,
      entities: ['urn:entity:mutated-lane'],
    }));
    expect(independent).toBe('job-2');
  });

  it('3d. enqueue() treats legacy no-agent active jobs as conflicting with explicit upgraded lanes', async () => {
    const queue = createQueue();
    const legacyRequest = makeRequest();
    const legacyJobId = await queue.enqueue(legacyRequest);
    await rewriteStoredJob({
      ...(await queue.getStatus(legacyJobId))!,
      formatVersion: undefined,
    });
    await rewriteStoredUniquenessKey(legacyJobId, legacyUniquenessKey(legacyRequest));

    await expect(queue.enqueue(makeRequest({ agentAddress: `0x${'aa'.repeat(20)}` }))).rejects.toMatchObject({
      name: 'PromoteJobConflictError',
      existingJobId: legacyJobId,
    });
  });

  it('3b. enqueue() serialises concurrent uniqueness checks for the same assertion', async () => {
    const queue = createQueue();
    const attempts = await Promise.allSettled([
      queue.enqueue(makeRequest()),
      queue.enqueue(makeRequest()),
    ]);

    const fulfilled = attempts.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled');
    const rejected = attempts.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.reason).toBeInstanceOf(PromoteJobConflictError);
    expect((await queue.list()).filter((j) => uniquenessKey(j.request) === uniquenessKey(makeRequest()))).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // §3.2 getStatus
  // ---------------------------------------------------------------------------

  it('4. getStatus() returns null for an unknown jobId', async () => {
    const queue = createQueue();
    expect(await queue.getStatus('non-existent')).toBeNull();
  });

  it('5. getStatus() returns the full PromoteJob including attempt count and lease (when running)', async () => {
    const queue = createQueue();
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    expect(claimed?.jobId).toBe(jobId);
    expect(claimed?.state).toBe('running');
    expect(claimed?.lease?.workerId).toBe('worker-1');
    expect(claimed?.attempt.count).toBe(1);

    const fetched = await queue.getStatus(jobId);
    expect(fetched).toEqual(claimed);
  });

  it('5a. getStatus() waits for an in-flight claim flush before exposing the running row', async () => {
    const base = new OxigraphStore();
    let blockNextFlush = false;
    let flushStartedResolve!: () => void;
    let releaseFlush!: () => void;
    const flushStarted = new Promise<void>((resolve) => {
      flushStartedResolve = resolve;
    });
    const flushRelease = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const blockingStore: TripleStore = {
      createGraph: (graphUri) => base.createGraph(graphUri),
      dropGraph: (graphUri) => base.dropGraph(graphUri),
      insert: (quads) => base.insert(quads),
      delete: (quads) => base.delete(quads),
      deleteByPattern: (pattern) => base.deleteByPattern(pattern),
      query: (sparql, options) => base.query(sparql, options),
      hasGraph: (graphUri, options) => base.hasGraph(graphUri, options),
      listGraphs: (options) => base.listGraphs(options),
      deleteBySubjectPrefix: (graphUri, prefix) => base.deleteBySubjectPrefix(graphUri, prefix),
      countQuads: (graphUri) => base.countQuads(graphUri),
      close: () => base.close(),
      flush: async () => {
        if (blockNextFlush) {
          flushStartedResolve();
          await flushRelease;
          blockNextFlush = false;
        }
        await base.flush?.();
      },
    };
    const queue = new TripleStoreAsyncPromoteQueue(blockingStore, {
      now: () => now,
      idGenerator: () => `job-${++idCounter}`,
    });

    const jobId = await queue.enqueue(makeRequest());
    blockNextFlush = true;
    const claimPromise = queue.claimNext('worker-1');
    await flushStarted;

    let statusSettled = false;
    const statusPromise = queue.getStatus(jobId).finally(() => {
      statusSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(statusSettled).toBe(false);

    releaseFlush();
    const [claimed, fetched] = await Promise.all([claimPromise, statusPromise]);
    expect(claimed?.state).toBe('running');
    expect(fetched?.state).toBe('running');
    expect(fetched?.attempt.count).toBe(1);
  });

  it('5b. list({ state: ["running"] }) waits for an in-flight claim flush before exposing the running row', async () => {
    const base = new OxigraphStore();
    const { store: blockingStore, arm, flushStarted, releaseFlush } = makeFlushBlockingStore(base);
    const queue = new TripleStoreAsyncPromoteQueue(blockingStore, {
      now: () => now,
      idGenerator: () => `job-${++idCounter}`,
    });

    await queue.enqueue(makeRequest());
    arm();
    const claimPromise = queue.claimNext('worker-1');
    await flushStarted;

    let listSettled = false;
    const listPromise = queue.list({ state: ['running'] }).finally(() => {
      listSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listSettled).toBe(false);

    releaseFlush();
    const [claimed, running] = await Promise.all([claimPromise, listPromise]);
    expect(claimed?.state).toBe('running');
    expect(running).toHaveLength(1);
    expect(running[0]?.state).toBe('running');
  });

  it('5c. getStats() waits for an in-flight claim flush before counting the running row', async () => {
    const base = new OxigraphStore();
    const { store: blockingStore, arm, flushStarted, releaseFlush } = makeFlushBlockingStore(base);
    const queue = new TripleStoreAsyncPromoteQueue(blockingStore, {
      now: () => now,
      idGenerator: () => `job-${++idCounter}`,
    });

    await queue.enqueue(makeRequest());
    arm();
    const claimPromise = queue.claimNext('worker-1');
    await flushStarted;

    let statsSettled = false;
    const statsPromise = queue.getStats().finally(() => {
      statsSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(statsSettled).toBe(false);

    releaseFlush();
    const [claimed, stats] = await Promise.all([claimPromise, statsPromise]);
    expect(claimed?.state).toBe('running');
    expect(stats.running).toBe(1);
    expect(stats.queued).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // §3.3 list
  // ---------------------------------------------------------------------------

  it('6. list({state: ["queued"]}) returns only queued jobs', async () => {
    const queue = createQueue();
    const a = await queue.enqueue(makeRequest({ assertionName: 'a' }));
    const b = await queue.enqueue(makeRequest({ assertionName: 'b' }));
    await queue.enqueue(makeRequest({ assertionName: 'c' }));

    const claimedB = await queue.claimNext('worker-x');
    expect(claimedB?.jobId).toBe(a); // FIFO — `a` enqueued first.
    advance(1);
    const claimedC = await queue.claimNext('worker-y');
    expect(claimedC?.jobId).toBe(b);

    const queued = await queue.list({ state: ['queued'] });
    expect(queued.map((j) => j.request.assertionName)).toEqual(['c']);

    const running = await queue.list({ state: ['running'] });
    expect(running.map((j) => j.jobId).sort()).toEqual([a, b].sort());
  });

  it('7. list({contextGraphId}) scopes correctly', async () => {
    const queue = createQueue();
    await queue.enqueue(makeRequest({ contextGraphId: 'cg-1', assertionName: 'a' }));
    await queue.enqueue(makeRequest({ contextGraphId: 'cg-2', assertionName: 'b' }));
    await queue.enqueue(makeRequest({ contextGraphId: 'cg-1', assertionName: 'c' }));

    const cg1 = await queue.list({ contextGraphId: 'cg-1' });
    expect(cg1.map((j) => j.request.assertionName).sort()).toEqual(['a', 'c']);
    expect(cg1.every((j) => j.request.contextGraphId === 'cg-1')).toBe(true);
  });

  it('7b. list({limit}) slices after deterministic queue ordering', async () => {
    const queue = createQueue();
    await queue.enqueue(makeRequest({ assertionName: 'oldest' }));
    advance(10);
    await queue.enqueue(makeRequest({ assertionName: 'middle' }));
    advance(10);
    await queue.enqueue(makeRequest({ assertionName: 'newest' }));

    const limited = await queue.list({ limit: 2 });
    expect(limited.map((j) => j.request.assertionName)).toEqual(['oldest', 'middle']);
  });

  // ---------------------------------------------------------------------------
  // §3.4 cancel / recover
  // ---------------------------------------------------------------------------

  it('8. cancel() on `queued` job moves to `failed` with reason="cancelled"', async () => {
    const queue = createQueue();
    const jobId = await queue.enqueue(makeRequest());
    await queue.cancel(jobId);

    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('failed');
    expect(job?.reason).toBe('cancelled');
    expect(job?.lease).toBeUndefined();
  });

  it('9. cancel() on `running` job rejects (worker is mutating it)', async () => {
    const queue = createQueue();
    const jobId = await queue.enqueue(makeRequest());
    await queue.claimNext('worker-1');

    await expect(queue.cancel(jobId)).rejects.toThrow(/running/);
  });

  it('9b. cancel() on `failed_retrying` rejects so transient failures keep their retry budget', async () => {
    const queue = createQueue({ backoff: () => 1_000 });
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    await queue.fail(jobId, claimed!.lease!.claimToken, {
      message: 'transient blip',
      retryable: true,
      classification: 'transient',
      recordedAt: now,
    });

    await expect(queue.cancel(jobId)).rejects.toThrow(/failed_retrying/);
    expect((await queue.getStatus(jobId))?.state).toBe('failed_retrying');
  });

  // ---------------------------------------------------------------------------
  // §4.3 claimNext / lease
  // ---------------------------------------------------------------------------

  it('10. claimNext() picks the oldest queued job and sets state=running with a lease', async () => {
    const queue = createQueue({ leaseMs: 60_000 });
    const first = await queue.enqueue(makeRequest({ assertionName: 'a' }));
    advance(10);
    await queue.enqueue(makeRequest({ assertionName: 'b' }));

    const claimed = await queue.claimNext('worker-1');
    expect(claimed?.jobId).toBe(first);
    expect(claimed?.state).toBe('running');
    expect(claimed?.attempt.count).toBe(1);
    expect(claimed?.lease).toBeDefined();
    expect(claimed?.lease?.workerId).toBe('worker-1');
    expect(claimed?.lease?.expiresAt).toBe(now + 60_000);
    expect(claimed?.lease?.claimToken).toMatch(/^worker-1:/);
  });

  it('10a. default lease remains active past the recovery budget and expires after 15 minutes', async () => {
    const queue = createQueue();
    const jobId = await queue.enqueue(makeRequest());
    const firstClaim = await queue.claimNext('worker-1');

    expect(firstClaim?.jobId).toBe(jobId);
    const firstClaimToken = firstClaim!.lease!.claimToken;

    advance(11 * 60 * 1000);
    await expect(queue.claimNext('worker-2')).resolves.toBeNull();
    const stillRunning = await queue.getStatus(jobId);
    expect(stillRunning?.state).toBe('running');
    expect(stillRunning?.lease?.claimToken).toBe(firstClaimToken);

    advance((4 * 60 * 1000) + 1);
    const reclaimed = await queue.claimNext('worker-2');
    expect(reclaimed?.jobId).toBe(jobId);
    expect(reclaimed?.state).toBe('running');
    expect(reclaimed?.lease?.workerId).toBe('worker-2');
    expect(reclaimed?.lease?.claimToken).not.toBe(firstClaimToken);
  });

  it('11. claimNext() returns null when paused; resume() restores', async () => {
    const queue = createQueue();
    await queue.enqueue(makeRequest());
    await queue.pause();
    expect(await queue.claimNext('worker-1')).toBeNull();

    await queue.resume();
    const claimed = await queue.claimNext('worker-1');
    expect(claimed).not.toBeNull();
    expect(claimed!.state).toBe('running');
  });

  it('12. claimNext() returns null when there are no eligible queued jobs', async () => {
    const queue = createQueue();
    expect(await queue.claimNext('worker-1')).toBeNull();

    // Job that's still in backoff is not eligible.
    const jobId = await queue.enqueue(makeRequest());
    const claim1 = await queue.claimNext('worker-1');
    await queue.fail(jobId, claim1!.lease!.claimToken, {
      message: 'transient',
      retryable: true,
      classification: 'transient',
      recordedAt: now,
    });
    expect(await queue.claimNext('worker-1')).toBeNull(); // still backing off
  });

  it('labels each claimNext store read with its caller-provided operation class', async () => {
    const sources: Array<string | undefined> = [];
    const recordingStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return (
            sparql: Parameters<TripleStore['query']>[0],
            options?: Parameters<TripleStore['query']>[1],
          ) => {
            sources.push(options?.source);
            return target.query(sparql, options);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;
    const queue = new TripleStoreAsyncPromoteQueue(recordingStore, {
      now: () => now,
      idGenerator: () => `job-${++idCounter}`,
    });

    await expect(queue.claimNext('worker-1')).resolves.toBeNull();
    expect(sources).toEqual([
      'publisher.asyncPromote.recoverExpired',
      'publisher.asyncPromote.claimNext.candidates',
    ]);
  });

  it('signals in-process workers only after enqueue and recovery commit', async () => {
    const queue = createQueue();
    const notifications: string[] = [];
    const unsubscribe = queue.subscribeWorkAvailable?.(() => notifications.push('wake'));

    const jobId = await queue.enqueue(makeRequest());
    expect(notifications).toEqual(['wake']);

    const claimed = await queue.claimNext('worker-1');
    await queue.fail(jobId, claimed!.lease!.claimToken, {
      message: 'fatal',
      retryable: false,
      classification: 'fatal',
      recordedAt: now,
    });
    expect(notifications).toEqual(['wake']);

    await queue.recover(jobId);
    expect(notifications).toEqual(['wake', 'wake']);

    unsubscribe?.();
    await queue.enqueue(makeRequest({ assertionName: 'after-unsubscribe' }));
    expect(notifications).toEqual(['wake', 'wake']);
  });

  it('13. claimNext() does NOT pick a second job for the same (cgId, subGraphName, assertionName) while one is running', async () => {
    const queue = createQueue();
    const reqA = makeRequest();
    await queue.enqueue(reqA);
    const claimed = await queue.claimNext('worker-1');
    expect(claimed).not.toBeNull();

    // Same uniqueness key can't even enqueue while the first is running.
    await expect(queue.enqueue(reqA)).rejects.toBeInstanceOf(PromoteJobConflictError);
    expect(await queue.claimNext('worker-2')).toBeNull();

    // But a different uniqueness key CAN be claimed concurrently.
    const otherId = await queue.enqueue(makeRequest({ assertionName: 'other' }));
    const claimedOther = await queue.claimNext('worker-2');
    expect(claimedOther?.jobId).toBe(otherId);
  });

  it('13b. claimNext() can claim the same assertion concurrently in different agent lanes', async () => {
    const queue = createQueue();
    const agentA = `0x${'aa'.repeat(20)}`;
    const agentB = `0x${'bb'.repeat(20)}`;
    const jobA = await queue.enqueue(makeRequest({ agentAddress: agentA }));
    const jobB = await queue.enqueue(makeRequest({ agentAddress: agentB }));

    const claimedA = await queue.claimNext('worker-1');
    expect(claimedA?.jobId).toBe(jobA);
    expect(claimedA?.request.agentAddress).toBe(agentA);

    await expect(queue.enqueue(makeRequest({ agentAddress: agentA }))).rejects.toBeInstanceOf(PromoteJobConflictError);

    const claimedB = await queue.claimNext('worker-2');
    expect(claimedB?.jobId).toBe(jobB);
    expect(claimedB?.request.agentAddress).toBe(agentB);
  });

  it('13e. claimNext() preserves the worker-facing storage lane from old queued payloads', async () => {
    const queue = createQueue();
    const agentUpper = `0x${'AA'.repeat(20)}`;
    await insertRawStoredJob({
      jobId: 'old-mixed-case-lane',
      request: makeRequest({ agentAddress: agentUpper }),
      state: 'queued',
      enqueuedAt: now,
      updatedAt: now,
      attempt: { count: 0, maxRetries: 5 },
      formatVersion: ASYNC_PROMOTE_QUEUE_FORMAT_VERSION,
    }, uniquenessKey(makeRequest({ agentAddress: agentUpper })));

    const claimed = await queue.claimNext('worker-1');

    expect(claimed?.jobId).toBe('old-mixed-case-lane');
    expect(claimed?.request.agentAddress).toBe(agentUpper);
    expect((await queue.getStatus('old-mixed-case-lane'))?.request.agentAddress).toBe(agentUpper);
  });

  it('13f. claimNext() parks pre-v3 author-only rows that have no storage lane', async () => {
    const queue = createQueue();
    const legacyAuthorOnly: PromoteJob = {
      jobId: 'queued-v2-author-only',
      request: makeRequest({ authorAgentAddress: `0x${'aa'.repeat(20)}` }),
      state: 'queued',
      enqueuedAt: now,
      updatedAt: now,
      attempt: { count: 0, maxRetries: 5 },
      formatVersion: 2,
    };
    await insertRawStoredJob(legacyAuthorOnly, `${legacyUniquenessKey(legacyAuthorOnly.request)}\u001f`);

    const claimed = await queue.claimNext('worker-1');

    expect(claimed).toBeNull();
    const parked = await queue.getStatus('queued-v2-author-only');
    expect(parked?.state).toBe('failed');
    expect(parked?.reason).toMatch(/missing storage lane/i);
    expect(parked?.attempt.lastError?.message).toMatch(/cannot prove the WM storage lane/);
  });

  it('13c. claimNext() does not claim an explicit lane while a legacy no-agent job is running', async () => {
    const queue = createQueue();
    const legacyRequest = makeRequest();
    const legacyJobId = await queue.enqueue(legacyRequest);
    await rewriteStoredUniquenessKey(legacyJobId, legacyUniquenessKey(legacyRequest));
    const legacyClaim = await queue.claimNext('worker-1');
    expect(legacyClaim?.jobId).toBe(legacyJobId);
    await rewriteStoredJob({
      ...legacyClaim!,
      formatVersion: undefined,
    });

    await store.insert(
      serializeJob(
        {
          jobId: 'explicit-after-upgrade',
          request: makeRequest({ agentAddress: `0x${'aa'.repeat(20)}` }),
          state: 'queued',
          enqueuedAt: now + 1,
          updatedAt: now + 1,
          attempt: { count: 0, maxRetries: 5 },
          formatVersion: ASYNC_PROMOTE_QUEUE_FORMAT_VERSION,
        },
        DEFAULT_PROMOTE_CONTROL_GRAPH_URI,
      ),
    );

    expect(await queue.claimNext('worker-2')).toBeNull();
  });

  it('13f. enqueue() treats rewritten legacy no-agent rows as wildcard conflicts', async () => {
    const queue = createQueue();
    const legacyRequest = makeRequest();
    const legacyJobId = await queue.enqueue(legacyRequest);
    await rewriteStoredJob({
      ...(await queue.getStatus(legacyJobId))!,
      formatVersion: 2,
    });
    await rewriteStoredUniquenessKey(legacyJobId, legacyUniquenessKey(legacyRequest));

    const claimed = await queue.claimNext('worker-legacy');
    expect(claimed?.jobId).toBe(legacyJobId);
    expect(claimed?.formatVersion).toBe(2);
    expect((await queue.getStatus(legacyJobId))?.request.agentAddress).toBeUndefined();
    await rewriteStoredUniquenessKey(legacyJobId, `${legacyUniquenessKey(legacyRequest)}\u001f`);

    await expect(queue.enqueue(makeRequest({ agentAddress: `0x${'aa'.repeat(20)}` }))).rejects.toMatchObject({
      name: 'PromoteJobConflictError',
      existingJobId: legacyJobId,
    });
  });

  it('13d. claimNext() can claim a current default-lane job and explicit agent-lane job concurrently', async () => {
    const queue = createQueue();
    const agentA = `0x${'aa'.repeat(20)}`;
    const defaultJob = await queue.enqueue(makeRequest());
    const agentJob = await queue.enqueue(makeRequest({ agentAddress: agentA }));

    const claimedDefault = await queue.claimNext('worker-default');
    expect(claimedDefault?.jobId).toBe(defaultJob);
    expect(claimedDefault?.request.agentAddress).toBeUndefined();

    const claimedAgent = await queue.claimNext('worker-agent');
    expect(claimedAgent?.jobId).toBe(agentJob);
    expect(claimedAgent?.request.agentAddress).toBe(agentA);
  });

  it('14. heartbeat() extends the lease without changing state', async () => {
    const queue = createQueue({ leaseMs: 60_000 });
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    const originalExpiry = claimed!.lease!.expiresAt;

    advance(30_000);
    await queue.heartbeat(jobId, claimed!.lease!.claimToken);

    const refreshed = await queue.getStatus(jobId);
    expect(refreshed?.state).toBe('running');
    expect(refreshed?.lease?.expiresAt).toBeGreaterThan(originalExpiry);
    expect(refreshed?.lease?.expiresAt).toBe(now + 60_000);
    expect(refreshed?.lease?.lastHeartbeatAt).toBe(now);
  });

  it('15. heartbeat() rejects when called by a worker that doesn\'t hold the lease', async () => {
    const queue = createQueue();
    const jobId = await queue.enqueue(makeRequest());
    await queue.claimNext('worker-1');

    await expect(queue.heartbeat(jobId, 'wrong-token')).rejects.toBeInstanceOf(PromoteJobLeaseError);
  });

  // ---------------------------------------------------------------------------
  // §3.2 succeed / fail
  // ---------------------------------------------------------------------------

  it('16. succeed() moves running → succeeded; records promotedCount', async () => {
    const queue = createQueue();
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    const token = claimed!.lease!.claimToken;

    // Worker records the commit progressing — required before succeed.
    await queue.recordCommitMarker(jobId, token, 'swmInserted');
    await queue.recordCommitMarker(jobId, token, 'wmCleaned');
    await queue.recordCommitMarker(jobId, token, 'lifecycleStamped');
    await queue.recordCommitMarker(jobId, token, 'gossiped');

    await queue.succeed(jobId, token, {
      promotedCount: 42,
      succeededAt: now,
      gossipMessageSize: 1024,
    });

    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('succeeded');
    expect(job?.result?.promotedCount).toBe(42);
    expect(job?.result?.gossipMessageSize).toBe(1024);
    expect(job?.lease).toBeUndefined();
  });

  it('17. succeed() rejects if the job\'s commitMarker.swmInserted is false', async () => {
    const queue = createQueue();
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');

    await expect(
      queue.succeed(jobId, claimed!.lease!.claimToken, { promotedCount: 1, succeededAt: now }),
    ).rejects.toThrow(/commitMarker.*swmInserted/);
  });

  it('18. fail() with retryable=true moves running → failed_retrying with nextRetryAt = now + backoff(attempt)', async () => {
    const queue = createQueue({ backoff: (n) => 1000 * n });
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');

    await queue.fail(jobId, claimed!.lease!.claimToken, {
      message: 'transient blip',
      retryable: true,
      classification: 'transient',
      recordedAt: now,
    });

    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('failed_retrying');
    expect(job?.attempt.count).toBe(1);
    expect(job?.attempt.nextRetryAt).toBe(now + 1000);
    expect(job?.attempt.lastError?.message).toBe('transient blip');
    expect(job?.lease).toBeUndefined();
  });

  it('19. fail() with retryable=false moves running → failed (terminal)', async () => {
    const queue = createQueue();
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');

    await queue.fail(jobId, claimed!.lease!.claimToken, {
      message: 'validation failed',
      retryable: false,
      classification: 'fatal',
      recordedAt: now,
    });

    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('failed');
    expect(job?.attempt.lastError?.classification).toBe('fatal');
    expect(job?.lease).toBeUndefined();
  });

  it('20. fail() in failed_retrying when attempt.count >= maxRetries moves to failed (terminal)', async () => {
    const queue = createQueue({ maxRetries: 2, backoff: () => 1 });
    const jobId = await queue.enqueue(makeRequest());

    for (let i = 0; i < 3; i++) {
      const claimed = await queue.claimNext('worker-1');
      if (!claimed) break;
      await queue.fail(jobId, claimed.lease!.claimToken, {
        message: `attempt ${i + 1}`,
        retryable: true,
        classification: 'transient',
        recordedAt: now,
      });
      advance(10);
    }

    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('failed');
    expect(job?.attempt.count).toBe(2); // maxRetries exhausted
  });

  it('21. claimNext() picks up a failed_retrying job once nextRetryAt has passed', async () => {
    const queue = createQueue({ backoff: () => 5_000 });
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    await queue.fail(jobId, claimed!.lease!.claimToken, {
      message: 'flaky',
      retryable: true,
      classification: 'transient',
      recordedAt: now,
    });

    expect(await queue.claimNext('worker-1')).toBeNull(); // backoff in flight
    advance(5_001);
    const reclaim = await queue.claimNext('worker-1');
    expect(reclaim?.jobId).toBe(jobId);
    expect(reclaim?.state).toBe('running');
    expect(reclaim?.attempt.count).toBe(2);
  });

  it('21a. claimNext() increments attempt count before a retry can succeed', async () => {
    const queue = createQueue({ backoff: () => 0 });
    const jobId = await queue.enqueue(makeRequest());
    const first = await queue.claimNext('worker-1');
    await queue.fail(jobId, first!.lease!.claimToken, {
      message: 'first attempt failed',
      retryable: true,
      classification: 'transient',
      recordedAt: now,
    });

    const retry = await queue.claimNext('worker-1');
    expect(retry?.attempt.count).toBe(2);
    await queue.recordCommitMarker(jobId, retry!.lease!.claimToken, 'swmInserted');
    await queue.succeed(jobId, retry!.lease!.claimToken, { promotedCount: 1, succeededAt: now });

    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('succeeded');
    expect(job?.attempt.count).toBe(2);
  });

  it('21b. claimNext() generates a fresh claim token when the same worker reclaims the same job in the same millisecond', async () => {
    const queue = createQueue({ backoff: () => 0 });
    const jobId = await queue.enqueue(makeRequest());
    const firstClaim = await queue.claimNext('worker-1');
    const firstToken = firstClaim!.lease!.claimToken;

    await queue.fail(jobId, firstToken, {
      message: 'retry immediately',
      retryable: true,
      classification: 'transient',
      recordedAt: now,
    });

    const secondClaim = await queue.claimNext('worker-1');
    const secondToken = secondClaim!.lease!.claimToken;
    expect(secondToken).not.toBe(firstToken);
    await expect(queue.heartbeat(jobId, firstToken)).rejects.toBeInstanceOf(PromoteJobLeaseError);
  });

  it('21c. claimNext() reconciles expired running jobs before scanning candidates', async () => {
    // Scenario: worker-1 crashed mid-promote (lease expired after it had
    // already entered `assertionPromote()`). reconcileExpiredRunning
    // must ABANDON that row — re-running risks duplicate gossip — so
    // worker-2's claim sweep sees no eligible candidates and a fresh
    // enqueue for the same assertion succeeds because the abandoned
    // row no longer holds the uniqueness key.
    const queue = createQueue({ leaseMs: 10_000 });
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    await queue.recordCommitMarker(jobId, claimed!.lease!.claimToken, 'promoteStarted');
    advance(60_000);

    expect(await queue.claimNext('worker-2')).toBeNull();
    expect((await queue.getStatus(jobId))?.state).toBe('failed');

    const replacement = await queue.enqueue(makeRequest());
    expect(replacement).toBe('job-2');
  });

  it('22. claimNext() does NOT pick up failed_retrying before nextRetryAt', async () => {
    const queue = createQueue({ backoff: () => 60_000 });
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    await queue.fail(jobId, claimed!.lease!.claimToken, {
      message: 'wait',
      retryable: true,
      classification: 'transient',
      recordedAt: now,
    });

    advance(30_000);
    expect(await queue.claimNext('worker-1')).toBeNull();
  });

  it('22b. fail() treats retryable errors after swmInserted as terminal operator-recovery cases', async () => {
    const queue = createQueue({ backoff: () => 1_000 });
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    await queue.recordCommitMarker(jobId, claimed!.lease!.claimToken, 'swmInserted');

    await queue.fail(jobId, claimed!.lease!.claimToken, {
      message: 'network dropped after SWM insert',
      retryable: true,
      classification: 'transient',
      recordedAt: now,
    });

    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('failed');
    expect(job?.attempt.nextRetryAt).toBeUndefined();
    expect(job?.reason).toMatch(/SWM insert/i);
  });

  // ---------------------------------------------------------------------------
  // §3.4 recover / §4.4 recoverOnStartup
  // ---------------------------------------------------------------------------

  it('23. recover(jobId) on `failed` resets attempt counter and moves to `queued`', async () => {
    const queue = createQueue();
    const jobId = await queue.enqueue(makeRequest());
    await queue.cancel(jobId);
    expect((await queue.getStatus(jobId))?.state).toBe('failed');

    advance(100);
    await queue.recover(jobId);
    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('queued');
    expect(job?.attempt.count).toBe(0);
    expect(job?.attempt.lastError).toBeUndefined();
    expect(job?.attempt.nextRetryAt).toBeUndefined();
    expect(job?.reason).toBeUndefined();
  });

  it('24. recover(jobId) on non-failed state rejects', async () => {
    const queue = createQueue();
    const jobId = await queue.enqueue(makeRequest());
    await expect(queue.recover(jobId)).rejects.toThrow(/queued/);

    await queue.claimNext('worker-1');
    await expect(queue.recover(jobId)).rejects.toThrow(/running/);
  });

  it('24b. recover(jobId) rejects when another active job already owns the assertion', async () => {
    const queue = createQueue();
    const first = await queue.enqueue(makeRequest());
    await queue.cancel(first);
    const second = await queue.enqueue(makeRequest());

    await expect(queue.recover(first)).rejects.toMatchObject({
      name: 'PromoteJobConflictError',
      existingJobId: second,
    });
    expect((await queue.getStatus(first))?.state).toBe('failed');
    expect((await queue.getStatus(second))?.state).toBe('queued');
  });

  it('24c. recover(jobId) treats v2 no-agent rows as wildcard conflicts against active explicit lanes', async () => {
    const queue = createQueue();
    const failedLegacyJob: PromoteJob = {
      jobId: 'failed-v2-wildcard',
      request: makeRequest(),
      state: 'failed',
      enqueuedAt: now,
      updatedAt: now,
      attempt: { count: 1, maxRetries: 5 },
      formatVersion: 2,
    };
    await insertRawStoredJob(failedLegacyJob, `${legacyUniquenessKey(failedLegacyJob.request)}\u001f`);
    await insertRawStoredJob({
      jobId: 'active-explicit-lane',
      request: makeRequest({ agentAddress: `0x${'aa'.repeat(20)}` }),
      state: 'queued',
      enqueuedAt: now + 1,
      updatedAt: now + 1,
      attempt: { count: 0, maxRetries: 5 },
      formatVersion: ASYNC_PROMOTE_QUEUE_FORMAT_VERSION,
    }, uniquenessKey(makeRequest({ agentAddress: `0x${'aa'.repeat(20)}` })));

    await expect(queue.recover('failed-v2-wildcard')).rejects.toMatchObject({
      name: 'PromoteJobConflictError',
      existingJobId: 'active-explicit-lane',
    });
    expect((await queue.getStatus('failed-v2-wildcard'))?.state).toBe('failed');
  });

  it('24d. recover(jobId) refuses pre-v3 author-only rows that have no storage lane', async () => {
    const queue = createQueue();
    const rows: Array<{ jobId: string; reason: string }> = [
      { jobId: 'failed-v2-author-only', reason: 'transient old failure' },
      { jobId: 'failed-v2-author-only-conflict', reason: 'recovery conflict: active promote job already owns this assertion' },
    ];

    for (const [index, row] of rows.entries()) {
      const request = makeRequest({
        assertionName: `legacy-author-only-${index}`,
        authorAgentAddress: `0x${'aa'.repeat(20)}`,
      });
      await insertRawStoredJob({
        jobId: row.jobId,
        request,
        state: 'failed',
        enqueuedAt: now + index,
        updatedAt: now + index,
        reason: row.reason,
        attempt: { count: 1, maxRetries: 5 },
        formatVersion: 2,
      }, `${legacyUniquenessKey(request)}\u001f`);
    }

    for (const row of rows) {
      await expect(queue.recover(row.jobId)).rejects.toThrow(/missing storage lane/i);
      const parked = await queue.getStatus(row.jobId);
      expect(parked?.state).toBe('failed');
      expect(parked?.formatVersion).toBe(2);
      expect(parked?.reason).toMatch(/missing storage lane/i);
      expect(parked?.attempt.lastError?.message).toMatch(/cannot prove the WM storage lane/);
    }
  });

  it('25. recoverOnStartup() abandons running jobs whose lease expired AND swmInserted=true (partial-promote ambiguity)', async () => {
    const queue = createQueue({ leaseMs: 10_000 });
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    await queue.recordCommitMarker(jobId, claimed!.lease!.claimToken, 'swmInserted');

    // Simulate worker crash: lease expires and never gets heartbeated.
    advance(60_000);
    const summary = await queue.recoverOnStartup();

    expect(summary.abandoned).toBe(1);
    expect(summary.reclaimed).toBe(0);
    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('failed');
    expect(job?.reason).toMatch(/partial promote ambiguity/i);
    expect(job?.lease).toBeUndefined();
    await expect(queue.recover(jobId)).rejects.toThrow(/Cannot recover job .*partial promote ambiguity/i);
  });

  it('26. recoverOnStartup() reclaims expired running jobs when promote never started', async () => {
    const queue = createQueue({ leaseMs: 10_000 });
    const jobId = await queue.enqueue(makeRequest());
    await queue.claimNext('worker-1');
    // Claim initialises all progress markers to false. If the worker crashed
    // before promoteStarted=true, a clean rerun is safe.

    advance(60_000);
    const summary = await queue.recoverOnStartup();

    expect(summary.reclaimed).toBe(1);
    expect(summary.abandoned).toBe(0);
    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('queued');
    expect(job?.lease).toBeUndefined();
    expect(job?.reason).toBeUndefined();
  });

  it('26a. recoverOnStartup() reclaims an expired agent lane without conflicting with an active peer lane', async () => {
    const queue = createQueue({ leaseMs: 10_000 });
    const agentA = `0x${'aa'.repeat(20)}`;
    const agentB = `0x${'bb'.repeat(20)}`;
    const jobA = await queue.enqueue(makeRequest({ agentAddress: agentA }));
    const jobB = await queue.enqueue(makeRequest({ agentAddress: agentB }));

    await queue.claimNext('worker-a');
    advance(1);
    const claimB = await queue.claimNext('worker-b');
    expect(claimB?.jobId).toBe(jobB);

    advance(9_000);
    await queue.heartbeat(jobB, claimB!.lease!.claimToken);
    advance(2_000);

    const summary = await queue.recoverOnStartup();

    expect(summary.reclaimed).toBe(1);
    expect(summary.abandoned).toBe(0);
    expect((await queue.getStatus(jobA))?.state).toBe('queued');
    expect((await queue.getStatus(jobB))?.state).toBe('running');
  });

  it('26b. recoverOnStartup() ABANDONS legacy running jobs without a formatVersion marker (Codex PR #665 id=3302135756)', async () => {
    // The pre-v2 format had no `commitMarker.promoteStarted` field, so a
    // running row with `swmInserted: false` could mean either "worker
    // never started promote" (safe to rerun) or "worker started promote
    // but the old format never wrote a marker" (rerun would duplicate
    // gossip + SWM insert). Reclaim is no longer backward-compatible:
    // legacy rows go to the manual-recovery path.
    const queue = createQueue({ leaseMs: 10_000 });
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    await (queue as unknown as { writeJob(job: PromoteJob): Promise<void> }).writeJob({
      ...claimed!,
      // Drop the formatVersion stamp to simulate a row written by a
      // pre-v2 daemon process. Marker keeps the full shape (parser
      // requires every flag) but no `promoteStarted` truth value —
      // the version gate is what makes the row legacy, not the marker
      // contents.
      formatVersion: undefined,
      commitMarker: {
        swmInserted: false,
        wmCleaned: false,
        lifecycleStamped: false,
        gossiped: false,
      } as PromoteJob['commitMarker'],
    });

    advance(60_000);
    const summary = await queue.recoverOnStartup();

    expect(summary.reclaimed).toBe(0);
    expect(summary.abandoned).toBe(1);
    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('failed');
    expect(job?.lease).toBeUndefined();
    expect(job?.reason).toMatch(/legacy promote job/i);
    expect(job?.attempt.lastError?.message).toMatch(/formatVersion=0/);
    await expect(queue.recover(jobId)).rejects.toThrow(/Cannot recover job .*legacy promote job/i);
  });

  it('26c. recoverOnStartup() RECLAIMS current-format running jobs with promoteStarted=false', async () => {
    const queue = createQueue({ leaseMs: 10_000 });
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    // Fresh claim leaves promoteStarted=false; row carries the current
    // formatVersion stamp from enqueue + claimNext.
    expect(claimed?.formatVersion).toBe(ASYNC_PROMOTE_QUEUE_FORMAT_VERSION);
    expect(claimed?.commitMarker?.promoteStarted).toBe(false);

    advance(60_000);
    const summary = await queue.recoverOnStartup();

    expect(summary.reclaimed).toBe(1);
    expect(summary.abandoned).toBe(0);
    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('queued');
    expect(job?.formatVersion).toBe(ASYNC_PROMOTE_QUEUE_FORMAT_VERSION);
    expect(job?.lease).toBeUndefined();
    expect(job?.commitMarker).toBeUndefined();
  });

  it('26d. recoverOnStartup() RECLAIMS v2 default-lane running jobs with promoteStarted=false', async () => {
    const queue = createQueue({ leaseMs: 10_000 });
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    await (queue as unknown as { writeJob(job: PromoteJob): Promise<void> }).writeJob({
      ...claimed!,
      request: {
        contextGraphId: claimed!.request.contextGraphId,
        subGraphName: claimed!.request.subGraphName,
        assertionName: claimed!.request.assertionName,
        entities: claimed!.request.entities,
      },
      formatVersion: 2,
      commitMarker: {
        promoteStarted: false,
        swmInserted: false,
        wmCleaned: false,
        lifecycleStamped: false,
        gossiped: false,
      },
    });

    advance(60_000);
    const summary = await queue.recoverOnStartup();

    expect(summary.reclaimed).toBe(1);
    expect(summary.abandoned).toBe(0);
    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('queued');
    expect(job?.formatVersion).toBe(ASYNC_PROMOTE_QUEUE_FORMAT_VERSION);
    expect(job?.request.agentAddress).toBeUndefined();
    expect(job?.lease).toBeUndefined();
    expect(job?.commitMarker).toBeUndefined();
  });

  it('26e. recoverOnStartup() ABANDONS v2 author-only running jobs with no storage lane', async () => {
    const queue = createQueue({ leaseMs: 10_000 });
    const jobId = await queue.enqueue(makeRequest({ authorAgentAddress: `0x${'aa'.repeat(20)}` }));
    const claimed = await queue.claimNext('worker-1');
    await (queue as unknown as { writeJob(job: PromoteJob): Promise<void> }).writeJob({
      ...claimed!,
      request: {
        contextGraphId: claimed!.request.contextGraphId,
        subGraphName: claimed!.request.subGraphName,
        assertionName: claimed!.request.assertionName,
        entities: claimed!.request.entities,
        authorAgentAddress: claimed!.request.authorAgentAddress,
      },
      formatVersion: 2,
      commitMarker: {
        promoteStarted: false,
        swmInserted: false,
        wmCleaned: false,
        lifecycleStamped: false,
        gossiped: false,
      },
    });

    advance(60_000);
    const summary = await queue.recoverOnStartup();

    expect(summary.reclaimed).toBe(0);
    expect(summary.abandoned).toBe(1);
    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('failed');
    expect(job?.reason).toMatch(/missing storage lane/i);
    await expect(queue.recover(jobId)).rejects.toThrow(/Cannot recover job .*missing storage lane/i);
  });

  it('26f. recoverOnStartup() ABANDONS legacy running jobs even when promoteStarted=false is explicitly present', async () => {
    // Belt-and-braces: even if a hypothetical legacy daemon happens to
    // have written `promoteStarted: false` into the marker, the version
    // gate still parks the job for manual inspection. The whole point of
    // the version field is "trust the marker shape only when the writer
    // is at our format level or higher".
    const queue = createQueue({ leaseMs: 10_000 });
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    await (queue as unknown as { writeJob(job: PromoteJob): Promise<void> }).writeJob({
      ...claimed!,
      formatVersion: 1,
      commitMarker: {
        promoteStarted: false,
        swmInserted: false,
        wmCleaned: false,
        lifecycleStamped: false,
        gossiped: false,
      },
    });

    advance(60_000);
    const summary = await queue.recoverOnStartup();
    expect(summary.reclaimed).toBe(0);
    expect(summary.abandoned).toBe(1);
    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('failed');
    expect(job?.reason).toMatch(/legacy promote job/i);
  });

  it('27. recoverOnStartup() abandons expired running jobs after promote has started', async () => {
    const queue = createQueue({ leaseMs: 10_000 });
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    await queue.recordCommitMarker(jobId, claimed!.lease!.claimToken, 'promoteStarted');

    advance(60_000);
    const summary = await queue.recoverOnStartup();

    expect(summary.reclaimed).toBe(0);
    expect(summary.abandoned).toBe(1);
    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('failed');
    expect(job?.lease).toBeUndefined();
    expect(job?.reason).toMatch(/partial promote ambiguity/i);
  });

  it('28. recoverOnStartup() leaves `running` jobs alone when the lease is still valid', async () => {
    const queue = createQueue({ leaseMs: 60_000 });
    const jobId = await queue.enqueue(makeRequest());
    await queue.claimNext('worker-1');

    advance(10_000); // lease still valid (< 60s)
    const summary = await queue.recoverOnStartup();

    expect(summary.reclaimed).toBe(0);
    expect(summary.abandoned).toBe(0);
    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('running');
    expect(job?.lease).toBeDefined();
  });

  it('27b. recoverOnStartup() abandons expired running jobs when another active job has the same assertion', async () => {
    const queue = createQueue({ leaseMs: 10_000 });
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');

    await store.insert(
      serializeJob(
        {
          jobId: 'corrupt-duplicate',
          request: makeRequest(),
          state: 'queued',
          enqueuedAt: now,
          updatedAt: now,
          attempt: { count: 0, maxRetries: 5 },
        },
        DEFAULT_PROMOTE_CONTROL_GRAPH_URI,
      ),
    );

    advance(60_000);
    const summary = await queue.recoverOnStartup();
    expect(summary.reclaimed).toBe(0);
    expect(summary.abandoned).toBe(1);
    expect((await queue.getStatus(jobId))?.state).toBe('failed');
    expect((await queue.getStatus(jobId))?.reason).toMatch(/recovery conflict/i);
    expect((await queue.getStatus('corrupt-duplicate'))?.state).toBe('queued');
    expect(claimed?.state).toBe('running');
  });

  it('27c. recoverOnStartup() treats v2 no-agent rows as wildcard conflicts against active explicit lanes', async () => {
    const queue = createQueue({ leaseMs: 10_000 });
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-legacy');
    await (queue as unknown as { writeJob(job: PromoteJob): Promise<void> }).writeJob({
      ...claimed!,
      request: {
        contextGraphId: claimed!.request.contextGraphId,
        subGraphName: claimed!.request.subGraphName,
        assertionName: claimed!.request.assertionName,
        entities: claimed!.request.entities,
      },
      formatVersion: 2,
      commitMarker: {
        promoteStarted: false,
        swmInserted: false,
        wmCleaned: false,
        lifecycleStamped: false,
        gossiped: false,
      },
    });
    await insertRawStoredJob({
      jobId: 'active-explicit-during-recovery',
      request: makeRequest({ agentAddress: `0x${'aa'.repeat(20)}` }),
      state: 'queued',
      enqueuedAt: now + 1,
      updatedAt: now + 1,
      attempt: { count: 0, maxRetries: 5 },
      formatVersion: ASYNC_PROMOTE_QUEUE_FORMAT_VERSION,
    }, uniquenessKey(makeRequest({ agentAddress: `0x${'aa'.repeat(20)}` })));

    advance(60_000);
    const summary = await queue.recoverOnStartup();

    expect(summary.reclaimed).toBe(0);
    expect(summary.abandoned).toBe(1);
    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('failed');
    expect(job?.reason).toMatch(/recovery conflict/i);
    expect((await queue.getStatus('active-explicit-during-recovery'))?.state).toBe('queued');
  });

  it('29. recoverOnStartup() returns counts of {reclaimed, abandoned}', async () => {
    const queue = createQueue({ leaseMs: 10_000 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await queue.enqueue(makeRequest({ assertionName: `assertion-${i}` }));
      ids.push(id);
      const claimed = await queue.claimNext(`worker-${i}`);
      if (i < 2) {
        // Half crossed into promote and are ambiguous; the other half died
        // before promoteStarted and can be safely reclaimed.
        await queue.recordCommitMarker(id, claimed!.lease!.claimToken, 'swmInserted');
      }
    }

    advance(60_000);
    const summary = await queue.recoverOnStartup();
    expect(summary.abandoned).toBe(2);
    expect(summary.reclaimed).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Observability
  // ---------------------------------------------------------------------------

  it('30. getStats() returns queue depth per state', async () => {
    const queue = createQueue();
    const stats0 = await queue.getStats();
    for (const s of PROMOTE_JOB_STATES) expect(stats0[s]).toBe(0);

    await queue.enqueue(makeRequest({ assertionName: 'a' }));
    await queue.enqueue(makeRequest({ assertionName: 'b' }));
    const cId = await queue.enqueue(makeRequest({ assertionName: 'c' }));
    const claimed = await queue.claimNext('worker-1');
    expect(claimed?.jobId).not.toBe(cId);

    const stats1 = await queue.getStats();
    expect(stats1.queued).toBe(2);
    expect(stats1.running).toBe(1);
    expect(stats1.succeeded).toBe(0);
    expect(stats1.failed).toBe(0);
    expect(stats1.failed_retrying).toBe(0);
  });

  it('30. pause() prevents claimNext() from picking new work; resume() restores it', async () => {
    const queue = createQueue();
    await queue.enqueue(makeRequest({ assertionName: 'a' }));
    await queue.enqueue(makeRequest({ assertionName: 'b' }));

    await queue.pause();
    expect(await queue.claimNext('w1')).toBeNull();
    expect(await queue.claimNext('w2')).toBeNull();

    await queue.resume();
    const c1 = await queue.claimNext('w1');
    expect(c1).not.toBeNull();
    advance(1);
    const c2 = await queue.claimNext('w2');
    expect(c2).not.toBeNull();
    expect(c1!.jobId).not.toBe(c2!.jobId);
  });

  // ---------------------------------------------------------------------------
  // Edge case the plan §7 calls out: succeed() requires fresh lease.
  // ---------------------------------------------------------------------------

  it('31. recordCommitMarker / succeed / fail with stale claim token throw PromoteJobLeaseError', async () => {
    const queue = createQueue();
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    const goodToken = claimed!.lease!.claimToken;

    // The good token still works.
    await queue.recordCommitMarker(jobId, goodToken, 'swmInserted');

    // A stale token (e.g. another worker reclaimed after retry backoff) — all
    // four lease-protected ops reject.
    await expect(queue.recordCommitMarker(jobId, 'stale', 'wmCleaned')).rejects.toBeInstanceOf(PromoteJobLeaseError);
    await expect(queue.heartbeat(jobId, 'stale')).rejects.toBeInstanceOf(PromoteJobLeaseError);
    await expect(
      queue.fail(jobId, 'stale', { message: 'x', retryable: false, classification: 'fatal', recordedAt: now }),
    ).rejects.toBeInstanceOf(PromoteJobLeaseError);
    await expect(
      queue.succeed(jobId, 'stale', { promotedCount: 1, succeededAt: now }),
    ).rejects.toBeInstanceOf(PromoteJobLeaseError);
  });

  it('31b. concurrent heartbeat and succeed transitions cannot resurrect a succeeded job', async () => {
    const queue = createQueue({ leaseMs: 60_000 });
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    const token = claimed!.lease!.claimToken;
    await queue.recordCommitMarker(jobId, token, 'swmInserted');

    await Promise.allSettled([
      queue.heartbeat(jobId, token),
      queue.succeed(jobId, token, { promotedCount: 1, succeededAt: now }),
    ]);

    const job = await queue.getStatus(jobId);
    expect(job?.state).toBe('succeeded');
    expect(job?.lease).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // §4.5 importLimits hint — the queue records workerConcurrency as a
  // serialisable property the daemon can surface on /api/status.
  // We test this in the wiring PR (#2); for PR #1 we just confirm the
  // queue exposes its config back via the type system.
  // ---------------------------------------------------------------------------

  it('32. getStats() and list() consistently observe state transitions', async () => {
    const queue = createQueue({ leaseMs: 30_000, backoff: () => 1_000 });
    const ids = await Promise.all([
      queue.enqueue(makeRequest({ assertionName: 'a' })),
      queue.enqueue(makeRequest({ assertionName: 'b' })),
      queue.enqueue(makeRequest({ assertionName: 'c' })),
    ]);

    // Claim all three; succeed one, fail one retryable, fail one fatal.
    const claimed: PromoteJob[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await queue.claimNext(`worker-${i}`);
      if (c) claimed.push(c);
      advance(1);
    }
    expect(claimed.length).toBe(3);

    const aJob = claimed.find((j) => j.jobId === ids[0])!;
    const bJob = claimed.find((j) => j.jobId === ids[1])!;
    const cJob = claimed.find((j) => j.jobId === ids[2])!;

    await queue.recordCommitMarker(aJob.jobId, aJob.lease!.claimToken, 'swmInserted');
    await queue.succeed(aJob.jobId, aJob.lease!.claimToken, { promotedCount: 1, succeededAt: now });
    await queue.fail(bJob.jobId, bJob.lease!.claimToken, {
      message: 'transient',
      retryable: true,
      classification: 'transient',
      recordedAt: now,
    });
    await queue.fail(cJob.jobId, cJob.lease!.claimToken, {
      message: 'broken',
      retryable: false,
      classification: 'fatal',
      recordedAt: now,
    });

    const stats = await queue.getStats();
    expect(stats.succeeded).toBe(1);
    expect(stats.failed_retrying).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.running).toBe(0);
    expect(stats.queued).toBe(0);

    const all = await queue.list();
    expect(all.length).toBe(3);
  });

  it('33. list() skips corrupted payload rows with missing nested fields', async () => {
    const queue = createQueue();
    await queue.enqueue(makeRequest({ assertionName: 'valid' }));
    await store.insert([
      {
        subject: 'urn:dkg:promote-queue:job:corrupt',
        predicate: PROMOTE_STATE,
        object: literal('queued'),
        graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI,
      },
      {
        subject: 'urn:dkg:promote-queue:job:corrupt',
        predicate: PROMOTE_PAYLOAD,
        object: literal(JSON.stringify({ jobId: 'corrupt', state: 'queued' })),
        graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI,
      },
    ]);

    const jobs = await queue.list();
    expect(jobs.map((j) => j.request.assertionName)).toEqual(['valid']);
  });
});
