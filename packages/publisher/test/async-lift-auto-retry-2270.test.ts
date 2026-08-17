import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  QuorumUnmetError,
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
  type KnowledgeAssetVmPublishRequest,
  type LiftJob,
  type LiftJobHex,
  resolveAsyncLiftRetryTuning,
} from '../src/index.js';
import {
  hasBroadcastEvidence,
  isHeldForChainProof,
  resetFailedLiftJobToAccepted,
  type PersistedFailedJob,
} from '../src/async-lift-publisher-utils.js';
import {
  classifyRetryAction,
  describeRetryProjection,
} from '../src/async-lift-retry-disposition.js';
import {
  DEFAULT_CONTROL_GRAPH_URI,
  jobSubject,
  serializeJob,
} from '../src/async-lift-control-plane.js';
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

  it('keeps jitter alive at the cap: deep retries spread below retryBackoffMaxMs', async () => {
    // Jitter-before-cap collapsed every deep retry to exactly the cap —
    // synchronized herds precisely where de-synchronization matters most.
    // With the capped value jittered, rand()=0 lands at max·(1−r).
    const publisher = createCorruptHeadPublisher({
      retryBackoffBaseMs: 100,
      retryBackoffMaxMs: 200,
      retryJitterRatio: 0.2,
      rand: () => 0,
      maxRetries: 6,
    });
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    let failed = await failWithCorruptHead(publisher, 'wallet-1');
    // Drive retries until the exponential is far past the cap.
    for (let i = 0; i < 3; i += 1) {
      now += scheduledDelay(failed)! + 1;
      failed = await failWithCorruptHead(publisher, 'wallet-1');
    }
    // exponential = 100·2^3 = 800 >> cap 200; jittered(200) at rand 0 = 160.
    expect(failed.retries.retryCount).toBe(3);
    expect(scheduledDelay(failed)).toBe(160);
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

  // ─────────────────────────────────────────────────────────────────────────────────────────
  // Evidence-safe manual paths (PR-2). No path — sweep, retry(), or admission re-submit —
  // reaccepts a failed job that may already have submitted a transaction; the pre-send-safe
  // failures the automatic lane exists for keep reaccepting exactly as before.
  // ─────────────────────────────────────────────────────────────────────────────────────────

  const TX_HASH = `0x${'ab'.repeat(32)}` as LiftJobHex;

  function expectFailed(job: LiftJob | null): PersistedFailedJob {
    if (!job || job.status !== 'failed') {
      throw new Error(`expected a failed job, got ${job?.status ?? 'null'}`);
    }
    return job;
  }

  /**
   * The landed-transaction-recorded-locally-as-failed shape: a durably recorded broadcast
   * txHash plus the broadcast-phase catch-all code (`rpc_unavailable`, `reset_to_accepted`).
   *
   * Like its siblings below it drives the job it enqueued via `claimNext`, which takes the
   * OLDEST accepted job — so a caller must not leave another job sitting in 'accepted'.
   */
  async function failAfterRecordedTxHash(
    publisher: TripleStoreAsyncLiftPublisher,
    request: KnowledgeAssetVmPublishRequest = kaVmPublishRequest(),
  ): Promise<PersistedFailedJob> {
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    const walletId = `wallet-tx-${jobId}`;
    await publisher.claimNext(walletId);
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId } });
    return expectFailed(await publisher.recordPublishFailure(jobId, {
      error: new Error('RPC endpoint temporarily unavailable'),
      failedFromState: 'broadcast',
      errorPayloadRef: `urn:dkg:test:error:${jobId}`,
    }));
  }

  /** A pre-send-safe failure: quorum is collected before the publish tx is signed, so no txHash. */
  async function failWithUnmetQuorum(
    publisher: TripleStoreAsyncLiftPublisher,
    request: KnowledgeAssetVmPublishRequest = kaVmPublishRequest(),
  ): Promise<PersistedFailedJob> {
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    await publisher.claimNext(`wallet-quorum-${jobId}`);
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    return expectFailed(await publisher.recordPublishFailure(jobId, {
      error: new QuorumUnmetError({ collected: 2, required: 3, dialled: 2 }),
      failedFromState: 'broadcast',
      errorPayloadRef: `urn:dkg:test:error:${jobId}`,
    }));
  }

  /**
   * A TERMINAL (non-retryable) broadcast-phase failure. `recordTxHash` decides whether it carries
   * transaction evidence — the only difference that matters to the bulk-clear guard.
   */
  async function failWithRevert(
    publisher: TripleStoreAsyncLiftPublisher,
    request: KnowledgeAssetVmPublishRequest,
    options: { readonly recordTxHash: boolean },
  ): Promise<PersistedFailedJob> {
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    const walletId = `wallet-revert-${jobId}`;
    await publisher.claimNext(walletId);
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    if (options.recordTxHash) {
      await publisher.update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId } });
    }
    return expectFailed(await publisher.recordPublishFailure(jobId, {
      error: new Error('execution reverted'),
      failedFromState: 'broadcast',
      errorPayloadRef: `urn:dkg:test:error:${jobId}`,
    }));
  }

  /** A confirmation-phase failure recorded from 'included' — a job that certainly sent a tx. */
  async function failFromIncluded(
    publisher: TripleStoreAsyncLiftPublisher,
    request: KnowledgeAssetVmPublishRequest = kaVmPublishRequest(),
  ): Promise<PersistedFailedJob> {
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    const walletId = `wallet-inc-${jobId}`;
    await publisher.claimNext(walletId);
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId } });
    await publisher.update(jobId, 'included', {
      broadcast: { txHash: TX_HASH, walletId },
      inclusion: { txHash: TX_HASH, blockNumber: 42 },
    });
    return expectFailed(await publisher.recordPublishFailure(jobId, {
      error: new Error('on-chain confirmation mismatch'),
      failedFromState: 'included',
      errorPayloadRef: `urn:dkg:test:error:${jobId}`,
    }));
  }

  it('reads transaction evidence from every carrier, and from none for a pre-send failure', async () => {
    const publisher = createPublisher();
    const broadcastFailure = await failAfterRecordedTxHash(publisher);
    const quorumFailure = await failWithUnmetQuorum(publisher, kaVmPublishRequest({
      name: 'quorum-album',
      shareOperationId: 'quorum-op',
      intentKey: `sha256:${'cd'.repeat(32)}`,
    }));
    const includedFailure = await failFromIncluded(publisher, kaVmPublishRequest({
      name: 'included-album',
      shareOperationId: 'included-op',
      intentKey: `sha256:${'ef'.repeat(32)}`,
    }));

    expect([
      // Live broadcast metadata — the carrier the landed-tx case leaves behind.
      hasBroadcastEvidence(broadcastFailure),
      // The recovery carrier: a reset drops broadcast metadata but keeps the hash it checked,
      // so a job re-failing later from a pre-send state still reads as evidence-bearing.
      hasBroadcastEvidence({
        ...quorumFailure,
        recovery: { action: 'reset_to_accepted', recoveredFromStatus: 'broadcast', txHashChecked: TX_HASH },
      }),
      // An 'included' origin, isolated from both hash carriers: inclusion implies a transaction.
      hasBroadcastEvidence({ ...includedFailure, broadcast: undefined } as unknown as PersistedFailedJob),
      // Pre-send-safe: `quorum_unmet` is allowed from 'broadcast' yet persists no hash, so a
      // state-keyed predicate would strand the GH#1620 lane this must leave alone.
      hasBroadcastEvidence(quorumFailure),
    ]).toEqual([true, true, true, false]);
    expect([broadcastFailure.failure.code, quorumFailure.failure.code, includedFailure.failure.code])
      .toEqual(['rpc_unavailable', 'quorum_unmet', 'confirmation_mismatch']);
  });

  it('reports an evidence-bearing failed job as blocked instead of reaccepting it', async () => {
    const publisher = createPublisher();
    const failed = await failAfterRecordedTxHash(publisher);

    // Both entry points share one implementation, so neither can be the unsafe one.
    expect(await publisher.retryDetailed({ status: 'failed' }))
      .toEqual({ retried: 0, blockedPendingRecovery: 1, skipped: 0 });
    expect(await publisher.retry({ status: 'failed' })).toBe(0);

    const after = await publisher.getStatus(failed.jobId);
    expect(after?.status).toBe('failed');
    expect(after?.retries.retryCount).toBe(0);
  });

  it('reaccepts a pre-send-safe failed job and partitions the rest into blocked and skipped', async () => {
    const publisher = createPublisher();
    const retryable = await failWithUnmetQuorum(publisher);
    const blocked = await failAfterRecordedTxHash(publisher, kaVmPublishRequest({
      name: 'blocked-album',
      shareOperationId: 'blocked-op',
      intentKey: `sha256:${'cd'.repeat(32)}`,
    }));
    // Terminal (non-retryable) and evidence-free: nothing to reaccept, nothing to prove on chain.
    const terminalJobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      name: 'terminal-album',
      shareOperationId: 'terminal-op',
      intentKey: `sha256:${'ef'.repeat(32)}`,
    }));
    await publisher.claimNext('wallet-terminal');
    await publisher.update(terminalJobId, 'validated', { validation: KA_VM_VALIDATION });
    const terminal = expectFailed(await publisher.recordPublishFailure(terminalJobId, {
      error: new Error('execution reverted'),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:dkg:test:error:terminal',
    }));
    expect([terminal.failure.code, terminal.failure.retryable]).toEqual(['tx_reverted', false]);

    // The counts and the per-job projection are ONE partition, not two opinions: retried ↔
    // backoff/operator, blocked ↔ recovery/pending_chain_proof, skipped ↔ exhausted/no reason.
    expect([retryable, blocked, terminal].map((job) => publisher.describeJobRetryState(job))).toEqual([
      { autoRetryEligible: true, waitingReason: 'backoff' },
      { autoRetryEligible: false, waitingReason: 'pending_chain_proof' },
      { autoRetryEligible: false },
    ]);
    expect(await publisher.retryDetailed())
      .toEqual({ retried: 1, blockedPendingRecovery: 1, skipped: 1 });
    expect((await publisher.getStatus(retryable.jobId))?.status).toBe('accepted');
    expect((await publisher.getStatus(blocked.jobId))?.status).toBe('failed');
    expect((await publisher.getStatus(terminalJobId))?.status).toBe('failed');
  });

  it('counts a spent retry budget as skipped and a recovery-owned job as blocked', async () => {
    const publisher = createCorruptHeadPublisher({ maxRetries: 1, retryBackoffBaseMs: 100, retryBackoffMaxMs: 250, rand: () => 0.5 });
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await failWithCorruptHead(publisher, 'wallet-1');
    now += 100;
    const exhausted = await failWithCorruptHead(publisher, 'wallet-2');
    expect(exhausted.retries.retryCount).toBe(1);

    expect(await publisher.retryDetailed())
      .toEqual({ retried: 0, blockedPendingRecovery: 0, skipped: 1 });

    // `retry_recovery` jobs belong to the recovery lane, which re-checks them forever and
    // off-budget — reported as blocked rather than skipped, because what holds them is a possible
    // transaction. Only that resolution is rewritten here: the code path under test reads it off
    // the persisted job, and no production producer of a recovery-phase failure is reachable from
    // this pure-unit harness.
    const recoveryOwned = {
      ...exhausted,
      retries: { ...exhausted.retries, retryCount: 0 },
      failure: { ...exhausted.failure, code: 'recovery_lookup_timeout', resolution: 'retry_recovery' },
    } as LiftJob;
    await store.deleteByPattern({ subject: jobSubject(exhausted.jobId), graph: DEFAULT_CONTROL_GRAPH_URI });
    await store.insert(serializeJob(recoveryOwned, DEFAULT_CONTROL_GRAPH_URI));

    expect(await publisher.retryDetailed())
      .toEqual({ retried: 0, blockedPendingRecovery: 1, skipped: 0 });
    expect(publisher.describeJobRetryState(recoveryOwned))
      .toEqual({ autoRetryEligible: false, waitingReason: 'recovery' });
    expect((await publisher.getStatus(exhausted.jobId))?.status).toBe('failed');
  });

  it('reaccepts an exhausted pre-send-safe job on a fresh client mandate with the budget re-armed', async () => {
    // The issue's hard requirement: a client re-submit NEVER creates a replacement job. The
    // subject stays bound to the same jobId, and the fresh mandate re-arms exactly one budget.
    const publisher = createCorruptHeadPublisher({ maxRetries: 1, retryBackoffBaseMs: 100, retryBackoffMaxMs: 250, rand: () => 0.5 });
    const request = kaVmPublishRequest();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    await failWithCorruptHead(publisher, 'wallet-1');
    now += 100;
    const exhausted = await failWithCorruptHead(publisher, 'wallet-2');
    expect([exhausted.retries.retryCount, exhausted.timestamps.nextRetryAt]).toEqual([1, undefined]);

    const resubmitted = await publisher.enqueueKnowledgeAssetVmPublish(request);

    expect(resubmitted).toBe(jobId);
    const reaccepted = await publisher.getStatus(jobId);
    expect(reaccepted?.status).toBe('accepted');
    expect(reaccepted?.retries.retryCount).toBe(0);
    expect(reaccepted?.retries.maxRetries).toBe(1);
    // One job for the subject, not two: the re-armed budget did not mint a successor.
    const stats = await publisher.getStats();
    expect([stats.accepted, stats.failed]).toEqual([1, 0]);
    // And the re-armed budget is real: the lane schedules another retry for the same job.
    const failedAgain = await failWithCorruptHead(publisher, 'wallet-3');
    expect([failedAgain.jobId, scheduledDelay(failedAgain)]).toEqual([jobId, 100]);
  });

  it('refuses a fresh mandate for an evidence-bearing job, exhausted or not', async () => {
    const publisher = createPublisher({ maxRetries: 1 });
    const request = kaVmPublishRequest();
    const failed = await failAfterRecordedTxHash(publisher, request);
    expect(failed.retries.retryCount).toBe(0);

    await expect(publisher.enqueueKnowledgeAssetVmPublish(request)).rejects.toMatchObject({
      name: 'LiftJobPendingChainProofError',
      code: 'LIFT_JOB_PENDING_CHAIN_PROOF',
      existingJobId: failed.jobId,
    });
    // Untouched AND still bound to its subject — a refusal that let the subject fall vacant
    // would mint a replacement job for a lifecycle that may have a transaction in flight.
    const after = await publisher.getStatus(failed.jobId);
    expect(after?.status).toBe('failed');
    expect(after?.retries.retryCount).toBe(0);
    expect((await publisher.getStats()).accepted).toBe(0);
  });

  it('keeps the transaction hash across a reset from every origin state that can carry one', async () => {
    const publisher = createPublisher();
    const includedFailure = await failFromIncluded(publisher);
    const broadcastFailure = await failAfterRecordedTxHash(publisher, kaVmPublishRequest({
      name: 'broadcast-album',
      shareOperationId: 'broadcast-op',
      intentKey: `sha256:${'cd'.repeat(32)}`,
    }));
    const quorumFailure = await failWithUnmetQuorum(publisher, kaVmPublishRequest({
      name: 'quorum-album',
      shareOperationId: 'quorum-op',
      intentKey: `sha256:${'ef'.repeat(32)}`,
    }));

    // The 'included' origin was the gap: it was not in the allow-list, so the reset recorded no
    // recovery at all and the persisted hash went with it.
    expect(resetFailedLiftJobToAccepted(includedFailure, 9_000).recovery).toEqual({
      action: 'reset_to_accepted',
      recoveredFromStatus: 'included',
      txHashChecked: TX_HASH,
    });
    expect(resetFailedLiftJobToAccepted(broadcastFailure, 9_000).recovery).toEqual({
      action: 'reset_to_accepted',
      recoveredFromStatus: 'broadcast',
      txHashChecked: TX_HASH,
    });
    // A pre-send failure records its origin with no hash to carry — there is no evidence to keep.
    expect(resetFailedLiftJobToAccepted(quorumFailure, 9_000).recovery).toEqual({
      action: 'reset_to_accepted',
      recoveredFromStatus: 'broadcast',
      txHashChecked: undefined,
    });
  });

  it('drops the retry schedule by rebuilding the timestamps, never by clearing a field', async () => {
    const publisher = createCorruptHeadPublisher({ retryBackoffBaseMs: 100, retryBackoffMaxMs: 250, rand: () => 0.5 });
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const failed = await failWithCorruptHead(publisher, 'wallet-1');
    expect(failed.timestamps.nextRetryAt).toBeDefined();

    const reset = resetFailedLiftJobToAccepted(failed, 9_000);

    expect(reset.timestamps).toEqual({
      acceptedAt: failed.timestamps.acceptedAt,
      lastRecoveredAt: 9_000,
      lastRetriedAt: 9_000,
      updatedAt: 9_000,
    });
  });

  it('projects why each failed job is not moving', async () => {
    const publisher = createCorruptHeadPublisher({ maxRetries: 2, retryBackoffBaseMs: 100, retryBackoffMaxMs: 250, rand: () => 0.5 });
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const scheduled = await failWithCorruptHead(publisher, 'wallet-1');
    const evidenceBearing = await failAfterRecordedTxHash(publisher, kaVmPublishRequest({
      name: 'evidence-album',
      shareOperationId: 'evidence-op',
      intentKey: `sha256:${'cd'.repeat(32)}`,
    }));
    // Enqueued LAST: the fixtures above claim the oldest accepted job, so a job left sitting in
    // 'accepted' would be the one they drive.
    const acceptedJobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      name: 'accepted-album',
      shareOperationId: 'accepted-op',
      intentKey: `sha256:${'ef'.repeat(32)}`,
    }));

    expect([
      // The publisher's own lane owns it and will fire at nextRetryAt.
      publisher.describeJobRetryState(scheduled),
      // A transaction may exist: never eligible, whatever the registry says about the code.
      publisher.describeJobRetryState(evidenceBearing),
      // Retryable, evidence-free, budget left — but nothing automatic moves a non-allow-listed
      // code; an operator or a client re-submit must.
      publisher.describeJobRetryState({
        ...evidenceBearing,
        broadcast: undefined,
        failure: { ...evidenceBearing.failure, failedFromState: 'validated' },
      } as unknown as LiftJob),
      // Budget spent: only a fresh client mandate re-arms it.
      publisher.describeJobRetryState({ ...scheduled, retries: { ...scheduled.retries, retryCount: 2 } }),
      // A terminal failure is not waiting for anything.
      publisher.describeJobRetryState({
        ...scheduled,
        failure: { ...scheduled.failure, code: 'publish_intent_stale', retryable: false, resolution: 'fail_job' },
      }),
      // A job that has not failed has no retry projection at all.
      publisher.describeJobRetryState((await publisher.getStatus(acceptedJobId))!),
    ]).toEqual([
      { autoRetryEligible: true, waitingReason: 'backoff' },
      { autoRetryEligible: false, waitingReason: 'pending_chain_proof' },
      { autoRetryEligible: false, waitingReason: 'operator' },
      { autoRetryEligible: false, waitingReason: 'exhausted' },
      { autoRetryEligible: false },
      { autoRetryEligible: false },
    ]);
  });

  it('projects an allow-listed job as operator-driven while the kill-switch is off', async () => {
    // The projection reads the lane's OWN effective switch, so it cannot report a retry the
    // publisher will never perform (the #1836 class of divergence).
    const enabled = createCorruptHeadPublisher({ retryBackoffBaseMs: 100, retryBackoffMaxMs: 250, rand: () => 0.5 });
    await enabled.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const failed = await failWithCorruptHead(enabled, 'wallet-1');

    expect(enabled.describeJobRetryState(failed)).toEqual({ autoRetryEligible: true, waitingReason: 'backoff' });
    expect(createCorruptHeadPublisher({ autoRetryEnabled: false }).describeJobRetryState(failed))
      .toEqual({ autoRetryEligible: false, waitingReason: 'operator' });
  });

  // Bulk cleanup must not undo the admission guard. While an evidence-bearing job EXISTS,
  // admission answers pending-chain-proof; delete it and the very next re-submit mints a fresh
  // job for the same KA — a second publish for a transaction nobody has accounted for.
  it('refuses to bulk-clear a failed job that still holds its subject pending chain proof', async () => {
    const publisher = createPublisher();
    const request = kaVmPublishRequest();
    const failed = await failAfterRecordedTxHash(publisher, request);

    expect(await publisher.clear('failed')).toBe(0);
    expect((await publisher.getStatus(failed.jobId))?.status).toBe('failed');
    // The property the guard exists for: the subject is still bound, so admission still refuses.
    await expect(publisher.enqueueKnowledgeAssetVmPublish(request)).rejects.toMatchObject({
      code: 'LIFT_JOB_PENDING_CHAIN_PROOF',
      existingJobId: failed.jobId,
    });

    // Bulk is safe by DEFAULT, not locked: naming the exact job still clears it, and that
    // targeted call is where an operator takes the decision knowingly.
    expect(await publisher.clearTerminalJob(failed.jobId)).toEqual({ outcome: 'cleared' });
    expect(await publisher.getStatus(failed.jobId)).toBeNull();
  });

  it('still bulk-clears failed jobs with no transaction to account for', async () => {
    const publisher = createPublisher();
    await failWithUnmetQuorum(publisher);
    await failWithRevert(publisher, kaVmPublishRequest({
      name: 'revert-album',
      shareOperationId: 'revert-op',
      intentKey: `sha256:${'cd'.repeat(32)}`,
    }), { recordTxHash: false });

    expect(await publisher.clear('failed')).toBe(2);
    expect((await publisher.getStats()).failed).toBe(0);
  });

  it('still bulk-clears a tx-bearing failed job whose subject is already superseded', async () => {
    // The occupancy conjunct of the guard, isolated: a NON-retryable failure no longer holds its
    // lifecycle subject, so refusing to clear it would prevent nothing — admission already mints
    // a new job for that KA — while leaving terminal diagnoses in the queue forever. The
    // transaction hash is not lost either way: the #1829 journal is append-only.
    const publisher = createPublisher({ journalWrites: true });
    const superseded = await failWithRevert(publisher, kaVmPublishRequest(), { recordTxHash: true });
    expect([superseded.failure.code, superseded.failure.retryable]).toEqual(['tx_reverted', false]);
    expect(hasBroadcastEvidence(superseded)).toBe(true);

    expect(await publisher.clear('failed')).toBe(1);
    expect(await publisher.getStatus(superseded.jobId)).toBeNull();
    const journal = await publisher.readJournalByJob(superseded.jobId);
    expect(journal.txHashes).toContain(TX_HASH);
  });

  // The action IS the partition: both consumers read this one function, so a divergence between
  // the counts a retry reports and the reason a job shows is not expressible.
  it('classifies each disposition once, for both the retry counts and the projection', async () => {
    const publisher = createPublisher();
    const reaccept = await failWithUnmetQuorum(publisher);
    const blocked = await failAfterRecordedTxHash(publisher, kaVmPublishRequest({
      name: 'blocked-album',
      shareOperationId: 'blocked-op',
      intentKey: `sha256:${'cd'.repeat(32)}`,
    }));
    const skip = await failWithRevert(publisher, kaVmPublishRequest({
      name: 'skip-album',
      shareOperationId: 'skip-op',
      intentKey: `sha256:${'ef'.repeat(32)}`,
    }), { recordTxHash: false });
    const options = { autoRetryEnabled: true };

    expect([reaccept, blocked, skip].map((job) => classifyRetryAction(job)))
      .toEqual(['reaccept', 'blocked_pending_chain_proof', 'skip_terminal']);
    // The two consumers, on the same three jobs: one count per action, and the projection each
    // job reports is the one derived from the action the classifier assigned it.
    expect([reaccept, blocked, skip].map((job) => publisher.describeJobRetryState(job)))
      .toEqual([reaccept, blocked, skip].map((job) => describeRetryProjection(job, options)));
    expect([reaccept, blocked, skip].map((job) => describeRetryProjection(job, options))).toEqual([
      { autoRetryEligible: true, waitingReason: 'backoff' },
      { autoRetryEligible: false, waitingReason: 'pending_chain_proof' },
      { autoRetryEligible: false },
    ]);
    expect(await publisher.retryDetailed())
      .toEqual({ retried: 1, blockedPendingRecovery: 1, skipped: 1 });
  });

  it('decides the retry action without the operator kill-switch as an input', async () => {
    // The write path cannot depend on the read knob: `classifyRetryAction` takes the job alone,
    // so flipping `autoRetryEnabled` moves ONLY the projection's reason (backoff ↔ operator).
    const publisher = createPublisher();
    const job = await failWithUnmetQuorum(publisher);

    expect(classifyRetryAction(job)).toBe('reaccept');
    expect([
      describeRetryProjection(job, { autoRetryEnabled: true }),
      describeRetryProjection(job, { autoRetryEnabled: false }),
    ]).toEqual([
      { autoRetryEligible: true, waitingReason: 'backoff' },
      { autoRetryEligible: false, waitingReason: 'operator' },
    ]);
  });

  // A TERMINAL diagnosis over a transaction nobody has accounted for is the case that reopened
  // the double publish: `confirmation_mismatch` is non-retryable, so its subject used to fall
  // vacant and the next re-submit minted a second job for the same KA. Every surface now holds
  // it: admission, the retry pass, the projection and bulk clear.
  it('holds a terminal failure whose transaction is unaccounted for, on every surface', async () => {
    const publisher = createPublisher({ journalWrites: true });
    const request = kaVmPublishRequest();
    const held = await failFromIncluded(publisher, request);
    expect([held.failure.code, held.failure.retryable]).toEqual(['confirmation_mismatch', false]);
    expect(isHeldForChainProof(held)).toBe(true);

    expect(publisher.describeJobRetryState(held))
      .toEqual({ autoRetryEligible: false, waitingReason: 'pending_chain_proof' });
    expect(await publisher.retryDetailed())
      .toEqual({ retried: 0, blockedPendingRecovery: 1, skipped: 0 });
    // The bot's scenario: a re-submit must not mint a replacement job for this KA.
    await expect(publisher.enqueueKnowledgeAssetVmPublish(request)).rejects.toMatchObject({
      code: 'LIFT_JOB_PENDING_CHAIN_PROOF',
      existingJobId: held.jobId,
    });
    expect(await publisher.clear('failed')).toBe(0);
    expect((await publisher.getStatus(held.jobId))?.status).toBe('failed');

    // The operator's explicit exit still works, and clearing does not destroy the evidence: the
    // #1829 journal keeps the txHash after the job record is gone.
    expect(await publisher.clearTerminalJob(held.jobId)).toEqual({ outcome: 'cleared' });
    expect(await publisher.getStatus(held.jobId)).toBeNull();
    expect((await publisher.readJournalByJob(held.jobId)).txHashes).toContain(TX_HASH);
  });

  it('lets a failure that proves its transaction had no effect supersede and clear', async () => {
    // The exception that keeps the hold honest. `tx_reverted` (the receipt says it published
    // nothing) and `insufficient_funds` (refused before it entered the mempool) carry a txHash
    // but nothing to account for — so they stay skippable, supersedable and clearable, and a
    // client can re-submit the KA (the wallet-top-up case) instead of waiting for proof that
    // will never come.
    for (const message of ['execution reverted', 'insufficient funds for gas']) {
      store = new OxigraphStore();
      const publisher = createPublisher();
      const request = kaVmPublishRequest();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
      await publisher.claimNext('wallet-1');
      await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      await publisher.update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId: 'wallet-1' } });
      const proven = expectFailed(await publisher.recordPublishFailure(jobId, {
        error: new Error(message),
        failedFromState: 'broadcast',
        errorPayloadRef: 'urn:dkg:test:error:proven',
      }));

      expect([message, hasBroadcastEvidence(proven), isHeldForChainProof(proven)])
        .toEqual([message, true, false]);
      expect([message, publisher.describeJobRetryState(proven)])
        .toEqual([message, { autoRetryEligible: false }]);
      expect([message, await publisher.retryDetailed()])
        .toEqual([message, { retried: 0, blockedPendingRecovery: 0, skipped: 1 }]);
      // Superseded: the KA is publishable again under a NEW job, which is the whole point of
      // proving the transaction had no effect.
      const resubmitted = await publisher.enqueueKnowledgeAssetVmPublish(request);
      expect([message, resubmitted === jobId]).toEqual([message, false]);
    }
  });

  it('bulk-clears a failure proven to have had no effect, even with a transaction hash', async () => {
    const publisher = createPublisher();
    const proven = await failWithRevert(publisher, kaVmPublishRequest(), { recordTxHash: true });
    expect([proven.failure.code, hasBroadcastEvidence(proven), isHeldForChainProof(proven)])
      .toEqual(['tx_reverted', true, false]);

    expect(await publisher.clear('failed')).toBe(1);
    expect(await publisher.getStatus(proven.jobId)).toBeNull();
  });

  it('reaccepts the same jobs by hand whether or not the automatic lane is switched on', async () => {
    // The ACTION is independent of `autoRetryEnabled` by construction (both 'backoff' and
    // 'operator' reaccept), so the kill-switch can never change what an operator's retry does.
    for (const autoRetryEnabled of [true, false]) {
      store = new OxigraphStore();
      const publisher = createPublisher({ autoRetryEnabled });
      await failWithUnmetQuorum(publisher);

      expect([autoRetryEnabled, await publisher.retryDetailed()])
        .toEqual([autoRetryEnabled, { retried: 1, blockedPendingRecovery: 0, skipped: 0 }]);
    }
  });
});
