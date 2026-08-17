import { beforeEach, describe, expect, it } from 'vitest';
import { isHeldForChainProof, hasBroadcastEvidence } from '../src/async-lift-retry-disposition.js';
import {
  DEFAULT_CONTROL_GRAPH_URI,
  jobSubject,
  serializeJob,
} from '../src/async-lift-control-plane.js';
import {
  TX_HASH,
  createAsyncLift2270Harness,
  expectFailed,
  scheduledDelay,
} from './_helpers/async-lift-2270-harness.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from './_helpers/ka-vm-publish.js';
import type { LiftJob } from '../src/index.js';

/**
 * GH#2270 — what a failed job does to ADMISSION and to CLEANUP: whether a client re-submit
 * reaccepts it, refuses with the typed pending-chain-proof error, or mints nothing at all, and
 * whether bulk `clear` may delete it.
 *
 * These are the two surfaces where getting the hold wrong publishes a Knowledge Asset twice: a
 * vacated lifecycle subject lets the next re-submit mint a second job, and a deleted job record is
 * how a held subject becomes vacant. The policy predicates themselves are exercised in
 * async-lift-retry-disposition-2270.
 */
describe('GH#2270 admission and cleanup for held jobs', () => {
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

  it('reaccepts an exhausted pre-send-safe job on a fresh client mandate with the budget re-armed', async () => {
    // The issue's hard requirement: a client re-submit NEVER creates a replacement job. The
    // subject stays bound to the same jobId, and the fresh mandate re-arms exactly one budget.
    const publisher = createCorruptHeadPublisher({ maxRetries: 1, retryBackoffBaseMs: 100, retryBackoffMaxMs: 250, rand: () => 0.5 });
    const request = kaVmPublishRequest();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    await failWithCorruptHead(publisher, 'wallet-1');
    h.advance(100);
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

  it('refuses a fresh mandate for an evidence-bearing job with budget remaining', async () => {
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

  it('refuses a re-submit for an evidence-bearing job whose budget is spent, never re-arming it', async () => {
    // The dangerous intersection of the two admission rules above: a spent budget takes the
    // FRESH-MANDATE path (re-arm and re-run on the same jobId), which for a job with a
    // transaction unaccounted for would republish it — while refusing the wrong way (letting the
    // subject go) would mint a replacement and publish it twice. Both are wrong; the hold wins.
    const publisher = createPublisher({ maxRetries: 2 });
    const request = kaVmPublishRequest();
    const failed = await failAfterRecordedTxHash(publisher, request);
    // The budget is spent directly on the persisted job: the lane can never spend it for a held
    // job (that IS the hold), so this is the only way to reach the exhausted state.
    const exhausted = { ...failed, retries: { ...failed.retries, retryCount: 2 } } as LiftJob;
    await h.store.deleteByPattern({ subject: jobSubject(failed.jobId), graph: DEFAULT_CONTROL_GRAPH_URI });
    await h.store.insert(serializeJob(exhausted, DEFAULT_CONTROL_GRAPH_URI));

    await expect(publisher.enqueueKnowledgeAssetVmPublish(request)).rejects.toMatchObject({
      name: 'LiftJobPendingChainProofError',
      code: 'LIFT_JOB_PENDING_CHAIN_PROOF',
      existingJobId: failed.jobId,
    });
    const after = await publisher.getStatus(failed.jobId);
    // Still failed, budget NOT re-armed, and no replacement job for the subject.
    expect([after?.status, after?.retries.retryCount]).toEqual(['failed', 2]);
    expect((await publisher.getStats()).accepted).toBe(0);
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
      h.freshStore();
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
});
