import { beforeEach, describe, expect, it } from 'vitest';
import { type LiftJob } from '../src/index.js';
import {
  queuedLiftOperationKind,
  resetFailedLiftJobToAccepted,
  type PersistedFailedJob,
} from '../src/async-lift-publisher-utils.js';
import {
  classifyRetryAction,
  describeRetryProjection,
  hasAutomaticRecoveryExit,
  hasBroadcastEvidence,
  delegatedHeldJobSettlement,
  localHeldJobSettlement,
  resolveHeldJobSettlementCapability,
  isTargetedClearableLiftJob,
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
 * The rows here drive the policy through the publisher (`retryDetailed`, `describeConfiguredRetryState`)
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
    expect([retryable, blocked, terminal].map((job) => publisher.describeConfiguredRetryState(job))).toEqual([
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
    expect(publisher.describeConfiguredRetryState(recoveryOwned))
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
      // r23 — the signer travels from this origin too; an 'included' failure has broadcast
      // metadata, so there is an authoritative wallet to preserve.
      walletIdChecked: includedFailure.broadcast?.walletId,
    });
    // r23 (🔴 3817474299) — the exact-shape assertion is the whole point of this row, so it has
    // to name EVERY field the contract says travels with the hash. It previously stopped at the
    // operation marker, which meant dropping the signer and the nonce stayed green — on a
    // data-integrity boundary where an inherited hash without its signer cannot form a lookup at
    // all. `toEqual` makes this exhaustive: a field added to the carrier and not to this list
    // fails here, which is the property that keeps the contract honest.
    expect(resetFailedLiftJobToAccepted(broadcastFailure, 9_000).recovery).toEqual({
      action: 'reset_to_accepted',
      recoveredFromStatus: 'broadcast',
      txHashChecked: TX_HASH,
      // r3 — the branch marker is evidence too, and rides the same carrier as the hash.
      operationKind: 'create',
      // r21 (3812632539) — and so do the signer and the nonce it consumed.
      walletIdChecked: broadcastFailure.broadcast?.walletId,
      nonceChecked: broadcastFailure.broadcast?.nonce,
    });
    // A pre-send failure records its origin with no hash to carry — there is no evidence to keep.
    expect(resetFailedLiftJobToAccepted(quorumFailure, 9_000).recovery).toEqual({
      action: 'reset_to_accepted',
      recoveredFromStatus: 'broadcast',
      txHashChecked: undefined,
    });
  });

  it('names the two settlement ROLES explicitly, without inferring either from wiring [3825614002]', () => {
    // 3825614002 — the role used to be re-derived inside the decision method from which
    // collaborators happened to be installed, so the same oracle meant different things depending
    // on whether a resolver sat beside it. Both policies are exercised directly here, with no
    // publisher instance at all: nothing about these answers may depend on wiring discovery.
    const namedJob = {
      request: { jobType: 'knowledge-asset-vm-publish', knowledgeAssetVmPublish: kaVmPublishRequest() },
    } as unknown as PersistedFailedJob;
    const rawJob = { request: { jobType: 'lift', lift: {} } } as unknown as PersistedFailedJob;

    // DELEGATED (admission): the oracle IS the answer, per wallet and per operation. No local
    // collaborator is consulted — this role has none.
    const delegated = delegatedHeldJobSettlement((w, k) => w === 'wallet-a' && k === 'create');
    expect(delegated(namedJob, 'wallet-a', 'create')).toBe(true);
    expect(delegated(namedJob, 'wallet-a', 'update')).toBe(false);
    expect(delegated(namedJob, 'wallet-b', 'create')).toBe(false);
    // Even with NO named recovery resolver anywhere in sight, which the local role would require.
    expect(delegated(namedJob, 'wallet-a', 'create')).toBe(true);

    // LOCAL (runtime): the oracle only NARROWS; local wiring must also be complete. A named job
    // needs the named recovery resolver whatever its kind (r12); a raw lift does not.
    expect(localHeldJobSettlement({ hasNamedRecoveryResolver: true })(namedJob, 'wallet-a', 'create')).toBe(true);
    expect(localHeldJobSettlement({ hasNamedRecoveryResolver: false })(namedJob, 'wallet-a', 'create')).toBe(false);
    expect(localHeldJobSettlement({ hasNamedRecoveryResolver: false })(rawJob, 'wallet-a', 'create')).toBe(true);
    expect(localHeldJobSettlement({
      capableForWallet: () => false,
      hasNamedRecoveryResolver: true,
    })(namedJob, 'wallet-a', 'create')).toBe(false);

    // The discriminating pair: SAME oracle, SAME job, and the two roles legitimately DISAGREE.
    // That disagreement is precisely why the role must be named rather than re-derived where the
    // decision is made.
    const oracle = () => true;
    expect(delegatedHeldJobSettlement(oracle)(namedJob, 'wallet-a', 'create')).toBe(true);
    expect(localHeldJobSettlement({ capableForWallet: oracle, hasNamedRecoveryResolver: false })(
      namedJob, 'wallet-a', 'create',
    )).toBe(false);

    // Role selection reads wiring in exactly ONE place, and an instance wired with neither a
    // resolver nor an oracle offers nothing.
    expect(resolveHeldJobSettlementCapability({
      hasChainProofResolver: false,
      hasNamedRecoveryResolver: false,
    })(namedJob, 'wallet-a', 'create')).toBe(false);
    expect(resolveHeldJobSettlementCapability({
      hasChainProofResolver: false,
      capableForWallet: oracle,
      hasNamedRecoveryResolver: false,
    })(namedJob, 'wallet-a', 'create')).toBe(true);
    expect(resolveHeldJobSettlementCapability({
      hasChainProofResolver: true,
      capableForWallet: oracle,
      hasNamedRecoveryResolver: false,
    })(namedJob, 'wallet-a', 'create')).toBe(false);
  });

  it('carries job-level ADMISSION across a reset, so recovery cannot launder the enqueuer', async () => {
    // 🟡 3824743779 — admission moved from the publish payload to job metadata. The reset REBUILDS
    // the job field by field rather than merging, so a job-level field that is not named here is
    // dropped silently. Dropping this one would revoke the by-id force-clear from the very jobs
    // that need it: a job is reset precisely when recovery could not settle it, which is the state
    // whose stated exit is the enqueuer's clear.
    const ADMITTED_BY = '0xAAaAAa00000000000000000000000000000000Aa';
    const publisher = createPublisher();
    const failed = await failAfterRecordedTxHash(publisher);
    const admitted = { ...failed, admission: { byAgentAddress: ADMITTED_BY } } as PersistedFailedJob;

    const reset = resetFailedLiftJobToAccepted(admitted, 9_000);

    expect(reset.admission).toEqual({ byAgentAddress: ADMITTED_BY });
    // The property that matters is the entitlement, not the field. Read it through the one
    // composed policy (3825162663) on a job in the state the override exists for: the enqueuer
    // still owns the lane after the reset, and an unrelated token still does not.
    const heldAfterReset = {
      ...admitted,
      admission: { byAgentAddress: ADMITTED_BY },
      failure: { ...admitted.failure, resolution: 'retry_recovery' },
    } as PersistedFailedJob;
    expect(isTargetedClearableLiftJob(heldAfterReset, {
      pendingTransactionOverride: { requestedBy: ADMITTED_BY },
    })).toBe(true);
    expect(isTargetedClearableLiftJob(heldAfterReset, {
      pendingTransactionOverride: { requestedBy: '0xBBbBBb00000000000000000000000000000000Bb' },
    })).toBe(false);
    // ...and with no override at all, ownership alone never grants the clear.
    expect(isTargetedClearableLiftJob(heldAfterReset)).toBe(false);
    // A job admitted with no principal must not acquire one by being reset.
    expect(resetFailedLiftJobToAccepted(failed, 9_000).admission).toBeUndefined();
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
      recovery: { action: 'reset_to_accepted', recoveredFromStatus: 'broadcast', txHashChecked: TX_HASH, operationKind: 'create' },
    } as unknown as PersistedFailedJob;

    expect(resetFailedLiftJobToAccepted(carriedInRecoveryOnly, 9_000).recovery).toEqual({
      action: 'reset_to_accepted',
      recoveredFromStatus: 'broadcast',
      txHashChecked: TX_HASH,
      // r3 — the branch marker is evidence too, and rides the same carrier as the hash.
      operationKind: 'create',
    });
    // And that carrier is what keeps the job evidence-bearing at all — the reason to preserve it.
    expect(hasBroadcastEvidence(carriedInRecoveryOnly)).toBe(true);
  });

  it('carries the transaction hash through an INTERRUPTED-recovery reset too', async () => {
    // The other caller of the shared reset builder: `recover()` putting an interrupted job back on
    // the queue. It must preserve evidence exactly like a reaccept does — a job that was reset
    // once, re-claimed and then interrupted carries its hash only in the recovery record, and this
    // is the path that used to read `broadcast` alone and drop it.
    const publisher = createPublisher();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const claimed = (await publisher.claimNext('wallet-1'))!;
    // The shape a first reset leaves behind: no broadcast metadata, hash in the recovery record.
    const carriedInRecoveryOnly = {
      ...claimed,
      recovery: { action: 'reset_to_accepted', recoveredFromStatus: 'broadcast', txHashChecked: TX_HASH },
    } as unknown as LiftJob;
    await h.store.deleteByPattern({ subject: jobSubject(jobId), graph: DEFAULT_CONTROL_GRAPH_URI });
    await h.store.insert(serializeJob(carriedInRecoveryOnly, DEFAULT_CONTROL_GRAPH_URI));

    expect(await publisher.recover()).toBe(1);

    const reset = await publisher.getStatus(jobId);
    expect(reset?.status).toBe('accepted');
    expect(reset?.recovery).toEqual({
      action: 'reset_to_accepted',
      recoveredFromStatus: 'claimed',
      txHashChecked: TX_HASH,
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
      publisher.describeConfiguredRetryState(scheduled),
      // A transaction may exist: never eligible, whatever the registry says about the code.
      publisher.describeConfiguredRetryState(evidenceBearing),
      // Retryable, evidence-free, budget left — but nothing automatic moves a non-allow-listed
      // code; an operator or a client re-submit must.
      publisher.describeConfiguredRetryState({
        ...evidenceBearing,
        broadcast: undefined,
        failure: { ...evidenceBearing.failure, failedFromState: 'validated' },
      } as unknown as LiftJob),
      // Budget spent: only a fresh client mandate re-arms it.
      publisher.describeConfiguredRetryState({ ...scheduled, retries: { ...scheduled.retries, retryCount: 2 } }),
      // A terminal failure is not waiting for anything.
      publisher.describeConfiguredRetryState({
        ...scheduled,
        failure: { ...scheduled.failure, code: 'publish_intent_stale', retryable: false, resolution: 'fail_job' },
      }),
      // A job that has not failed has no retry projection at all.
      publisher.describeConfiguredRetryState((await publisher.getStatus(acceptedJobId))!),
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

    expect(enabled.describeConfiguredRetryState(failed)).toEqual({ autoRetryEligible: true, waitingReason: 'backoff' });
    expect(createCorruptHeadPublisher({ autoRetryEnabled: false }).describeConfiguredRetryState(failed))
      .toEqual({ autoRetryEligible: false, waitingReason: 'operator' });
  });

  it('reports an allow-listed failure that was never SCHEDULED as operator work, not backoff', async () => {
    // The reviewer's case. A `workspace_unavailable` recorded while the kill-switch was off gets no
    // `nextRetryAt`, and the sweep only reaccepts jobs whose schedule is set and due (the row
    // 'strands an already-scheduled due job while disabled and releases it once re-enabled' in the
    // lane spec proves that from the other side). Turning the switch back on does not schedule it
    // retroactively — so reporting `backoff` would promise a retry no sweep will ever run.
    const disabled = createCorruptHeadPublisher({ autoRetryEnabled: false });
    await disabled.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const unscheduled = await failWithCorruptHead(disabled, 'wallet-1');
    expect(unscheduled.timestamps.nextRetryAt).toBeUndefined();

    // Re-enabled publisher, same job: allow-listed, budget intact, and still not going anywhere.
    const reEnabled = createCorruptHeadPublisher({ retryBackoffBaseMs: 100, retryBackoffMaxMs: 250, rand: () => 0.5 });
    expect(reEnabled.describeConfiguredRetryState(unscheduled))
      .toEqual({ autoRetryEligible: false, waitingReason: 'operator' });

    // 'operator' is exactly right: the manual path DOES move it, which is what the operator is
    // being told to reach for.
    expect(await reEnabled.retryDetailed())
      .toEqual({ retried: 1, blockedPendingRecovery: 0, skipped: 0 });
  });

  it('reports the same failure as backoff once it carries a schedule', async () => {
    // The polarity, differing only in the schedule: recorded with the lane ON, the identical
    // failure gets a `nextRetryAt` and the sweep will pick it up — so `backoff` is a promise the
    // node keeps.
    const publisher = createCorruptHeadPublisher({ retryBackoffBaseMs: 100, retryBackoffMaxMs: 250, rand: () => 0.5 });
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const scheduled = await failWithCorruptHead(publisher, 'wallet-1');
    expect(scheduled.timestamps.nextRetryAt).toBeDefined();

    expect(publisher.describeConfiguredRetryState(scheduled))
      .toEqual({ autoRetryEligible: true, waitingReason: 'backoff' });
    // And the schedule is the ONLY difference: strip it and the same job reads as operator work.
    expect(publisher.describeConfiguredRetryState({
      ...scheduled,
      timestamps: { ...scheduled.timestamps, nextRetryAt: undefined },
    })).toEqual({ autoRetryEligible: false, waitingReason: 'operator' });
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
    expect([reaccept, blocked, skip].map((job) => publisher.describeConfiguredRetryState(job)))
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

  // PR #2300 r2 (🟡 3809616685) — the operation-kind classifier over VERSION-ONLY signals,
  // table-driven. The queued executor branches on `vmCurrentAssertion`, but a persisted request
  // can carry an advanced (or malformed) `assertionVersion` with no vmCurrentAssertion at all —
  // and the derivation must still err toward 'update', because update-as-create is the dangerous
  // misread (an absence release re-applying stale state). A classifier collapsed back to
  // vmCurrentAssertion-only would call the first two rows 'create' and fail them.
  describe('queuedLiftOperationKind over version-only signals', () => {
    function jobWithRequest(
      overrides: Record<string, unknown>,
      marker?: 'create' | 'update',
    ): PersistedFailedJob {
      return {
        jobId: 'kind-probe',
        jobSlug: 'kind-probe',
        ...(marker ? { broadcast: { txHash: TX_HASH, walletId: 'w-kind', operationKind: marker } } : {}),
        request: {
          jobType: 'knowledge-asset-vm-publish',
          knowledgeAssetVmPublish: kaVmPublishRequest(overrides as never),
        },
        status: 'failed',
        failure: {
          failedFromState: 'broadcast',
          code: 'rpc_unavailable',
          retryable: true,
          resolution: 'reset_to_accepted',
          message: 'x',
          errorPayloadRef: 'urn:x',
          occurredAt: 1,
        },
        timestamps: { acceptedAt: 1, failedAt: 2, updatedAt: 2 },
        retries: { retryCount: 0, maxRetries: 10 },
      } as unknown as PersistedFailedJob;
    }

    // PR #2300 r3 (🔴 3811569441) — this table used to be driven by `assertionVersion`, and that
    // was wrong: the version counts ASSERTION revisions, not VM publications, so a KA finalized
    // twice before its first publish (version 2, no vmCurrentAssertion) is a genuine CREATE and was
    // being frozen out of absence-release forever. The DURABLE MARKER written at the write-ahead is
    // the only thing that knows what signed; the request cannot know, because the queued publish
    // resolves its update branch from `vmCurrentAssertion ?? the live lifecycle pointer`. Without a
    // marker the answer is the SAFE one (update: the job holds and an operator can clear it) rather
    // than the likely one (create: which would authorise a resend).
    it.each([
      ['a CREATE marker, even at an advanced assertion version', { assertionVersion: '2', vmCurrentAssertion: undefined }, 'create' as const, 'create'],
      ['a CREATE marker, even with a vmCurrentAssertion in the request', { assertionVersion: '2', vmCurrentAssertion: 'aa'.repeat(32) }, 'create' as const, 'create'],
      ['an UPDATE marker', { assertionVersion: '1', vmCurrentAssertion: undefined }, 'update' as const, 'update'],
    ] as const)('classifies by what actually signed: %s', (_label, overrides, marker, expected) => {
      expect(queuedLiftOperationKind(jobWithRequest(overrides as Record<string, unknown>, marker)))
        .toBe(expected);
    });

    it.each([
      ['advanced version, no vmCurrentAssertion (a first publish — held, not released)', { assertionVersion: '2', vmCurrentAssertion: undefined }],
      ['malformed version', { assertionVersion: 'not-a-number', vmCurrentAssertion: undefined }],
      ['vmCurrentAssertion present, version 1', { assertionVersion: '1', vmCurrentAssertion: 'aa'.repeat(32) }],
      ['version 1, no vmCurrentAssertion', { assertionVersion: '1', vmCurrentAssertion: undefined }],
      ['no version at all, no vmCurrentAssertion', { assertionVersion: undefined, vmCurrentAssertion: undefined }],
    ] as const)('falls back to the SAFE answer with no marker: %s', (_label, overrides) => {
      expect(queuedLiftOperationKind(jobWithRequest(overrides as Record<string, unknown>)))
        .toBe('update');
    });

    it('RELEASES a first VM publish at assertion version 2 — the marker says CREATE', async () => {
      // PR #2300 r3 (3811569441), the reviewer's exact scenario: a KA finalized twice before its
      // FIRST VM publication carries assertionVersion '2' with no vmCurrentAssertion. It is a
      // create, its transaction is proven absent, and it must go back on the queue — under the old
      // version heuristic it was classified an update and held forever.
      const releasing = createPublisher({ chainProofResolver: async () => ({ status: 'not-found' }) });
      const firstPublish = kaVmPublishRequest({ assertionVersion: '2' });
      const releasedId = await releasing.enqueueKnowledgeAssetVmPublish(firstPublish);
      await releasing.claimNext('w-first-publish');
      await releasing.update(releasedId, 'validated', { validation: KA_VM_VALIDATION });
      await releasing.update(releasedId, 'broadcast', {
        broadcast: { txHash: TX_HASH, walletId: 'w-first-publish', nonce: 41, operationKind: 'create' },
      });
      expectFailed(await releasing.recordPublishFailure(releasedId, {
        error: new Error('RPC endpoint temporarily unavailable'),
        failedFromState: 'broadcast',
        errorPayloadRef: `urn:dkg:test:error:${releasedId}`,
      }));

      expect(await releasing.recover()).toBe(1);
      expect((await releasing.getStatus(releasedId))?.status).toBe('accepted');
    });

    it('holds that same shape when NOTHING durable says what signed it', async () => {
      // The pre-marker residual, pinned so it cannot drift into an accident: an identical record
      // with no marker is treated as an update and stays held, because releasing on a guess is the
      // one mistake this lane must never make. The operator's by-id clear is its exit.
      const publisher = createPublisher({ chainProofResolver: async () => ({ status: 'not-found' }) });
      const request = kaVmPublishRequest({ assertionVersion: '2' });
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
      await publisher.claimNext('w-version-only');
      await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      await publisher.update(jobId, 'broadcast', {
        broadcast: { txHash: TX_HASH, walletId: 'w-version-only', nonce: 41 },
      });
      const held = expectFailed(await publisher.recordPublishFailure(jobId, {
        error: new Error('RPC endpoint temporarily unavailable'),
        failedFromState: 'broadcast',
        errorPayloadRef: `urn:dkg:test:error:${jobId}`,
      }));
      expect(hasBroadcastEvidence(held)).toBe(true);

      expect(await publisher.recover()).toBe(0);
      expect(expectFailed(await publisher.getStatus(jobId)).status).toBe('failed');
    });
  });

  // PR #2300 r1 (🟡 3809054821) — `retryable` on the pending-chain-proof 503 is JOB-SPECIFIC:
  // does an automatic lane exist that can move THIS record? These rows pin the matrix AND that
  // admission carries the answer on the thrown error, which is what the HTTP boundary forwards.
  describe('hasAutomaticRecoveryExit decides the per-job retryable answer', () => {
    async function heldJob(
      publisher: ReturnType<typeof createPublisher>,
      request: ReturnType<typeof kaVmPublishRequest>,
      broadcast: { txHash: typeof TX_HASH; walletId: string; nonce?: number; operationKind?: 'create' | 'update' },
    ): Promise<PersistedFailedJob> {
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
      await publisher.claimNext(broadcast.walletId);
      await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      await publisher.update(jobId, 'broadcast', { broadcast });
      return expectFailed(await publisher.recordPublishFailure(jobId, {
        error: new Error('RPC endpoint temporarily unavailable'),
        failedFromState: 'broadcast',
        errorPayloadRef: `urn:dkg:test:error:${jobId}`,
      }));
    }

    async function admissionRetryable(
      publisher: ReturnType<typeof createPublisher>,
      request: ReturnType<typeof kaVmPublishRequest>,
    ): Promise<boolean> {
      try {
        await publisher.enqueueKnowledgeAssetVmPublish(request);
      } catch (err) {
        expect((err as { code?: string }).code).toBe('LIFT_JOB_PENDING_CHAIN_PROOF');
        return (err as { retryable: boolean }).retryable;
      }
      throw new Error('expected admission to refuse the held job');
    }

    it('TRUE for a create with a recorded nonce and pinned identity — every world has an exit', async () => {
      // r4 (3811993669) — the lane has to be WIRED for the promise to be honest, so these rows
      // construct a publisher that can actually move the job. r12 — that includes the named
      // recovery resolver even for a create: absence-release is only one of its two outcomes, and
      // a MINED create is settled by the finalizer this resolver provides.
      const publisher = createPublisher({
        chainProofResolver: async () => ({ status: 'inconclusive' }),
        knowledgeAssetVmPublishRecoveryResolver: async () => null,
      });
      const request = kaVmPublishRequest();
      // r4 (3811993487) — the marker is REQUIRED here: without it the fixture classifies as an
      // update and this row silently stopped guarding the create branch it names.
      const held = await heldJob(publisher, request, { txHash: TX_HASH, walletId: 'w-exit', nonce: 41, operationKind: 'create' });

      expect(hasAutomaticRecoveryExit(held)).toBe(true);
      expect(await admissionRetryable(publisher, request)).toBe(true);
    });

    it('FALSE for a legacy create with NO recorded nonce — a dropped tx leaves only the operator', async () => {
      const publisher = createPublisher();
      const request = kaVmPublishRequest();
      const held = await heldJob(publisher, request, { txHash: TX_HASH, walletId: 'w-legacy', operationKind: 'create' });

      expect(hasAutomaticRecoveryExit(held)).toBe(false);
      expect(await admissionRetryable(publisher, request)).toBe(false);
    });

    it('FALSE for a held CREATE when only the chain-proof resolver is wired [r12]', async () => {
      // 3813505773 — the create looked exempt because its absence-release needs nothing but the
      // reset. That is one outcome of two: a MINED create is settled by the named finalizer, so
      // without that resolver this node cannot see the job through and must not promise it.
      const publisher = createPublisher({ chainProofResolver: async () => ({ status: 'inconclusive' }) });
      const request = kaVmPublishRequest();
      const held = await heldJob(publisher, request, { txHash: TX_HASH, walletId: 'w-create-half', nonce: 41, operationKind: 'create' });

      expect(hasAutomaticRecoveryExit(held)).toBe(true);
      expect(await admissionRetryable(publisher, request)).toBe(false);
    });

    it('FALSE for a held UPDATE when only the chain-proof resolver is wired [r5]', async () => {
      // 3812123595 — the update lane needs BOTH: the resolver that recognizes the transaction and
      // the named recovery resolver that finalizes what recognition proves. With only the first
      // wired, recognition can succeed and the job still cannot be completed, so the promise would
      // be false. This is the solo-removal row for that conjunct.
      const publisher = createPublisher({ chainProofResolver: async () => ({ status: 'inconclusive' }) });
      const request = kaVmPublishRequest({ vmCurrentAssertion: 'aa'.repeat(32), assertionVersion: '2' });
      const held = await heldJob(publisher, request, { txHash: TX_HASH, walletId: 'w-upd-half', nonce: 41, operationKind: 'update' });

      expect(hasAutomaticRecoveryExit(held)).toBe(true);
      expect(await admissionRetryable(publisher, request)).toBe(false);
    });

    it('FALSE for an UNMARKED pre-upgrade record — the kind is a guess, not evidence [r5]', async () => {
      // 3812123691 — an unmarked record classifies as an update by SAFE FALLBACK. If it was really
      // a create, update recognition can never recognize it and update absence is deliberately
      // inconclusive, so every chain outcome leaves it held. The operation-specific promise may
      // only be made on the durable marker.
      const publisher = createPublisher({
        chainProofResolver: async () => ({ status: 'inconclusive' }),
        knowledgeAssetVmPublishRecoveryResolver: async () => null,
      });
      const request = kaVmPublishRequest();
      const held = await heldJob(publisher, request, { txHash: TX_HASH, walletId: 'w-unmarked', nonce: 41 });

      expect(hasAutomaticRecoveryExit(held)).toBe(false);
      expect(await admissionRetryable(publisher, request)).toBe(false);
    });

    it('FALSE for a record the dispatcher can never finalize — no validation [r15]', async () => {
      // 3814317413 — the promise has to match what the dispatcher will DO. It refuses to finalize a
      // record that cannot form a published-finalized job, so a carrier-only job missing validation
      // would resolve `recovered` on every tick and then decline, leaving the operator-only clear
      // the response said was unnecessary.
      const publisher = createPublisher({
        chainProofResolver: async () => ({ status: 'inconclusive' }),
        knowledgeAssetVmPublishRecoveryResolver: async () => null,
      });
      const request = kaVmPublishRequest();
      const held = await heldJob(publisher, request, { txHash: TX_HASH, walletId: 'w-noval', nonce: 41, operationKind: 'create' });
      const stripped = { ...held } as unknown as Record<string, unknown>;
      delete stripped.validation;

      expect(hasAutomaticRecoveryExit(stripped as never)).toBe(false);
    });

    it('FALSE for a fully eligible record when THIS node has no chain-proof resolver [r4]', async () => {
      // 3811993669 — the record could not be more eligible: a create, a recorded nonce, a pinned
      // identity. But a publisher with no resolver wired never looks at it, so promising a retry
      // would loop the client forever. The record predicate still says yes; the answer the client
      // gets does not.
      const publisher = createPublisher();
      const request = kaVmPublishRequest();
      const held = await heldJob(publisher, request, { txHash: TX_HASH, walletId: 'w-unwired', nonce: 41, operationKind: 'create' });

      expect(hasAutomaticRecoveryExit(held)).toBe(true);
      expect(await admissionRetryable(publisher, request)).toBe(false);
      // And nothing moves it, which is what the answer is about.
      expect(await publisher.recover()).toBe(0);
    });

    it('TRUE for an update whose recognition question is fully formed', async () => {
      // Conditional promise, documented as such: recognition converges iff the tx actually mined.
      const publisher = createPublisher({
        chainProofResolver: async () => ({ status: 'inconclusive' }),
        knowledgeAssetVmPublishRecoveryResolver: async () => null,
      });
      const request = kaVmPublishRequest({ vmCurrentAssertion: 'aa'.repeat(32), assertionVersion: '2' });
      const held = await heldJob(publisher, request, { txHash: TX_HASH, walletId: 'w-upd', nonce: 41, operationKind: 'update' });

      expect(hasAutomaticRecoveryExit(held)).toBe(true);
      expect(await admissionRetryable(publisher, request)).toBe(true);
    });

    it('TRUE for an update with NO recorded nonce — recognition needs no nonce [PR#2300 r2]', async () => {
      // 🟡 3809616687 — the nonce feeds only the create-side absence proof. An update's automatic
      // lane is canonical recognition, formed entirely from the hash, the wallet, the pinned
      // identity and the intended root; a legacy update record without the write-ahead nonce
      // keeps its TRUE, and the 503 keeps promising (conditional) convergence.
      const publisher = createPublisher({
        chainProofResolver: async () => ({ status: 'inconclusive' }),
        knowledgeAssetVmPublishRecoveryResolver: async () => null,
      });
      const request = kaVmPublishRequest({ vmCurrentAssertion: 'aa'.repeat(32), assertionVersion: '2' });
      const held = await heldJob(publisher, request, { txHash: TX_HASH, walletId: 'w-upd-nononce', operationKind: 'update' });

      expect(held.broadcast?.nonce).toBeUndefined();
      expect(hasAutomaticRecoveryExit(held)).toBe(true);
      expect(await admissionRetryable(publisher, request)).toBe(true);
    });

    it('FALSE when no recognition question can be formed at all', async () => {
      // No pinned identity: recognition cannot name a token and no absence proof exists either —
      // for BOTH kinds this is the operator-only cell.
      const publisher = createPublisher();
      const base = kaVmPublishRequest({ vmCurrentAssertion: 'aa'.repeat(32), assertionVersion: '2' });
      const request = {
        ...base,
        seal: { ...base.seal, reservedKaId: undefined },
        kaNumber: undefined,
      } as ReturnType<typeof kaVmPublishRequest>;
      const held = await heldJob(publisher, request, { txHash: TX_HASH, walletId: 'w-noid', nonce: 41 });

      expect(hasAutomaticRecoveryExit(held)).toBe(false);
      expect(await admissionRetryable(publisher, request)).toBe(false);
    });
  });
});
