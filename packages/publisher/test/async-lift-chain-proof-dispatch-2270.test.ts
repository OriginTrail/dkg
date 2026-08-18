/**
 * GH#2270 PR-3 — the proof-first dispatcher.
 *
 * PR-2 built the HOLD: a failed job whose transaction is unaccounted for is never reaccepted, by
 * any path. That was safe and terminal — for named-KA jobs nothing ever asked the chain about a
 * held job (`canRetryFailedRecovery` was a literal `false`), so the only exit was an operator
 * clearing it by id. This is the lane that resolves them.
 *
 * Every row here drives `recover()` on a job produced through the public path, and asserts on the
 * persisted result rather than on a predicate, because the claim is about what the queue DOES with
 * a verdict — finalize, release, or keep holding — not about how a verdict is classified.
 *
 * The matrix is verdict × evidence CARRIER. The two carriers are the ones `hasBroadcastEvidence`
 * reads: live `broadcast.txHash`, and a `recovery.txHashChecked` left behind by an earlier reset
 * on a job that has since re-failed from a pre-send state. They are not interchangeable — the
 * second names a transaction some EARLIER attempt sent, which is why a `reverted` verdict releases
 * them differently.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AsyncKnowledgeAssetVmPublishRecoveryEvidence,
  AsyncLiftChainProofResolution,
  AsyncLiftPublisherConfig,
  LiftJob,
  LiftJobHex,
} from '../src/index.js';
import type { PersistedFailedJob } from '../src/async-lift-publisher-utils.js';
import { isHeldForChainProof } from '../src/async-lift-retry-disposition.js';
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
import { kaVmPublishRequest } from './_helpers/ka-vm-publish.js';

const AUTHOR = '0x1111111111111111111111111111111111111111' as LiftJobHex;
const MERKLE_ROOT = `0x${'12'.repeat(32)}` as LiftJobHex;

/** The canonical evidence the named lane needs: the generic recovery result has no publishProof. */
function kaVmRecoveryEvidence(): AsyncKnowledgeAssetVmPublishRecoveryEvidence {
  return {
    inclusion: { txHash: TX_HASH, blockNumber: 77, blockHash: `0x${'bc'.repeat(32)}` as LiftJobHex },
    finalization: {
      mode: 'published',
      txHash: TX_HASH,
      ual: 'did:dkg:evm:31337/0xabc/7',
      batchId: '7',
      startKAId: '7',
      endKAId: '7',
      publisherAddress: AUTHOR,
    },
    publishProof: { merkleRoot: MERKLE_ROOT, authorAddress: AUTHOR, txIndex: 4 },
  };
}

const RECOVERED: AsyncLiftChainProofResolution = {
  status: 'recovered',
  recovery: {
    inclusion: { txHash: TX_HASH, blockNumber: 77 },
    finalization: {
      mode: 'published',
      txHash: TX_HASH,
      ual: 'did:dkg:evm:31337/0xabc/7',
      batchId: '7',
      startKAId: '7',
      endKAId: '7',
      publisherAddress: AUTHOR,
    },
  },
};

/** The three verdicts that establish nothing about the transaction. */
const UNRESOLVED_VERDICTS = ['pending', 'unrecognized', 'inconclusive'] as const;

describe('GH#2270 proof-first chain dispatcher', () => {
  const h = createAsyncLift2270Harness();
  const { createPublisher, failAfterRecordedTxHash, failWithUnmetQuorum } = h;

  beforeEach(() => h.reset());

  /** Counts every SEND, so a row can prove the dispatcher never caused one. */
  let sends = 0;

  beforeEach(() => {
    sends = 0;
  });

  function dispatcher(
    verdict: AsyncLiftChainProofResolution,
    config: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator' | 'chainRecoveryResolver'> = {},
  ) {
    return createPublisher({
      chainRecoveryResolver: async () => verdict,
      knowledgeAssetVmPublishRecoveryResolver: async () => kaVmRecoveryEvidence(),
      knowledgeAssetVmPublishHandler: {
        execute: async () => {
          sends += 1;
          throw new Error('the dispatcher must never cause a send');
        },
        finalizeRecovered: async () => undefined,
      },
      ...config,
    });
  }

  /**
   * The second evidence carrier, persisted so `recover()` actually reads it: a job that was reset
   * once (its broadcast metadata is gone, the hash survives in the recovery record) and has since
   * re-failed from a PRE-SEND state. `hasBroadcastEvidence` still reads it as evidence-bearing,
   * which is what makes it held — but the transaction it names belongs to an earlier attempt.
   */
  async function heldOnRecoveryCarrier(publisher: ReturnType<typeof createPublisher>): Promise<PersistedFailedJob> {
    const failed = await failAfterRecordedTxHash(publisher);
    const carried = {
      ...failed,
      broadcast: undefined,
      recovery: { action: 'reset_to_accepted', recoveredFromStatus: 'broadcast', txHashChecked: TX_HASH },
      failure: { ...failed.failure, failedFromState: 'claimed', code: 'workspace_unavailable' },
    } as unknown as LiftJob;
    await h.store.deleteByPattern({ subject: jobSubject(failed.jobId), graph: DEFAULT_CONTROL_GRAPH_URI });
    await h.store.insert(serializeJob(carried, DEFAULT_CONTROL_GRAPH_URI));
    return expectFailed(await publisher.getStatus(failed.jobId));
  }

  it('holds a named-KA job whose transaction is unaccounted for, with no resolver wired at all', async () => {
    // The premise every row below rests on: `failAfterRecordedTxHash` really does produce a HELD
    // job, so a release seen later is the dispatcher's doing and not the fixture's.
    const publisher = createPublisher();
    const failed = await failAfterRecordedTxHash(publisher);

    expect(isHeldForChainProof(failed)).toBe(true);
    expect(failed.broadcast?.txHash).toBe(TX_HASH);
    expect(await publisher.recover()).toBe(0);
    expect((await publisher.getStatus(failed.jobId))?.status).toBe('failed');
  });

  describe('carrier: live broadcast.txHash', () => {
    it('finalizes the SAME job on a recovered verdict, without sending anything', async () => {
      const publisher = dispatcher(RECOVERED);
      const failed = await failAfterRecordedTxHash(publisher);

      expect(await publisher.recover()).toBe(1);

      const resolved = await publisher.getStatus(failed.jobId);
      expect(resolved?.status).toBe('finalized');
      expect(resolved?.jobId).toBe(failed.jobId);
      expect(resolved?.recovery?.action).toBe('finalized_from_chain');
      expect(resolved?.recovery?.txHashChecked).toBe(TX_HASH);
      // THE FALSIFIER. The whole chain exists to stop a second transaction; a dispatcher that
      // re-queued the job instead of adopting the chain's answer would show up right here.
      expect(sends).toBe(0);
    });

    it('releases the job for a re-run on a proven-absent verdict, keeping the hash it checked', async () => {
      const publisher = dispatcher({ status: 'not-found' });
      const failed = await failAfterRecordedTxHash(publisher);

      expect(await publisher.recover()).toBe(1);

      const released = await publisher.getStatus(failed.jobId);
      // Same jobId, back on the queue — never a replacement job for the KA's lifecycle.
      expect(released?.status).toBe('accepted');
      expect(released?.jobId).toBe(failed.jobId);
      // The evidence survives the release, so a LATER failure of this job is still held.
      expect(released?.recovery).toEqual({
        action: 'reset_to_accepted',
        recoveredFromStatus: 'broadcast',
        txHashChecked: TX_HASH,
      });
      // A reset must carry no stale schedule for the claim-time sweep to re-fire on.
      expect(released?.timestamps.nextRetryAt).toBeUndefined();
      expect(sends).toBe(0);
    });

    it('records tx_reverted on a proven-reverted verdict, which is what releases the hold', async () => {
      const publisher = dispatcher({ status: 'reverted' });
      const failed = await failAfterRecordedTxHash(publisher);
      expect(failed.failure.code).toBe('rpc_unavailable');

      expect(await publisher.recover()).toBe(1);

      const settled = expectFailed(await publisher.getStatus(failed.jobId));
      // Still failed — a revert is terminal by registry policy, so the job is NOT re-run on this
      // node's money. What changed is that its transaction is now accounted for.
      expect(settled.status).toBe('failed');
      expect(settled.failure.code).toBe('tx_reverted');
      expect(settled.failure.retryable).toBe(false);
      // The release goes through the disposition module's own rule, not around it: the code is
      // proven-ineffective, so the hold lifts while the evidence stays on the job.
      expect(isHeldForChainProof(settled)).toBe(false);
      expect(settled.broadcast?.txHash).toBe(TX_HASH);
      expect(sends).toBe(0);
    });

    it.each(UNRESOLVED_VERDICTS)('keeps holding on a %s verdict, and asks again next tick', async (status) => {
      const publisher = dispatcher({ status });
      const failed = await failAfterRecordedTxHash(publisher);

      expect(await publisher.recover()).toBe(0);

      const stillHeld = expectFailed(await publisher.getStatus(failed.jobId));
      expect(stillHeld.status).toBe('failed');
      expect(stillHeld.failure.code).toBe('rpc_unavailable');
      expect(isHeldForChainProof(stillHeld)).toBe(true);
      // No expiry: a second pass reaches the same job and holds it again. The hold does not decay
      // into a reset, because a reset with no proof is the double publish this lane prevents.
      expect(await publisher.recover()).toBe(0);
      expect(isHeldForChainProof(expectFailed(await publisher.getStatus(failed.jobId)))).toBe(true);
      expect(sends).toBe(0);
    });
  });

  describe('carrier: recovery.txHashChecked only', () => {
    it('is held even though it has no broadcast metadata', async () => {
      const publisher = createPublisher();
      const held = await heldOnRecoveryCarrier(publisher);

      expect(held.broadcast).toBeUndefined();
      expect(held.recovery?.txHashChecked).toBe(TX_HASH);
      expect(isHeldForChainProof(held)).toBe(true);
    });

    it('releases for a re-run on a proven-absent verdict', async () => {
      const publisher = dispatcher({ status: 'not-found' });
      const held = await heldOnRecoveryCarrier(publisher);

      expect(await publisher.recover()).toBe(1);

      const released = await publisher.getStatus(held.jobId);
      expect(released?.status).toBe('accepted');
      expect(released?.recovery?.txHashChecked).toBe(TX_HASH);
      expect(sends).toBe(0);
    });

    it('releases by RESET on a reverted verdict — the reverted tx was not this job’s', async () => {
      // The asymmetry with the broadcast carrier, and the reason the dispatcher asks whose
      // transaction it is: this job failed BEFORE signing anything. The reverted transaction
      // belongs to an earlier attempt, so `tx_reverted` would be a false statement about where
      // this failure came from — and `LIFT_JOB_FAILURE_ALLOWED_STATES` rejects the code from a
      // pre-send state for exactly that reason. Proven-nothing-published releases it the same way
      // a proven absence does.
      const publisher = dispatcher({ status: 'reverted' });
      const held = await heldOnRecoveryCarrier(publisher);

      expect(await publisher.recover()).toBe(1);

      const released = await publisher.getStatus(held.jobId);
      expect(released?.status).toBe('accepted');
      expect(released?.status).not.toBe('failed');
      expect(released?.recovery?.txHashChecked).toBe(TX_HASH);
      expect(sends).toBe(0);
    });

    it.each(UNRESOLVED_VERDICTS)('keeps holding on a %s verdict', async (status) => {
      const publisher = dispatcher({ status });
      const held = await heldOnRecoveryCarrier(publisher);

      expect(await publisher.recover()).toBe(0);

      const stillHeld = expectFailed(await publisher.getStatus(held.jobId));
      expect(stillHeld.status).toBe('failed');
      expect(isHeldForChainProof(stillHeld)).toBe(true);
      expect(sends).toBe(0);
    });

    it('finalizes on a recovered verdict, without sending anything', async () => {
      const publisher = dispatcher(RECOVERED);
      const held = await heldOnRecoveryCarrier(publisher);

      expect(await publisher.recover()).toBe(1);

      expect((await publisher.getStatus(held.jobId))?.status).toBe('finalized');
      expect(sends).toBe(0);
    });
  });

  describe('pause', () => {
    it('does not dispatch held jobs while paused, and resumes where it left off', async () => {
      const publisher = dispatcher({ status: 'not-found' });
      const failed = await failAfterRecordedTxHash(publisher);

      await publisher.pause();
      expect(await publisher.recover()).toBe(0);
      // Untouched: paused means this node is not driving publishes, and releasing a job puts work
      // back on the queue.
      expect(isHeldForChainProof(expectFailed(await publisher.getStatus(failed.jobId)))).toBe(true);

      await publisher.resume();
      expect(await publisher.recover()).toBe(1);
      expect((await publisher.getStatus(failed.jobId))?.status).toBe('accepted');
    });

    it('still asks the chain about a job it has ALREADY broadcast while paused', async () => {
      // The deliberate asymmetry, pinned so it cannot drift into an accident. The interrupted half
      // repairs a live transaction this node already sent; stopping it while paused would leave a
      // real transaction unreconciled, which is the phantom the pre-send write-ahead exists to
      // surface. Only the failed-job dispatcher is a driver, and only it is gated.
      const publisher = dispatcher(RECOVERED);
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      const walletId = 'wallet-live';
      await publisher.claimNext(walletId);
      await publisher.update(jobId, 'validated', {
        validation: {
          canonicalRoots: [],
          canonicalRootMap: {},
          swmQuadCount: 2,
          authorityProofRef: 'proof:owner:1',
          transitionType: 'CREATE',
        },
      });
      await publisher.update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId } });

      await publisher.pause();
      expect(await publisher.recover()).toBe(1);

      expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
      expect(sends).toBe(0);
    });
  });

  it('leaves a held job alone when the named lane cannot finalize it locally yet', async () => {
    // A `recovered` verdict is not enough on its own: the named lane still has to repair the local
    // lifecycle. While that repair is blocked the job must stay exactly as it was — tx-bearing and
    // held — rather than being reset, which would resend a transaction the chain just confirmed.
    const publisher = createPublisher({
      chainRecoveryResolver: async () => RECOVERED,
      knowledgeAssetVmPublishRecoveryResolver: async () => kaVmRecoveryEvidence(),
      knowledgeAssetVmPublishHandler: {
        execute: async () => {
          sends += 1;
          throw new Error('the dispatcher must never cause a send');
        },
        finalizeRecovered: async () => {
          throw new Error('SWM catch-up still in progress');
        },
      },
    });
    const failed = await failAfterRecordedTxHash(publisher);

    expect(await publisher.recover()).toBe(0);

    const stillHeld = expectFailed(await publisher.getStatus(failed.jobId));
    expect(stillHeld.status).toBe('failed');
    expect(isHeldForChainProof(stillHeld)).toBe(true);
    expect(sends).toBe(0);
  });

  it('does not dispatch when no chain resolver is configured', async () => {
    const publisher = createPublisher({
      knowledgeAssetVmPublishRecoveryResolver: async () => kaVmRecoveryEvidence(),
    });
    const failed = await failAfterRecordedTxHash(publisher);

    expect(await publisher.recover()).toBe(0);
    expect(isHeldForChainProof(expectFailed(await publisher.getStatus(failed.jobId)))).toBe(true);
  });

  it('never touches a failed job that is not held', async () => {
    // Eligibility IS the held predicate. A failed job with no transaction to account for is the
    // retry lane's business, not this one's — and a dispatcher that swept every failed job would
    // spend a chain read per tick on jobs that have nothing to look up.
    const publisher = dispatcher({ status: 'not-found' });
    // `quorum_unmet` is allowed from 'broadcast' yet persists no txHash: a failure that is
    // pre-send-safe by construction, which is exactly the population this lane must not sweep.
    const failed = await failWithUnmetQuorum(publisher);
    const jobId = failed.jobId;

    expect(failed.failure.code).toBe('quorum_unmet');
    expect(isHeldForChainProof(failed)).toBe(false);
    expect(await publisher.recover()).toBe(0);
    // Still failed on its own schedule — the dispatcher did not reset it out from under the
    // ordinary retry lane.
    expect((await publisher.getStatus(jobId))?.status).toBe('failed');
  });
});
