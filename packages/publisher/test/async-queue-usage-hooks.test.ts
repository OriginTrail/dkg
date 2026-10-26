/**
 * RFC-73 P1b: the queues feed the `async_admission_usage` figures. These tests drive the REAL
 * share queue and publisher claim coordinator over an in-memory store with an injected clock
 * and read what the process-wide recorder saw, so a hook that moves or disappears fails here.
 * Behavior of the queues themselves is pinned by their own suites.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { asyncAdmissionUsage } from '@origintrail-official/dkg-core';
import {
  createLiftJobFailureMetadata,
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
} from '../src/index.js';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import type { AsyncPromoteQueueConfig } from '../src/async-promote-queue-types.js';
import {
  KA_VM_VALIDATION,
  kaVmPublishRequest,
  stageKnowledgeAssetShareSnapshot,
} from '../../../scripts/testing/ka-vm-publish.js';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('share queue lease recovery figures', () => {
  let store: OxigraphStore;
  let now: number;
  let ids: number;

  beforeEach(() => {
    asyncAdmissionUsage.reset();
    store = new OxigraphStore();
    now = 1_000_000;
    ids = 0;
  });

  function createQueue(overrides: Partial<AsyncPromoteQueueConfig> = {}): TripleStoreAsyncPromoteQueue {
    return new TripleStoreAsyncPromoteQueue(store, {
      now: () => now,
      idGenerator: () => `job-${++ids}`,
      leaseMs: 10_000,
      ...overrides,
    });
  }
  const request = (assertionName: string) => ({
    contextGraphId: 'cg', subGraphName: 'code', assertionName, entities: 'all' as const,
  });

  it('counts a lease reclaimed by claimNext and still hands the job to the next worker', async () => {
    const queue = createQueue();
    const jobId = await queue.enqueue(request('a'));
    await queue.claimNext('worker-1'); // never heartbeats: the worker is gone
    now += 60_000;

    const reclaimed = await queue.claimNext('worker-2');

    expect(reclaimed?.jobId).toBe(jobId);
    expect(reclaimed?.lease?.workerId).toBe('worker-2');
    expect(asyncAdmissionUsage.take()).toMatchObject({ shareReclaimed: 1, shareAbandoned: 0 });
  });

  it('counts the leases a startup recovery reclaimed and abandoned, and returns the same summary', async () => {
    const queue = createQueue();
    const reclaimable = await queue.enqueue(request('a'));
    const ambiguous = await queue.enqueue(request('b'));
    await queue.claimNext('worker-1');
    const second = await queue.claimNext('worker-2');
    await queue.recordCommitMarker(ambiguous, second!.lease!.claimToken, 'swmInserted');
    now += 60_000;

    const summary = await queue.recoverOnStartup();

    expect(summary).toEqual({ reclaimed: 1, abandoned: 1 });
    expect(await queue.getStatus(reclaimable)).toMatchObject({ state: 'queued' });
    expect(await queue.getStatus(ambiguous)).toMatchObject({ state: 'failed' });
    expect(asyncAdmissionUsage.take()).toMatchObject({ shareReclaimed: 1, shareAbandoned: 1 });
  });

  it.each([
    ['reclaimed', 'findActiveConflict', false, { reclaimed: 1, abandoned: 0 }],
    ['reclaimed', 'writeJob', false, { reclaimed: 1, abandoned: 0 }],
    ['abandoned', 'findActiveConflict', true, { reclaimed: 0, abandoned: 1 }],
  ] as const)('counts a lease %s although %s throws for the next job in the same sweep', async (_outcome, failingStep, ambiguous, counted) => {
    const queue = createQueue();
    const jobIds = [await queue.enqueue(request('a')), await queue.enqueue(request('b'))];
    for (const worker of ['worker-1', 'worker-2']) {
      const claimed = await queue.claimNext(worker);
      if (ambiguous) await queue.recordCommitMarker(claimed!.jobId, claimed!.lease!.claimToken, 'swmInserted');
    }
    now += 60_000;
    asyncAdmissionUsage.take();

    // The sweep's first job commits; the step it takes for the second throws.
    const steps = queue as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const realStep = steps[failingStep]!.bind(queue);
    let calls = 0;
    vi.spyOn(steps, failingStep).mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('injected sweep failure');
      return await realStep(...args);
    });

    await expect(queue.recoverOnStartup()).rejects.toThrow('injected sweep failure');

    // One job left its expired lease before the failure; the other was never reached.
    const states = (await Promise.all(jobIds.map((id) => queue.getStatus(id)))).map((job) => job?.state).sort();
    expect(states).toEqual(ambiguous ? ['failed', 'running'] : ['queued', 'running']);
    expect(asyncAdmissionUsage.take()).toMatchObject({ shareReclaimed: counted.reclaimed, shareAbandoned: counted.abandoned });
  });

  it('adds nothing when no lease expired', async () => {
    const queue = createQueue();
    await queue.enqueue(request('a'));
    await queue.claimNext('worker-1');

    expect(await queue.recoverOnStartup()).toEqual({ reclaimed: 0, abandoned: 0 });
    expect(asyncAdmissionUsage.take()).toMatchObject({ shareReclaimed: 0, shareAbandoned: 0 });
  });
});

describe('publisher queue figures', () => {
  let store: OxigraphStore;
  let now: number;
  let ids: number;
  let claimTokens: number;

  beforeEach(() => {
    asyncAdmissionUsage.reset();
    store = new OxigraphStore();
    now = 1_000;
    ids = 0;
    claimTokens = 0;
  });

  function createPublisher(config: AsyncLiftPublisherConfig = {}): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => now,
      idGenerator: () => `job-${++ids}`,
      claimTokenGenerator: () => `claim-${++claimTokens}`,
      ...config,
    });
  }
  const vmPublish = (n: number) => kaVmPublishRequest({
    name: `asset-${n}`,
    shareOperationId: `share-op-${n}`,
    intentKey: `sha256:${String(n).repeat(64)}`,
  });

  it('measures pick-up from ready to claimed, separates worker-free jobs and frees a wallet on release', async () => {
    const publisher = createPublisher();
    asyncAdmissionUsage.setLiftWallets(['wallet-1', 'wallet-2']);

    // Both wallets are seen idle before any job exists.
    now = 500;
    expect(await publisher.claimNext('wallet-1')).toBeNull();
    expect(await publisher.claimNext('wallet-2')).toBeNull();

    // Job A is ready at 1000 and claimed at 5000: a wallet was free the whole time.
    now = 1_000;
    const a = await publisher.enqueueKnowledgeAssetVmPublish(vmPublish(1));
    now = 5_000;
    expect((await publisher.claimNext('wallet-1'))?.jobId).toBe(a);

    // Job B is ready at 6000 while wallet-1 is busy but wallet-2 is free.
    now = 6_000;
    const b = await publisher.enqueueKnowledgeAssetVmPublish(vmPublish(2));
    now = 9_000;
    expect((await publisher.claimNext('wallet-2'))?.jobId).toBe(b);

    // Job C is ready at 9500, when both wallets hold a lock.
    now = 9_500;
    const c = await publisher.enqueueKnowledgeAssetVmPublish(vmPublish(3));

    // Finishing A deletes wallet-1's lock, so the usage line sees the wallet turn over.
    now = 10_000;
    await publisher.update(a, 'validated', { validation: KA_VM_VALIDATION });
    now = 11_000;
    await publisher.update(a, 'finalized', { finalization: { mode: 'local' } });
    // Job D is ready at 11500: after A's release, before any further claim could re-read the lock.
    now = 11_500;
    const d = await publisher.enqueueKnowledgeAssetVmPublish(vmPublish(4));
    now = 12_000;
    expect((await publisher.claimNext('wallet-1'))?.jobId).toBe(c);

    const usage = asyncAdmissionUsage.take();
    expect(usage.liftWallets).toBe(2);
    expect(usage.liftPickup.n).toBe(3);
    expect(usage.liftPickup.maxMs).toBe(4_000);
    // A and B were ready while a wallet was free; C was ready while both were busy.
    expect(usage.liftPickupWorkerFree.n).toBe(2);
    expect(usage.liftPickupWorkerFree.maxMs).toBe(4_000);
    expect(usage.liftPickupUnclassified).toBe(0);
    // Only A reached a finish; it ran from its claim at 5000 to 11000.
    expect(usage.liftFinalized).toBe(1);
    expect(usage.liftClaimToFinish.n).toBe(1);
    expect(usage.liftClaimToFinish.maxMs).toBe(6_000);
    expect(usage.liftFailed).toBe(0);

    // D is claimed after C finishes. Only the release hook told the tracker that wallet-1 was free at
    // 11500 (a later lock read closes the interval at its own time), so D joins the worker-free sample.
    now = 12_500;
    await publisher.update(c, 'validated', { validation: KA_VM_VALIDATION });
    now = 13_000;
    await publisher.update(c, 'finalized', { finalization: { mode: 'local' } });
    now = 14_000;
    expect((await publisher.claimNext('wallet-1'))?.jobId).toBe(d);

    const next = asyncAdmissionUsage.take();
    expect(next.liftPickup.n).toBe(1);
    expect(next.liftPickup.maxMs).toBe(2_500);
    expect(next.liftPickupWorkerFree.n).toBe(1);
    expect(next.liftPickupWorkerFree.maxMs).toBe(2_500);
    expect(next.liftPickupUnclassified).toBe(0);
  });

  it('counts a job that became ready before the tracker knew the wallets as unclassified', async () => {
    const publisher = createPublisher();
    asyncAdmissionUsage.setLiftWallets(['wallet-1']);
    now = 100;
    await publisher.enqueueKnowledgeAssetVmPublish(vmPublish(1));
    now = 200;
    await publisher.claimNext('wallet-1');

    const usage = asyncAdmissionUsage.take();
    expect(usage.liftPickup.n).toBe(1);
    expect(usage.liftPickupWorkerFree.n).toBe(0);
    expect(usage.liftPickupUnclassified).toBe(1);
  });

  it('uses the latest of accepted, retried and recovered as the moment a job became ready', async () => {
    const publisher = createPublisher();
    asyncAdmissionUsage.setLiftWallets(['wallet-1']);
    now = 10;
    await publisher.claimNext('wallet-1'); // the wallet is seen idle
    now = 1_000;
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(vmPublish(1));
    now = 2_000;
    await publisher.claimNext('wallet-1');
    asyncAdmissionUsage.take();

    // The claim expires and recovery resets the job to accepted at 8000.
    now = 8_000 + 5 * 60_000;
    expect(await publisher.recover()).toBe(1);
    expect(await publisher.getStatus(jobId)).toMatchObject({ status: 'accepted' });
    const resetAt = now;
    now = resetAt + 700;
    await publisher.claimNext('wallet-1');

    const usage = asyncAdmissionUsage.take();
    expect(usage.liftReclaimed).toBe(1);
    expect(usage.liftPickup.maxMs).toBe(700);
  });

  it('counts the finish of a job that failed without sampling its claim-to-finish time', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(vmPublish(1));
    await publisher.claimNext('wallet-1');
    now += 1_000;
    await publisher.update(jobId, 'failed', {
      failure: createLiftJobFailureMetadata({
        failedFromState: 'claimed',
        code: 'workspace_slice_not_found',
        message: 'gone',
        errorPayloadRef: `urn:error:${jobId}`,
      }),
    });

    const usage = asyncAdmissionUsage.take();
    expect(usage.liftFailed).toBe(1);
    expect(usage.liftFinalized).toBe(0);
    expect(usage.liftClaimToFinish.n).toBe(0);
  });

  it('counts a job entering a terminal state once, not each repeated update of the finished job', async () => {
    const publisher = createPublisher();
    const failure = (jobId: string) => createLiftJobFailureMetadata({
      failedFromState: 'claimed',
      code: 'workspace_slice_not_found',
      message: 'gone',
      errorPayloadRef: `urn:error:${jobId}`,
    });
    const finalizedId = await publisher.enqueueKnowledgeAssetVmPublish(vmPublish(1));
    const failedId = await publisher.enqueueKnowledgeAssetVmPublish(vmPublish(2));
    await publisher.claimNext('wallet-1');
    await publisher.claimNext('wallet-2');
    now += 1_000;
    await publisher.update(finalizedId, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(finalizedId, 'finalized', { finalization: { mode: 'local' } });
    await publisher.update(failedId, 'failed', { failure: failure(failedId) });
    const first = asyncAdmissionUsage.take();
    expect(first).toMatchObject({ liftFinalized: 1, liftFailed: 1 });
    expect(first.liftClaimToFinish.n).toBe(1);

    // The totals are cumulative and the latency window is drained by the read above, so a repeat
    // that counted again would raise the totals or put a stale sample back in the window.
    now += 5_000;
    await publisher.update(finalizedId, 'finalized', { finalization: { mode: 'local' } });
    await publisher.update(failedId, 'failed', { failure: failure(failedId) });

    const repeated = asyncAdmissionUsage.take();
    expect(await publisher.getStatus(finalizedId)).toMatchObject({ status: 'finalized' });
    expect(await publisher.getStatus(failedId)).toMatchObject({ status: 'failed' });
    expect(repeated.liftFinalized).toBe(1);
    expect(repeated.liftFailed).toBe(1);
    expect(repeated.liftClaimToFinish.n).toBe(0);
  });

  it('counts a reclaim and the stale claim of the worker that lost the job', async () => {
    const preflightEntered = deferred();
    const releasePreflight = deferred();
    const staleExecutor = createPublisher({
      knowledgeAssetVmPublishHandler: {
        preflight: async () => {
          preflightEntered.resolve();
          await releasePreflight.promise;
          throw new Error('stale canonicalization failure');
        },
        execute: async () => { throw new Error('execute must not run after stale preflight'); },
        finalizeRecovered: async () => {},
      },
    });
    const recovery = createPublisher();
    await stageKnowledgeAssetShareSnapshot({ store, graphManager: new GraphManager(store) });

    await staleExecutor.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const staleRun = staleExecutor.processNext('wallet-a');
    await preflightEntered.promise;

    now += 5 * 60_000 + 1;
    expect(await recovery.recover()).toBe(1);
    await recovery.claimNext('wallet-a');
    releasePreflight.resolve();
    await staleRun;

    expect(asyncAdmissionUsage.take()).toMatchObject({ liftReclaimed: 1, liftStaleClaims: 1 });
  });
});
