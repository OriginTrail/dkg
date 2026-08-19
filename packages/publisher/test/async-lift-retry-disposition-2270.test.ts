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
    });
    expect(resetFailedLiftJobToAccepted(broadcastFailure, 9_000).recovery).toEqual({
      action: 'reset_to_accepted',
      recoveredFromStatus: 'broadcast',
      txHashChecked: TX_HASH,
      // r3 — the branch marker is evidence too, and rides the same carrier as the hash.
      operationKind: 'create',
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
      const publisher = createPublisher();
      const request = kaVmPublishRequest();
      const held = await heldJob(publisher, request, { txHash: TX_HASH, walletId: 'w-exit', nonce: 41 });

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

    it('TRUE for an update whose recognition question is fully formed', async () => {
      // Conditional promise, documented as such: recognition converges iff the tx actually mined.
      const publisher = createPublisher();
      const request = kaVmPublishRequest({ vmCurrentAssertion: 'aa'.repeat(32), assertionVersion: '2' });
      const held = await heldJob(publisher, request, { txHash: TX_HASH, walletId: 'w-upd', nonce: 41 });

      expect(hasAutomaticRecoveryExit(held)).toBe(true);
      expect(await admissionRetryable(publisher, request)).toBe(true);
    });

    it('TRUE for an update with NO recorded nonce — recognition needs no nonce [PR#2300 r2]', async () => {
      // 🟡 3809616687 — the nonce feeds only the create-side absence proof. An update's automatic
      // lane is canonical recognition, formed entirely from the hash, the wallet, the pinned
      // identity and the intended root; a legacy update record without the write-ahead nonce
      // keeps its TRUE, and the 503 keeps promising (conditional) convergence.
      const publisher = createPublisher();
      const request = kaVmPublishRequest({ vmCurrentAssertion: 'aa'.repeat(32), assertionVersion: '2' });
      const held = await heldJob(publisher, request, { txHash: TX_HASH, walletId: 'w-upd-nononce' });

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
