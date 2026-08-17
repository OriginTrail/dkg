import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
  type LiftJob,
  resolveAsyncLiftRetryTuning,
} from '../src/index.js';
import {
  KA_VM_VALIDATION,
  kaVmPublishRequest,
  stageKnowledgeAssetShareSnapshot,
} from './_helpers/ka-vm-publish.js';

/**
 * GH#2270 — the automatic retry lane: registry allow-list (`workspace_unavailable`), jittered
 * backoff, the `autoRetryEnabled` kill-switch and the per-sweep reaccept cap.
 *
 * Every row drives the PUBLIC path (`processNext`/`claimNext`) so the assertions cover the
 * scheduler and the claim-time sweep as they actually run. The claim-time preflight is the
 * cheapest real producer of a pre-send `workspace_unavailable`: it is invoked before any
 * workspace resolution, so failure-only rows need no staged snapshot.
 */
describe('GH#2270 async lift automatic retry lane', () => {
  let now = 1_000;
  let ids = 0;
  let store: OxigraphStore;

  beforeEach(() => {
    now = 1_000;
    ids = 0;
    store = new OxigraphStore();
  });

  /** GH#2273 corrupt-head error: the structured code the precondition classifier keys on. */
  function corruptHeadError(): Error {
    return Object.assign(
      new Error('Corrupt graph-scoped SWM head for did:dkg:test/1: head carries 2 shareOperationId values (op-a, storage-ack-b)'),
      { code: 'KA_WORKSPACE_HEAD_CORRUPT' },
    );
  }

  function confirmedPublishResult() {
    return {
      kaId: 11n,
      ual: 'did:dkg:mock:31337/0xdef/11',
      merkleRoot: new Uint8Array([0xde, 0xf0]),
      kaManifest: [],
      status: 'confirmed' as const,
      onChainResult: {
        batchId: 11n,
        startKAId: 11n,
        endKAId: 11n,
        txHash: '0xdef',
        blockNumber: 77,
        blockTimestamp: 1700000077,
        publisherAddress: '0x2222222222222222222222222222222222222222',
      },
    };
  }

  function createPublisher(
    config: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator'> = {},
  ): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++now,
      idGenerator: () => `job-${++ids}`,
      ...config,
    });
  }

  /** A publisher whose claim-time preflight always rejects with a corrupt head. */
  function createCorruptHeadPublisher(
    config: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator' | 'knowledgeAssetVmPublishHandler'> = {},
  ): TripleStoreAsyncLiftPublisher {
    return createPublisher({
      ...config,
      knowledgeAssetVmPublishHandler: {
        preflight: async () => {
          throw corruptHeadError();
        },
        execute: async () => {
          throw new Error('executor must not run for a corrupt-head preflight');
        },
      },
    });
  }

  async function failWithCorruptHead(
    publisher: TripleStoreAsyncLiftPublisher,
    walletId: string,
  ): Promise<LiftJob> {
    const processed = await publisher.processNext(walletId);
    if (!processed || processed.status !== 'failed') {
      throw new Error(`expected a failed job, got ${processed?.status ?? 'null'}`);
    }
    if (processed.failure.code !== 'workspace_unavailable') {
      throw new Error(`expected workspace_unavailable, got ${processed.failure.code}`);
    }
    return processed;
  }

  /** Scheduled delay of the retry, measured the way the pre-existing backoff rows measure it. */
  function scheduledDelay(job: LiftJob): number | undefined {
    return job.timestamps.nextRetryAt === undefined
      ? undefined
      : job.timestamps.nextRetryAt - job.timestamps.updatedAt;
  }

  // (a) The end-to-end lane: a claim-time corrupt head schedules a retry, the sweep reaccepts it
  // once due, and the second attempt publishes. The staged snapshot is left byte-identical across
  // the retry — re-staging it would move the head and the re-run would fail `publish_intent_stale`
  // instead of publishing.
  it('auto-reaccepts a claim-time workspace_unavailable failure and publishes on the retry', async () => {
    const shareOperationId = 'auto-retry-op';
    let preflightCalls = 0;
    const executed: unknown[] = [];
    const publisher = createPublisher({
      retryBackoffBaseMs: 100,
      retryBackoffMaxMs: 250,
      rand: () => 0.5,
      knowledgeAssetVmPublishHandler: {
        preflight: async () => {
          preflightCalls += 1;
          if (preflightCalls === 1) throw corruptHeadError();
          return { action: 'execute' as const };
        },
        execute: async (input) => {
          executed.push(input);
          return confirmedPublishResult();
        },
      },
    });
    await stageKnowledgeAssetShareSnapshot({
      store,
      shareOperationId,
      assertionVersion: 1,
      accessPolicy: 'public',
    });

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      shareOperationId,
    }));
    const failed = await publisher.processNext('wallet-1');

    expect(failed?.status).toBe('failed');
    expect(failed?.failure?.code).toBe('workspace_unavailable');
    expect(failed?.failure?.failedFromState).toBe('claimed');
    expect(scheduledDelay(failed as LiftJob)).toBe(100);
    expect(executed).toHaveLength(0);

    // Not due yet: the sweep leaves it failed.
    expect(await publisher.claimNext('wallet-2')).toBeNull();
    expect((await publisher.getStatus(jobId))?.status).toBe('failed');

    now += 100;
    const finalized = await publisher.processNext('wallet-2');

    expect(finalized?.jobId).toBe(jobId);
    expect(finalized?.status).toBe('finalized');
    expect(finalized?.retries.retryCount).toBe(1);
    expect(finalized?.retries.lastRetryReason).toBe('workspace_unavailable');
    expect(finalized?.timestamps.nextRetryAt).toBeUndefined();
    expect(executed).toHaveLength(1);
  });

  // (c) Jitter is symmetric and multiplicative around the exponential delay: r = 0.2 puts the
  // bounds at 0.8× and 1.2× of the 100ms base, and rand() = 0.5 is the exact midpoint.
  it('jitters the scheduled backoff symmetrically around the exponential delay', async () => {
    const cases: ReadonlyArray<{ rand: number; expected: number }> = [
      { rand: 0, expected: 80 },
      { rand: 0.5, expected: 100 },
      { rand: 1, expected: 120 },
    ];

    for (const { rand, expected } of cases) {
      store = new OxigraphStore();
      const publisher = createCorruptHeadPublisher({
        retryBackoffBaseMs: 100,
        retryBackoffMaxMs: 100_000,
        retryJitterRatio: 0.2,
        rand: () => rand,
      });
      await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      expect([rand, scheduledDelay(await failWithCorruptHead(publisher, 'wallet-1'))])
        .toEqual([rand, expected]);
    }
  });

  // The DEFAULT ratio is 0.2 — pinned here because it is what makes every exact-delay
  // expectation elsewhere in the suite need an injected `rand` (the pre-existing backoff row in
  // async-lift-publisher.test.ts among them).
  it('jitters by 0.2 when no ratio is configured', async () => {
    const publisher = createCorruptHeadPublisher({
      retryBackoffBaseMs: 100,
      retryBackoffMaxMs: 100_000,
      rand: () => 1,
    });
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    expect(scheduledDelay(await failWithCorruptHead(publisher, 'wallet-1'))).toBe(120);
  });

  it('schedules the exact exponential delay when the jitter ratio is zero', async () => {
    const publisher = createCorruptHeadPublisher({
      retryBackoffBaseMs: 100,
      retryBackoffMaxMs: 100_000,
      retryJitterRatio: 0,
      rand: () => 1,
    });
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    expect(scheduledDelay(await failWithCorruptHead(publisher, 'wallet-1'))).toBe(100);
  });

  // Jitter is applied BEFORE the cap, so `retryBackoffMaxMs` remains a hard ceiling: at the cap
  // the upward jitter is clamped away (120 → 100) while the downward jitter still shortens the
  // wait (80). Jittering after the cap would schedule 120 here.
  it('clamps upward jitter at retryBackoffMaxMs and still jitters below it', async () => {
    for (const { rand, expected } of [{ rand: 1, expected: 100 }, { rand: 0, expected: 80 }]) {
      store = new OxigraphStore();
      const publisher = createCorruptHeadPublisher({
        retryBackoffBaseMs: 100,
        retryBackoffMaxMs: 100,
        retryJitterRatio: 0.2,
        rand: () => rand,
      });
      await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      expect([rand, scheduledDelay(await failWithCorruptHead(publisher, 'wallet-1'))])
        .toEqual([rand, expected]);
    }
  });

  it('rejects a retryJitterRatio outside [0, 1)', () => {
    for (const retryJitterRatio of [1, 1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createPublisher({ retryJitterRatio })).toThrow(
        'Async lift publisher.retryJitterRatio must be a number at least 0 and below 1',
      );
    }
  });

  it('the exported resolver rejects a non-object input directly', () => {
    expect(() => resolveAsyncLiftRetryTuning('12000', 'publisher'))
      .toThrow('publisher must be an object (received "12000")');
    expect(() => resolveAsyncLiftRetryTuning([], 'publisher'))
      .toThrow('publisher must be an object');
  });

  it('rejects a non-boolean autoRetryEnabled instead of silently enabling the lane', () => {
    // The string "false" is truthy: trusting it would keep the automatic lane
    // ON under a config that reads as disabled.
    for (const autoRetryEnabled of ['false', 0, 1, 'true', null]) {
      expect(() => createPublisher({ autoRetryEnabled: autoRetryEnabled as never })).toThrow(
        'Async lift publisher.autoRetryEnabled must be a boolean',
      );
    }
  });

  it('never schedules an immediate retry: jittered backoff is floored at 1ms', async () => {
    // A tiny base with strong downward jitter used to round to 0 — an
    // immediate reaccept that burns the budget in a tight loop.
    const publisher = createCorruptHeadPublisher({
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 10,
      retryJitterRatio: 0.9,
      rand: () => 0,
    });
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const failed = await failWithCorruptHead(publisher, 'wallet-1');
    expect(scheduledDelay(failed)).toBeGreaterThanOrEqual(1);
  });

  // (h) The kill-switch gates ONLY the automatic lane: with it off, the
  // operator's retry() and a client's byte-identical re-submit both still
  // reaccept the SAME job — the documented manual fallbacks stay available.
  it('manual retry() and re-submit reaccept still work while autoRetryEnabled is false', async () => {
    const publisher = createCorruptHeadPublisher({ autoRetryEnabled: false });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await failWithCorruptHead(publisher, 'wallet-1');

    const retried = await publisher.retry({ status: 'failed' });
    expect(retried).toBe(1);
    let job = await publisher.getStatus(jobId);
    expect(job?.status).toBe('accepted');
    expect(job?.retries.retryCount).toBe(1);

    await failWithCorruptHead(publisher, 'wallet-1');
    const resubmittedId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    expect(resubmittedId).toBe(jobId);
    job = await publisher.getStatus(jobId);
    expect(job?.status).toBe('accepted');
    expect(job?.retries.retryCount).toBe(2);
  });

  // (d) The kill-switch, at BOTH call sites and in both polarities.
  it('schedules no retry while autoRetryEnabled is false', async () => {
    const publisher = createCorruptHeadPublisher({ autoRetryEnabled: false });
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    const failed = await failWithCorruptHead(publisher, 'wallet-1');

    expect(failed.timestamps.nextRetryAt).toBeUndefined();
    expect(failed.failure.retryable).toBe(true);
  });

  it('strands an already-scheduled due job while disabled and releases it once re-enabled', async () => {
    const enabled = createCorruptHeadPublisher({ retryBackoffBaseMs: 100, retryBackoffMaxMs: 250, rand: () => 0.5 });
    const jobId = await enabled.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const failed = await failWithCorruptHead(enabled, 'wallet-1');
    expect(scheduledDelay(failed)).toBe(100);
    now += 1_000;

    const disabled = createCorruptHeadPublisher({ autoRetryEnabled: false });
    expect(await disabled.claimNext('wallet-2')).toBeNull();
    const stranded = await disabled.getStatus(jobId);
    expect(stranded?.status).toBe('failed');
    expect(stranded?.retries.retryCount).toBe(0);
    expect(stranded?.timestamps.nextRetryAt).toBeDefined();

    const reEnabled = createCorruptHeadPublisher({ retryBackoffBaseMs: 100, retryBackoffMaxMs: 250, rand: () => 0.5 });
    const released = await reEnabled.claimNext('wallet-3');

    expect(released?.jobId).toBe(jobId);
    expect(released?.status).toBe('claimed');
    expect(released?.retries.retryCount).toBe(1);
  });

  // (e) The budget is terminal for the automatic lane: nothing is scheduled once it is spent, so
  // the sweep can never pick the job up again.
  it('stops scheduling once the retry budget is exhausted', async () => {
    const publisher = createCorruptHeadPublisher({
      maxRetries: 1,
      retryBackoffBaseMs: 100,
      retryBackoffMaxMs: 250,
      rand: () => 0.5,
    });
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    expect(scheduledDelay(await failWithCorruptHead(publisher, 'wallet-1'))).toBe(100);
    now += 100;
    const exhausted = await failWithCorruptHead(publisher, 'wallet-2');

    expect(exhausted.retries.retryCount).toBe(1);
    expect(exhausted.timestamps.nextRetryAt).toBeUndefined();
    now += 10_000;
    expect(await publisher.claimNext('wallet-3')).toBeNull();
    expect((await publisher.getStats()).failed).toBe(1);
  });

  // (f) The schedule lives in the store, not in the process: a publisher recreated over the same
  // store fires the pending retry exactly once — it is neither lost nor duplicated.
  it('fires a pending retry exactly once across a publisher restart', async () => {
    const first = createCorruptHeadPublisher({ retryBackoffBaseMs: 100, retryBackoffMaxMs: 250, rand: () => 0.5 });
    const jobId = await first.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await failWithCorruptHead(first, 'wallet-1');
    now += 100;

    const restarted = createCorruptHeadPublisher({ retryBackoffBaseMs: 100, retryBackoffMaxMs: 250, rand: () => 0.5 });
    const claimed = await restarted.claimNext('wallet-2');

    expect(claimed?.jobId).toBe(jobId);
    expect(claimed?.retries.retryCount).toBe(1);
    expect(claimed?.timestamps.nextRetryAt).toBeUndefined();

    const third = createCorruptHeadPublisher({ retryBackoffBaseMs: 100, retryBackoffMaxMs: 250, rand: () => 0.5 });
    expect(await third.claimNext('wallet-3')).toBeNull();
    expect((await third.getStatus(jobId))?.retries.retryCount).toBe(1);
    // One job, one reaccept: the restart neither dropped the schedule nor queued a second copy.
    const stats = await third.getStats();
    expect([stats.accepted, stats.claimed, stats.failed]).toEqual([0, 1, 0]);
  });

  // (g) Allow-list polarity: `rpc_unavailable` is retryable but NOT allow-listed (it is the
  // broadcast-phase catch-all, so a landed transaction can arrive under it). This is the unit-lane
  // twin of the shipped `nextRetryAt` pin in async-lift-publisher.test.ts.
  it('never schedules a retry for a post-send rpc_unavailable failure', async () => {
    const publisher = createPublisher({ retryBackoffBaseMs: 100, retryBackoffMaxMs: 250, rand: () => 0.5 });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: `0x${'ab'.repeat(32)}`, walletId: 'wallet-1' },
    });

    const failed = await publisher.recordPublishFailure(jobId, {
      error: new Error('RPC endpoint temporarily unavailable'),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:dkg:test:error:rpc-unavailable',
    });

    expect(failed.status).toBe('failed');
    expect(failed.failure?.code).toBe('rpc_unavailable');
    expect(failed.failure?.retryable).toBe(true);
    expect(failed.timestamps.nextRetryAt).toBeUndefined();
    now += 10_000;
    expect(await publisher.claimNext('wallet-2')).toBeNull();
    expect((await publisher.getStats()).failed).toBe(1);
  });

  // The per-sweep reaccept cap: the sweep runs inside the claim lock, so a burst of due retries
  // (the shape a re-enabled kill-switch produces) must not be reaccepted in one pass. No job is
  // lost — the remainder is past due, so the next sweep takes it.
  it('reaccepts at most five due retries per sweep and takes the rest on the next sweep', async () => {
    const publisher = createCorruptHeadPublisher({ retryBackoffBaseMs: 100, retryBackoffMaxMs: 250, rand: () => 0.5 });
    for (let i = 0; i < 6; i += 1) {
      await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
        name: `album-${i}`,
        shareOperationId: `share-op-${i}`,
        intentKey: `sha256:${i.toString().repeat(64)}`,
      }));
    }
    for (let i = 0; i < 6; i += 1) {
      await failWithCorruptHead(publisher, `wallet-fail-${i}`);
    }
    expect((await publisher.getStats()).failed).toBe(6);
    now += 10_000;

    await publisher.claimNext('wallet-sweep-1');
    const afterFirstSweep = await publisher.getStats();
    await publisher.claimNext('wallet-sweep-2');
    const afterSecondSweep = await publisher.getStats();

    expect(afterFirstSweep.failed).toBe(1);
    expect(afterSecondSweep.failed).toBe(0);
  });
});
