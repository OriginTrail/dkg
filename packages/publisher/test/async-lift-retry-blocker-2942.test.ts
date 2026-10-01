/**
 * GH#2942 Part B — why a job is not moving, derived on read.
 *
 * `retryState` used to say only THAT a job waits (`pending_chain_proof`, `operator`, `exhausted`).
 * It now also carries a `blocker`: a closed code plus a fixed summary, derived from the record and
 * the node's wiring — never persisted, never carrying instance data (no URL, hash or payload).
 *
 *   A. the exit predicate and the dispatcher agree: `hasAutomaticRecoveryExit` is built from the
 *      SAME carriers the lookup is (a held job promised an automatic exit must actually be asked);
 *   B. the held-job blocker: every gap of the record is reported, not only the first, and the
 *      capability half says whether this node can act on a complete record;
 *   C. the operator / exhausted blockers and their precedence;
 *   D. rows that must carry no blocker at all, and the 2-argument call shape that predates it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AsyncLiftChainProofLookup,
  AsyncLiftChainProofResolution,
  LiftJob,
} from '../src/index.js';
import type { PersistedFailedJob } from '../src/async-lift-publisher-utils.js';
import {
  LIFT_JOB_RETRY_BLOCKER_SUMMARY,
  describeAutomaticRecoveryExit,
  describeRetryProjection,
  hasAutomaticRecoveryExit,
  type HeldRecoveryGap,
} from '../src/async-lift-retry-disposition.js';
import { DEFAULT_CONTROL_GRAPH_URI, jobSubject, serializeJob } from '../src/async-lift-control-plane.js';
import { TX_HASH, createAsyncLift2270Harness, expectFailed } from './_helpers/async-lift-2270-harness.js';
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { RETRY_LANE, createStoreRejectionFixtures, schedulerBusy } from './_helpers/store-rejection-2940.js';

const ROOT = `0x${'12'.repeat(32)}`;

describe('GH#2942 derived retry blocker', () => {
  const h = createAsyncLift2270Harness();
  const { stage, failsOnceThenPublishes } = createStoreRejectionFixtures(h);

  beforeEach(() => h.reset());

  // ---- fixtures: a held job, and the shapes obtained by removing exactly one ingredient ----------

  /** A held CREATE whose record carries every ingredient an automatic exit needs. */
  async function completeCreate(): Promise<PersistedFailedJob> {
    const failed = await h.failAfterRecordedTxHash(h.createPublisher());
    return { ...failed, broadcast: { ...failed.broadcast!, nonce: 7 } } as PersistedFailedJob;
  }

  /** The same job as an UPDATE: it needs the root it intended to install instead of a nonce. */
  function asUpdate(job: PersistedFailedJob, options: { readonly root?: string } = { root: ROOT }): PersistedFailedJob {
    const request = job.request as { knowledgeAssetVmPublish: Record<string, unknown> };
    return {
      ...job,
      broadcast: { ...job.broadcast!, operationKind: 'update', nonce: undefined },
      request: {
        ...request,
        knowledgeAssetVmPublish: { ...request.knowledgeAssetVmPublish, sealMerkleRoot: options.root },
      },
    } as unknown as PersistedFailedJob;
  }

  const OPTIONS_CAPABLE = { autoRetryEnabled: true, canSettleHeldJob: () => true } as const;

  // ---------------------------------------------------------------------------------------------
  // A. The predicate and the dispatcher read the same carriers.
  // ---------------------------------------------------------------------------------------------
  describe('A. an exit the dispatcher actually takes', () => {
    /** The signer carrier the lookup uses, with the claim wallet present but NOT a fallback. */
    function recoveryCarrier(job: PersistedFailedJob, recovery: Record<string, unknown>): PersistedFailedJob {
      return {
        ...job,
        broadcast: undefined,
        recovery: { action: 'reset_to_accepted', recoveredFromStatus: 'broadcast', txHashChecked: TX_HASH, operationKind: 'create', ...recovery },
        failure: { ...job.failure, failedFromState: 'claimed', code: 'workspace_unavailable' },
      } as unknown as PersistedFailedJob;
    }

    it('does not promise an exit for an inherited hash whose signer was never preserved (the claim wallet is not a fallback)', async () => {
      const job = recoveryCarrier(await completeCreate(), { nonceChecked: 7 });
      expect(job.claim?.walletId).toBeTruthy();

      expect(hasAutomaticRecoveryExit(job)).toBe(false);
      expect(describeAutomaticRecoveryExit(job)).toEqual({ exit: false, gaps: ['signer_wallet'] });
    });

    it('promises an exit for a CREATE whose nonce survives only in the recovery record', async () => {
      const job = recoveryCarrier(await completeCreate(), { walletIdChecked: 'wallet-tx-job-1', nonceChecked: 7 });

      expect(hasAutomaticRecoveryExit(job)).toBe(true);
    });

    // The one-directional pin: exit:true must imply the dispatcher really asks the chain. (The
    // converse is not claimed — a record without a nonce is still asked, it just cannot be released.)
    it.each<readonly [string, (job: PersistedFailedJob) => PersistedFailedJob]>([
      ['a complete live-broadcast CREATE', (job) => job],
      ['a CREATE carrying hash, signer and nonce only in the recovery record', (job) => recoveryCarrier(job, { walletIdChecked: 'wallet-tx-job-1', nonceChecked: 7 })],
      ['a complete UPDATE', (job) => asUpdate(job)],
    ])('asks the chain about %s whenever the predicate promises an exit', async (_label, shape) => {
      const asked: AsyncLiftChainProofLookup[] = [];
      const publisher = h.createPublisher({
        chainProofResolver: async (lookup): Promise<AsyncLiftChainProofResolution> => {
          asked.push(lookup);
          return { status: 'inconclusive' };
        },
        knowledgeAssetVmPublishRecoveryResolver: async () => null,
        knowledgeAssetVmPublishHandler: { execute: async () => { throw new Error('never sends'); }, finalizeRecovered: async () => undefined },
      });
      const job = shape(await (async () => {
        const failed = await h.failAfterRecordedTxHash(publisher);
        return { ...failed, broadcast: { ...failed.broadcast!, nonce: 7 } } as PersistedFailedJob;
      })());
      await h.store.deleteByPattern({ subject: jobSubject(job.jobId), graph: DEFAULT_CONTROL_GRAPH_URI });
      await h.store.insert(serializeJob(job as unknown as LiftJob, DEFAULT_CONTROL_GRAPH_URI, { payloadSchema: 'legacy-v0' }));

      expect(hasAutomaticRecoveryExit(job)).toBe(true);
      await publisher.recover();

      expect(asked).toHaveLength(1);
      expect(asked[0]?.txHash).toBe(TX_HASH);
    });

    it('never asks about a record that has no hash or no preserved signer — the shapes whose exit is denied', async () => {
      const asked: AsyncLiftChainProofLookup[] = [];
      const publisher = h.createPublisher({
        chainProofResolver: async (lookup): Promise<AsyncLiftChainProofResolution> => {
          asked.push(lookup);
          return { status: 'inconclusive' };
        },
        knowledgeAssetVmPublishRecoveryResolver: async () => null,
        knowledgeAssetVmPublishHandler: { execute: async () => { throw new Error('never sends'); }, finalizeRecovered: async () => undefined },
      });
      const failed = await h.failAfterRecordedTxHash(publisher);
      const job = recoveryCarrier({ ...failed, broadcast: { ...failed.broadcast!, nonce: 7 } } as PersistedFailedJob, { nonceChecked: 7 });
      await h.store.deleteByPattern({ subject: jobSubject(job.jobId), graph: DEFAULT_CONTROL_GRAPH_URI });
      await h.store.insert(serializeJob(job as unknown as LiftJob, DEFAULT_CONTROL_GRAPH_URI, { payloadSchema: 'legacy-v0' }));

      expect(hasAutomaticRecoveryExit(job)).toBe(false);
      await publisher.recover();

      expect(asked).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // B. The held-job blocker.
  // ---------------------------------------------------------------------------------------------
  describe('B. a job held for chain proof', () => {
    it('says the chain is re-checked, and that the latest lookup outcome is not retained, for a complete record this node can settle', async () => {
      const job = await completeCreate();

      const projection = describeRetryProjection(job, OPTIONS_CAPABLE);

      expect(projection).toEqual({
        autoRetryEligible: false,
        waitingReason: 'pending_chain_proof',
        blocker: { code: 'chain_recheck_pending', summary: LIFT_JOB_RETRY_BLOCKER_SUMMARY.chain_recheck_pending },
      });
    });

    it('says recovery is not configured for a complete record this node cannot settle', async () => {
      const job = await completeCreate();

      const projection = describeRetryProjection(job, { autoRetryEnabled: true, canSettleHeldJob: () => false });

      expect(projection.waitingReason).toBe('pending_chain_proof');
      expect(projection.blocker).toEqual({
        code: 'recovery_not_configured',
        summary: LIFT_JOB_RETRY_BLOCKER_SUMMARY.recovery_not_configured,
      });
    });

    it('does not guess when the caller supplies no capability: no blocker, the same two keys as before', async () => {
      const job = await completeCreate();

      expect(describeRetryProjection(job, { autoRetryEnabled: true })).toEqual({
        autoRetryEligible: false,
        waitingReason: 'pending_chain_proof',
      });
    });

    // Complete-except-one: each row removes exactly one ingredient from a record that is otherwise
    // complete, and the positive control above proves the rest of the record is not the cause.
    const GAPS: ReadonlyArray<readonly [string, () => Promise<PersistedFailedJob>, string, readonly HeldRecoveryGap[]]> = [
      ['no hash on either carrier', async () => {
        // An 'included' origin is held without a hash. The operation marker and nonce ride in the
        // recovery record so they are not what is missing.
        const job = await completeCreate();
        return {
          ...job,
          broadcast: undefined,
          recovery: { action: 'reset_to_accepted', recoveredFromStatus: 'included', operationKind: 'create', nonceChecked: 7 },
          failure: { ...job.failure, failedFromState: 'included' },
        } as unknown as PersistedFailedJob;
      }, 'no_transaction_hash', ['transaction_hash', 'signer_wallet']],
      ['no preserved signer', async () => {
        const job = await completeCreate();
        return {
          ...job,
          broadcast: undefined,
          recovery: { action: 'reset_to_accepted', recoveredFromStatus: 'broadcast', txHashChecked: TX_HASH, operationKind: 'create', nonceChecked: 7 },
          failure: { ...job.failure, failedFromState: 'claimed' },
        } as unknown as PersistedFailedJob;
      }, 'no_signer_wallet', ['signer_wallet']],
      ['no validation', async () => ({ ...(await completeCreate()), validation: undefined }) as unknown as PersistedFailedJob, 'claim_or_validation_missing', ['claim_or_validation']],
      ['no pinned identity', async () => {
        const job = await completeCreate();
        const request = job.request as { knowledgeAssetVmPublish: { seal: Record<string, unknown> } };
        return {
          ...job,
          request: { ...request, knowledgeAssetVmPublish: { ...request.knowledgeAssetVmPublish, seal: { ...request.knowledgeAssetVmPublish.seal, reservedKaId: undefined } } },
        } as unknown as PersistedFailedJob;
      }, 'publish_identity_unpinned', ['publish_identity']],
      ['no operation marker', async () => {
        const job = await completeCreate();
        return { ...job, broadcast: { ...job.broadcast!, operationKind: undefined } } as unknown as PersistedFailedJob;
      }, 'operation_unmarked', ['operation_marker']],
      ['a CREATE with no nonce', async () => {
        const job = await completeCreate();
        return { ...job, broadcast: { ...job.broadcast!, nonce: undefined } } as unknown as PersistedFailedJob;
      }, 'nonce_missing', ['nonce']],
      ['an UPDATE with no intended root', async () => asUpdate(await completeCreate(), { root: undefined }), 'intended_root_missing', ['intended_root']],
    ];

    it.each(GAPS)('names the gap for a record with %s, without asking whether the node could settle it', async (_label, make, code, missing) => {
      const job = await make();
      const canSettle = vi.fn(() => true);

      const projection = describeRetryProjection(job, { autoRetryEnabled: true, canSettleHeldJob: canSettle });

      expect(projection.waitingReason).toBe('pending_chain_proof');
      expect(projection.blocker).toEqual({
        code,
        summary: LIFT_JOB_RETRY_BLOCKER_SUMMARY[code as keyof typeof LIFT_JOB_RETRY_BLOCKER_SUMMARY],
        missing,
      });
      expect(canSettle).not.toHaveBeenCalled();
    });

    it('reports EVERY gap, so an operator is not sent to fix one and then meet the next', async () => {
      const job = await completeCreate();
      const request = job.request as { knowledgeAssetVmPublish: { seal: Record<string, unknown> } };
      const gappy = {
        ...job,
        validation: undefined,
        broadcast: { ...job.broadcast!, nonce: undefined },
        request: { ...request, knowledgeAssetVmPublish: { ...request.knowledgeAssetVmPublish, seal: { ...request.knowledgeAssetVmPublish.seal, reservedKaId: undefined } } },
      } as unknown as PersistedFailedJob;

      expect(describeAutomaticRecoveryExit(gappy)).toEqual({
        exit: false,
        gaps: ['claim_or_validation', 'publish_identity', 'nonce'],
      });
      expect(describeRetryProjection(gappy, OPTIONS_CAPABLE).blocker?.code).toBe('claim_or_validation_missing');
    });

    it('does not apply an operation-specific rule to a record whose operation is unknown', async () => {
      const job = await completeCreate();
      const unmarked = { ...job, broadcast: { ...job.broadcast!, operationKind: undefined, nonce: undefined } } as unknown as PersistedFailedJob;

      expect(describeAutomaticRecoveryExit(unmarked)).toEqual({ exit: false, gaps: ['operation_marker'] });
    });

    it('hands the SAME blocker to the admission error a re-submit receives, beside the unchanged retryable promise', async () => {
      const publisher = h.createPublisher();
      const request = kaVmPublishRequest();
      const held = await h.failAfterRecordedTxHash(publisher, request);
      const blocker = publisher.describeConfiguredRetryState(held).blocker;
      expect(blocker?.code).toBe('nonce_missing');

      await expect(publisher.enqueueKnowledgeAssetVmPublish(request)).rejects.toMatchObject({
        code: 'LIFT_JOB_PENDING_CHAIN_PROOF',
        existingJobId: held.jobId,
        retryable: false,
        blocker,
      });
    });

    it('keeps hasAutomaticRecoveryExit a pure view of the description', async () => {
      const complete = await completeCreate();
      const gappy = { ...complete, validation: undefined } as unknown as PersistedFailedJob;

      expect(hasAutomaticRecoveryExit(complete)).toBe(describeAutomaticRecoveryExit(complete).exit);
      expect(hasAutomaticRecoveryExit(gappy)).toBe(describeAutomaticRecoveryExit(gappy).exit);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // C. Operator and exhausted blockers.
  // ---------------------------------------------------------------------------------------------
  describe('C. a retryable, evidence-free job that nothing automatic will move', () => {
    /** A `workspace_unavailable` failure recorded while the lane was OFF: allow-listed, never scheduled. */
    async function recordedWhileLaneOff(): Promise<PersistedFailedJob> {
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        autoRetryEnabled: false,
        knowledgeAssetVmPublishHandler: failsOnceThenPublishes(() => schedulerBusy(), { n: 0 }),
      });
      await stage();
      await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      return expectFailed(await publisher.processNext('wallet-1'));
    }

    it('names the code as not auto-retryable, and ranks that above a switched-off lane', async () => {
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: failsOnceThenPublishes(() => new Error('RPC submit timed out after 30s'), { n: 0 }),
      });
      await stage();
      await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      const failed = expectFailed(await publisher.processNext('wallet-1'));
      expect(failed.failure.code).toBe('tx_submit_timeout');

      for (const autoRetryEnabled of [true, false]) {
        const projection = describeRetryProjection(failed, { autoRetryEnabled });
        expect(projection.waitingReason).toBe('operator');
        // Switching the lane on cannot help a code that is not in it, so the lane is never blamed.
        expect(projection.blocker).toEqual({
          code: 'not_auto_retryable',
          summary: LIFT_JOB_RETRY_BLOCKER_SUMMARY.not_auto_retryable,
        });
      }
    });

    it('names a switched-off lane for an allow-listed code, and an unscheduled one when the lane is on', async () => {
      const failed = await recordedWhileLaneOff();
      expect(failed.failure.code).toBe('workspace_unavailable');
      expect(failed.timestamps.nextRetryAt).toBeUndefined();

      expect(describeRetryProjection(failed, { autoRetryEnabled: false })).toEqual({
        autoRetryEligible: false,
        waitingReason: 'operator',
        blocker: { code: 'auto_retry_disabled', summary: LIFT_JOB_RETRY_BLOCKER_SUMMARY.auto_retry_disabled },
      });
      expect(describeRetryProjection(failed, { autoRetryEnabled: true })).toEqual({
        autoRetryEligible: false,
        waitingReason: 'operator',
        blocker: { code: 'retry_not_scheduled', summary: LIFT_JOB_RETRY_BLOCKER_SUMMARY.retry_not_scheduled },
      });
    });

    it('does not promise that switching the lane back on schedules a job that failed while it was off', () => {
      expect(LIFT_JOB_RETRY_BLOCKER_SUMMARY.auto_retry_disabled).toMatch(/does not schedule|not scheduled|nothing was scheduled/i);
    });

    it('names the spent budget, and how it is re-armed, for an exhausted job', async () => {
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        maxRetries: 1,
        knowledgeAssetVmPublishHandler: { execute: async () => { throw schedulerBusy(); } },
      });
      await stage();
      await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      expectFailed(await publisher.processNext('wallet-1'));
      h.advance(100);
      const exhausted = expectFailed(await publisher.processNext('wallet-2'));

      expect(publisher.describeConfiguredRetryState(exhausted)).toEqual({
        autoRetryEligible: false,
        waitingReason: 'exhausted',
        blocker: { code: 'retry_budget_spent', summary: LIFT_JOB_RETRY_BLOCKER_SUMMARY.retry_budget_spent },
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // D. No blocker where nothing is blocking; summaries carry no instance data.
  // ---------------------------------------------------------------------------------------------
  describe('D. rows with no blocker, and the summaries themselves', () => {
    it('adds nothing to a job that is waiting on its own backoff, or one that is terminal', async () => {
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: failsOnceThenPublishes(() => schedulerBusy(), { n: 0 }),
      });
      await stage();
      await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      const backoff = expectFailed(await publisher.processNext('wallet-1'));

      expect(publisher.describeConfiguredRetryState(backoff)).toEqual({ autoRetryEligible: true, waitingReason: 'backoff' });
      const terminal = { ...backoff, failure: { ...backoff.failure, retryable: false } } as unknown as PersistedFailedJob;
      expect(describeRetryProjection(terminal, { autoRetryEnabled: true })).toEqual({ autoRetryEligible: false });
    });

    it('keeps every summary free of anything instance-specific', () => {
      for (const summary of Object.values(LIFT_JOB_RETRY_BLOCKER_SUMMARY)) {
        expect(summary).not.toMatch(/https?:\/\//i);
        expect(summary).not.toMatch(/0x[0-9a-f]{8,}/i);
        expect(summary.length).toBeGreaterThan(40);
      }
    });
  });
});
