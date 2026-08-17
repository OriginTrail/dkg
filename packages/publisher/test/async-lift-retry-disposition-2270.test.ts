import { beforeEach, describe, expect, it } from 'vitest';
import { type LiftJob } from '../src/index.js';
import {
  resetFailedLiftJobToAccepted,
  type PersistedFailedJob,
} from '../src/async-lift-publisher-utils.js';
import {
  classifyRetryAction,
  describeRetryProjection,
  hasBroadcastEvidence,
} from '../src/async-lift-retry-disposition.js';
import {
  DEFAULT_CONTROL_GRAPH_URI,
  jobSubject,
  serializeJob,
} from '../src/async-lift-control-plane.js';
import {
  TX_HASH,
  createAsyncLift2270Harness,
  expectFailed,
} from './_helpers/async-lift-2270-harness.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from './_helpers/ka-vm-publish.js';

/**
 * GH#2270 — the FAILED-JOB POLICY the publisher applies once a job has failed: what counts as
 * transaction evidence, when a job is held for chain proof, what a retry pass does with it, and
 * what the read-only projection tells an operator.
 *
 * The rows here drive the policy through the publisher (`retryDetailed`, `describeJobRetryState`)
 * and, where a single predicate is the point, call it directly. Admission and cleanup consequences
 * live in async-lift-admission-clear-2270; the scheduler itself in async-lift-auto-retry-2270.
 */
describe('GH#2270 failed-job retry disposition', () => {
  const h = createAsyncLift2270Harness();
  const {
    createPublisher,
    createCorruptHeadPublisher,
    failWithCorruptHead,
    failAfterRecordedTxHash,
    failWithUnmetQuorum,
    failWithRevert,
    failFromIncluded,
  } = h;

  beforeEach(() => h.reset());

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
    h.advance(100);
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
    await h.store.deleteByPattern({ subject: jobSubject(exhausted.jobId), graph: DEFAULT_CONTROL_GRAPH_URI });
    await h.store.insert(serializeJob(recoveryOwned, DEFAULT_CONTROL_GRAPH_URI));

    expect(await publisher.retryDetailed())
      .toEqual({ retried: 0, blockedPendingRecovery: 1, skipped: 0 });
    expect(publisher.describeJobRetryState(recoveryOwned))
      .toEqual({ autoRetryEligible: false, waitingReason: 'recovery' });
    expect((await publisher.getStatus(exhausted.jobId))?.status).toBe('failed');
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

  it('keeps a hash that only the recovery record carries, across a SECOND reset', async () => {
    // The shape a reset itself produces: the job it rebuilds has NO broadcast metadata, so its
    // recovery record is the only carrier left. Reading just `broadcast` dropped the hash exactly
    // there — a job reset once, re-claimed and interrupted again came out of the second reset with
    // no evidence at all, which is precisely the job that must stay held.
    const publisher = createPublisher();
    const failed = await failWithUnmetQuorum(publisher);
    const carriedInRecoveryOnly = {
      ...failed,
      broadcast: undefined,
      recovery: { action: 'reset_to_accepted', recoveredFromStatus: 'broadcast', txHashChecked: TX_HASH },
    } as unknown as PersistedFailedJob;

    expect(resetFailedLiftJobToAccepted(carriedInRecoveryOnly, 9_000).recovery).toEqual({
      action: 'reset_to_accepted',
      recoveredFromStatus: 'broadcast',
      txHashChecked: TX_HASH,
    });
    // And that carrier is what keeps the job evidence-bearing at all — the reason to preserve it.
    expect(hasBroadcastEvidence(carriedInRecoveryOnly)).toBe(true);
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

  it('reaccepts the same jobs by hand whether or not the automatic lane is switched on', async () => {
    // The ACTION is independent of `autoRetryEnabled` by construction (both 'backoff' and
    // 'operator' reaccept), so the kill-switch can never change what an operator's retry does.
    for (const autoRetryEnabled of [true, false]) {
      h.freshStore();
      const publisher = createPublisher({ autoRetryEnabled });
      await failWithUnmetQuorum(publisher);

      expect([autoRetryEnabled, await publisher.retryDetailed()])
        .toEqual([autoRetryEnabled, { retried: 1, blockedPendingRecovery: 0, skipped: 0 }]);
    }
  });
});
