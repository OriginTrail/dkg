/**
 * GH#2940 — a store-scheduler rejection is not a transaction-submission timeout.
 *
 * The scheduler's rejection message reads `Store scheduler queue wait timeout (<lane>: <operation>)`,
 * and the failure mapper classified on the bare substring `timeout`. A rejection raised BEFORE the
 * pre-send write-ahead durably recorded a transaction was therefore persisted as `tx_submit_timeout`
 * — "the transaction may be on chain, check it" — with a placeholder `timeoutMs: 0`, for a job with
 * no transaction to check. The code is not automatically retryable and the chain-proof dispatcher's
 * work queue is the held (evidence-bearing) population, so nothing ever resolved it: it sat at
 * `waitingReason: 'operator'`, `retryable: true`.
 *
 * What these rows pin, every one through the public queue entry points (`processNext`, the
 * claim-time sweep, `recover`, `retry`) and read back from the persisted record:
 *
 *   A. a rejection that PROVABLY preceded dispatch recovers through the existing bounded lane, as
 *      the SAME job, and never carries timeout metadata;
 *   B. anything that may have been dispatched keeps its chain-proof behaviour — held, never reset;
 *   C. each conjunct of the new proof is load-bearing (a solo-removal row per conjunct);
 *   D. the neighbouring classifications — a genuine RPC timeout, scheduler PROSE with no typed
 *      contract, an indeterminate store timeout — are unchanged, so the fix cannot be a relabel.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { StoreOperationTimeoutError, StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import type { AsyncLiftPublisherConfig, LiftJob, RawLiftRequest } from '../src/index.js';
import { hasBroadcastEvidence, isHeldForChainProof } from '../src/async-lift-retry-disposition.js';
import {
  TX_HASH,
  confirmedPublishResult,
  createAsyncLift2270Harness,
  expectFailed,
  scheduledDelay,
} from './_helpers/async-lift-2270-harness.js';
import { seedLegacyRawLiftTestJob } from './_helpers/legacy-raw-lift.js';
import {
  KA_VM_KA_UAL,
  kaVmPublishRequest,
  stageKnowledgeAssetShareSnapshot,
} from '../../../scripts/testing/ka-vm-publish.js';

type KaVmHandler = NonNullable<AsyncLiftPublisherConfig['knowledgeAssetVmPublishHandler']>;
type RawExecutor = NonNullable<AsyncLiftPublisherConfig['publishExecutor']>;
type FlushableStore = { flush?: () => Promise<void> };
type InsertableStore = { insert: (...args: unknown[]) => Promise<unknown> };

const RETRY_LANE = { retryBackoffBaseMs: 100, retryBackoffMaxMs: 250, rand: () => 0.5 } as const;

function schedulerBusy(reason: 'queue_wait_timeout' | 'queue_full' = 'queue_wait_timeout'): StoreSchedulerBusyError {
  return new StoreSchedulerBusyError(reason, 'normal', 'publisher.asyncLift.test', { storeOperation: 'query' });
}

/** What the EVM adapter does to a rejected write-ahead hook: a NEW plain Error, message only. */
function adapterRewrap(hookError: unknown): Error {
  return new Error(
    `chain:writeahead hook failed before publish broadcast: ${hookError instanceof Error ? hookError.message : String(hookError)}`,
  );
}

describe('GH#2940 store-scheduler rejection vs transaction-submission timeout', () => {
  const h = createAsyncLift2270Harness();

  beforeEach(() => h.reset());

  async function stage(): Promise<void> {
    await stageKnowledgeAssetShareSnapshot({ store: h.store });
  }

  /** A KA VM handler whose FIRST execute fails with `first()`; later attempts publish normally. */
  function failsOnceThenPublishes(
    first: () => unknown,
    attempts: { n: number },
  ): KaVmHandler {
    return {
      execute: async () => {
        attempts.n += 1;
        if (attempts.n === 1) throw first();
        return confirmedPublishResult();
      },
    };
  }

  /** A KA VM handler that fires the write-ahead, then throws `error` — the post-dispatch window. */
  function firesBroadcastThenThrows(error: unknown, attempts: { n: number }): KaVmHandler {
    return {
      execute: async (input) => {
        attempts.n += 1;
        await input.publishOptions.onBeforeBroadcast?.({ txHash: TX_HASH, nonce: 7 });
        throw error;
      },
    };
  }

  /** The recoverable pre-dispatch shape every row in section A asserts. */
  function expectRecordedAsPreDispatchStoreRejection(failed: ReturnType<typeof expectFailed>, cause: Error): void {
    expect(failed.failure).toMatchObject({
      failedFromState: 'validated',
      code: 'workspace_unavailable',
      mode: 'retryable',
      retryable: true,
      resolution: 'reset_to_accepted',
    });
    // The fake `timeoutMs: 0` placeholder cannot exist for a class that is not a timeout at all.
    expect(failed.failure.timeout).toBeUndefined();
    // The inner error survives verbatim, `(lane: operation)` suffix included.
    expect(failed.failure.message).toContain(cause.message);
    expect(failed.broadcast).toBeUndefined();
    expect(hasBroadcastEvidence(failed)).toBe(false);
    expect(isHeldForChainProof(failed)).toBe(false);
  }

  // ---------------------------------------------------------------------------------------------
  // A. Provably pre-dispatch → the existing bounded retry lane, same job.
  // ---------------------------------------------------------------------------------------------
  describe('A. a rejection that provably preceded dispatch', () => {
    const TYPED_REJECTIONS: ReadonlyArray<readonly [string, () => Error]> = [
      ['scheduler queue_wait_timeout', () => schedulerBusy('queue_wait_timeout')],
      ['scheduler queue_full', () => schedulerBusy('queue_full')],
      ['a store deadline that never started', () => new StoreOperationTimeoutError({
        backend: 'managed-oxigraph', operation: 'query', outcome: 'not_started',
      })],
    ];

    it.each(TYPED_REJECTIONS)(
      'records %s thrown before the write-ahead as a retryable pre-send failure and retries the SAME job',
      async (_label, make) => {
        const attempts = { n: 0 };
        const publisher = h.createPublisher({
          ...RETRY_LANE,
          knowledgeAssetVmPublishHandler: failsOnceThenPublishes(make, attempts),
        });
        await stage();
        const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

        const failed = expectFailed(await publisher.processNext('wallet-1'));

        expectRecordedAsPreDispatchStoreRejection(failed, make());
        expect(scheduledDelay(failed)).toBe(100);
        expect(publisher.describeConfiguredRetryState(failed)).toEqual({
          autoRetryEligible: true,
          waitingReason: 'backoff',
        });
        // Not due yet: the claim-time sweep leaves it failed and nothing re-runs.
        expect(await publisher.claimNext('wallet-2')).toBeNull();
        expect(attempts.n).toBe(1);

        h.advance(100);
        const finalized = await publisher.processNext('wallet-2');

        // The SAME immutable job, one budget unit spent, the second attempt published.
        expect(finalized?.jobId).toBe(jobId);
        expect(finalized?.status).toBe('finalized');
        expect(finalized?.retries.retryCount).toBe(1);
        expect(finalized?.timestamps.nextRetryAt).toBeUndefined();
        expect(attempts.n).toBe(2);
        expect((await publisher.getStats()).finalized).toBe(1);
      },
    );

    it('records a write-ahead store rejection — re-wrapped message-only by the adapter — as pre-send too', async () => {
      // The production shape of the write-ahead window: the recorder's own store work (job
      // transition, flush, journal) is what queue-times-out, the recorder rolls back, and the
      // EVM adapter re-throws it as a NEW plain Error — type and `cause` gone. The tx was never
      // signed-and-sent: the hook is awaited strictly before the send and fails closed.
      const attempts = { n: 0 };
      let flushes = 0;
      (h.store as unknown as FlushableStore).flush = async () => {
        flushes += 1;
        if (flushes === 1) throw schedulerBusy();
      };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: {
          execute: async (input) => {
            attempts.n += 1;
            if (attempts.n > 1) return confirmedPublishResult();
            try {
              await input.publishOptions.onBeforeBroadcast?.({ txHash: TX_HASH, nonce: 7 });
            } catch (hookError) {
              throw adapterRewrap(hookError);
            }
            throw new Error('unreachable: send after a failed write-ahead');
          },
        },
      });
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      const failed = expectFailed(await publisher.processNext('wallet-1'));

      expect(flushes).toBe(1);
      expectRecordedAsPreDispatchStoreRejection(failed, schedulerBusy());
      expect(publisher.describeConfiguredRetryState(failed)).toEqual({
        autoRetryEligible: true,
        waitingReason: 'backoff',
      });
      // Rolled back, not a phantom broadcast: the write-ahead record is gone.
      expect((await publisher.getStatus(jobId))?.status).toBe('failed');
      expect((await publisher.getStatus(jobId))?.broadcast).toBeUndefined();

      h.advance(100);
      const finalized = await publisher.processNext('wallet-2');
      expect(finalized?.jobId).toBe(jobId);
      expect(finalized?.status).toBe('finalized');
      expect(finalized?.retries.retryCount).toBe(1);
    });

    it('applies the same proof to the legacy raw-lift executor path', async () => {
      const attempts = { n: 0 };
      const rawRequest: RawLiftRequest = {
        swmId: 'swm-1',
        namespace: 'default',
        contextGraphId: 'music-social',
        shareOperationId: 'share-op-1',
        roots: [],
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: KA_VM_KA_UAL,
        assertionVersion: '1',
        publicTripleCount: 2,
        privateTripleCount: 0,
        scope: 'full',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      };
      const executor: RawExecutor = async () => {
        attempts.n += 1;
        if (attempts.n === 1) throw schedulerBusy();
        return confirmedPublishResult();
      };
      const publisher = h.createPublisher({ ...RETRY_LANE, publishExecutor: executor });
      await stage();
      const jobId = await seedLegacyRawLiftTestJob(h.store, rawRequest, {
        now: () => 1_000,
        idGenerator: () => 'raw-job-1',
      });

      const failed = expectFailed(await publisher.processNext('wallet-1'));

      expectRecordedAsPreDispatchStoreRejection(failed, schedulerBusy());
      h.advance(100);
      const finalized = await publisher.processNext('wallet-2');
      expect(finalized?.jobId).toBe(jobId);
      expect(finalized?.status).toBe('finalized');
      expect(finalized?.retries.retryCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // B. Possibly dispatched → chain-proof behaviour, bit for bit.
  // ---------------------------------------------------------------------------------------------
  describe('B. a rejection after the write-ahead recorded a transaction', () => {
    it('leaves a KA VM job in broadcast with its evidence — never failed, reset, or resent', async () => {
      const attempts = { n: 0 };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: firesBroadcastThenThrows(schedulerBusy(), attempts),
      });
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      const processed = await publisher.processNext('wallet-1');

      expect(processed?.status).toBe('broadcast');
      expect(processed?.status).not.toBe('failed');
      expect(processed && 'broadcast' in processed ? processed.broadcast?.txHash : undefined).toBe(TX_HASH);
      // No resolver is wired, so recovery cannot settle it — and it must not guess.
      expect(await publisher.recover()).toBe(0);
      h.advance(10_000);
      expect(await publisher.claimNext('wallet-2')).toBeNull();
      const held = await publisher.getStatus(jobId);
      expect(held?.status).toBe('broadcast');
      expect(attempts.n).toBe(1);
    });

    it('holds a raw-lift failure for chain proof: pending_chain_proof, never auto-retried, never reset by retry()', async () => {
      const attempts = { n: 0 };
      const rawRequest: RawLiftRequest = {
        swmId: 'swm-1',
        namespace: 'default',
        contextGraphId: 'music-social',
        shareOperationId: 'share-op-1',
        roots: [],
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: KA_VM_KA_UAL,
        assertionVersion: '1',
        publicTripleCount: 2,
        privateTripleCount: 0,
        scope: 'full',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        publishExecutor: async (input) => {
          attempts.n += 1;
          await input.publishOptions.onBeforeBroadcast?.({ txHash: TX_HASH, nonce: 7 });
          throw schedulerBusy();
        },
      });
      await stage();
      const jobId = await seedLegacyRawLiftTestJob(h.store, rawRequest, {
        now: () => 1_000,
        idGenerator: () => 'raw-job-1',
      });

      const failed = expectFailed(await publisher.processNext('wallet-1'));

      // Evidence-bearing: failed from `broadcast` WITH the hash the write-ahead recorded.
      expect(failed.failure.failedFromState).toBe('broadcast');
      expect(failed.broadcast?.txHash).toBe(TX_HASH);
      expect(isHeldForChainProof(failed)).toBe(true);
      expect(failed.timestamps.nextRetryAt).toBeUndefined();
      expect(publisher.describeConfiguredRetryState(failed)).toEqual({
        autoRetryEligible: false,
        waitingReason: 'pending_chain_proof',
      });
      h.advance(10_000);
      expect(await publisher.claimNext('wallet-2')).toBeNull();
      expect(await publisher.retryDetailed()).toMatchObject({ retried: 0, blockedPendingRecovery: 1 });
      expect((await publisher.getStatus(jobId))?.status).toBe('failed');
      expect(attempts.n).toBe(1);
    });

    it('stays held when the write-ahead rollback ITSELF is rejected and the record is still broadcast+hash', async () => {
      // The corner that makes the persisted-status conjunct load-bearing. The write-ahead commit
      // succeeded, the flush was rejected, and the ROLLBACK write was rejected too: the store now
      // holds `broadcast` + the signed hash although the recorder reports `rolled-back-pre-send`.
      // Recording this failure "from validated" would discard that evidence — it must degrade to
      // today's held failure instead, and must never throw out of failure recording.
      const attempts = { n: 0 };
      const store = h.store as unknown as FlushableStore & InsertableStore;
      const originalInsert = store.insert.bind(store);
      let armed = false;
      let rollbackInsertRejected = false;
      store.flush = async () => {
        armed = true;
        throw schedulerBusy();
      };
      store.insert = async (...args: unknown[]) => {
        if (armed && !rollbackInsertRejected) {
          rollbackInsertRejected = true;
          throw schedulerBusy();
        }
        return await originalInsert(...args);
      };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: {
          execute: async (input) => {
            attempts.n += 1;
            try {
              await input.publishOptions.onBeforeBroadcast?.({ txHash: TX_HASH, nonce: 7 });
            } catch (hookError) {
              throw adapterRewrap(hookError);
            }
            throw new Error('unreachable: send after a failed write-ahead');
          },
        },
      });
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      const failed = expectFailed(await publisher.processNext('wallet-1'));

      expect(rollbackInsertRejected).toBe(true);
      expect(failed.failure.failedFromState).toBe('broadcast');
      expect(failed.broadcast?.txHash).toBe(TX_HASH);
      expect(failed.failure.code).not.toBe('workspace_unavailable');
      expect(isHeldForChainProof(failed)).toBe(true);
      expect(failed.timestamps.nextRetryAt).toBeUndefined();
      expect(publisher.describeConfiguredRetryState(failed)).toEqual({
        autoRetryEligible: false,
        waitingReason: 'pending_chain_proof',
      });
      h.advance(10_000);
      expect(await publisher.claimNext('wallet-2')).toBeNull();
      expect((await publisher.getStatus(jobId))?.status).toBe('failed');
      expect(attempts.n).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // C/D. Neighbouring classifications must not move: the fix is a proof, not a relabel.
  // ---------------------------------------------------------------------------------------------
  describe('D. classifications that must stay exactly as they were', () => {
    const LEGACY_CONTROLS: ReadonlyArray<readonly [string, () => unknown]> = [
      ['a genuine RPC submission timeout', () => new Error('RPC submit timed out after 30s')],
      ['scheduler PROSE with no typed contract', () => new Error('Store scheduler queue wait timeout (normal: publisher.asyncLift.test)')],
      ['a busy lookalike missing the outcome tag', () => Object.assign(new Error('Store scheduler queue wait timeout (normal: x)'), {
        code: 'STORE_SCHEDULER_BUSY',
        retryable: true,
        outcome: 'not_started',
        reason: 'queue_wait_timeout',
        priority: 'normal',
        operation: 'x',
      })],
      ['an INDETERMINATE store timeout (the mutation may have applied)', () => new StoreOperationTimeoutError({
        backend: 'managed-oxigraph', operation: 'query', outcome: 'indeterminate',
      })],
    ];

    it.each(LEGACY_CONTROLS)(
      'keeps %s on the legacy broadcast-origin classification, never the pre-send retry lane',
      async (_label, make) => {
        const attempts = { n: 0 };
        const publisher = h.createPublisher({
          ...RETRY_LANE,
          knowledgeAssetVmPublishHandler: failsOnceThenPublishes(make, attempts),
        });
        await stage();
        await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

        const failed = expectFailed(await publisher.processNext('wallet-1'));

        expect(failed.failure.failedFromState).toBe('broadcast');
        expect(failed.failure.code).not.toBe('workspace_unavailable');
        expect(failed.timestamps.nextRetryAt).toBeUndefined();
        expect(publisher.describeConfiguredRetryState(failed).autoRetryEligible).toBe(false);
        h.advance(10_000);
        expect(await publisher.claimNext('wallet-2')).toBeNull();
        expect(attempts.n).toBe(1);
      },
    );

    it('still records a genuine RPC timeout as tx_submit_timeout with check-chain timeout metadata', async () => {
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: failsOnceThenPublishes(
          () => new Error('RPC submit timed out after 30s'),
          { n: 0 },
        ),
      });
      await stage();
      await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      const failed = expectFailed(await publisher.processNext('wallet-1'));

      expect(failed.failure).toMatchObject({
        failedFromState: 'broadcast',
        code: 'tx_submit_timeout',
        phase: 'broadcast',
        mode: 'timeout',
        retryable: true,
        resolution: 'check_chain_then_finalize_or_reset',
      });
      expect(failed.failure.timeout?.handling).toBe('check_chain_then_finalize_or_reset');
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Lane controls: the recovery rides the existing budget / kill-switch / restart machinery.
  // ---------------------------------------------------------------------------------------------
  describe('lane controls', () => {
    it('honours the operator kill-switch: still pre-send and recorded, but nothing is scheduled', async () => {
      const attempts = { n: 0 };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        autoRetryEnabled: false,
        knowledgeAssetVmPublishHandler: failsOnceThenPublishes(() => schedulerBusy(), attempts),
      });
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      const failed = expectFailed(await publisher.processNext('wallet-1'));

      expectRecordedAsPreDispatchStoreRejection(failed, schedulerBusy());
      expect(failed.timestamps.nextRetryAt).toBeUndefined();
      expect(publisher.describeConfiguredRetryState(failed)).toEqual({
        autoRetryEligible: false,
        waitingReason: 'operator',
      });
      h.advance(10_000);
      expect(await publisher.claimNext('wallet-2')).toBeNull();
      // The manual path is untouched: it re-runs the same job.
      expect(await publisher.retry()).toBe(1);
      expect((await publisher.getStatus(jobId))?.status).toBe('accepted');
    });

    it('spends the shared budget on a persistent rejection and then reports exhausted, without a hot loop', async () => {
      const attempts = { n: 0 };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        maxRetries: 2,
        knowledgeAssetVmPublishHandler: {
          execute: async () => {
            attempts.n += 1;
            throw schedulerBusy();
          },
        },
      });
      await stage();
      await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      let failed = expectFailed(await publisher.processNext('wallet-1'));
      expect(scheduledDelay(failed)).toBe(100);
      h.advance(100);
      failed = expectFailed(await publisher.processNext('wallet-2'));
      expect(failed.retries.retryCount).toBe(1);
      expect(scheduledDelay(failed)).toBe(200);
      // Not due: the sweep must not fire early.
      h.advance(150);
      expect(await publisher.claimNext('wallet-x')).toBeNull();
      h.advance(50);
      failed = expectFailed(await publisher.processNext('wallet-3'));

      expect(failed.retries.retryCount).toBe(2);
      expect(failed.timestamps.nextRetryAt).toBeUndefined();
      expect(publisher.describeConfiguredRetryState(failed)).toEqual({
        autoRetryEligible: false,
        waitingReason: 'exhausted',
      });
      expect(attempts.n).toBe(3);
      h.advance(60_000);
      expect(await publisher.claimNext('wallet-4')).toBeNull();
      expect(attempts.n).toBe(3);
    });

    it('fires the persisted retry exactly once across a publisher restart', async () => {
      const attempts = { n: 0 };
      const handler = failsOnceThenPublishes(() => schedulerBusy(), attempts);
      const first = h.createPublisher({ ...RETRY_LANE, knowledgeAssetVmPublishHandler: handler });
      await stage();
      const jobId = await first.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      expectFailed(await first.processNext('wallet-1'));
      h.advance(100);

      const restarted = h.createPublisher({ ...RETRY_LANE, knowledgeAssetVmPublishHandler: handler });
      const finalized = await restarted.processNext('wallet-2');
      expect(finalized?.jobId).toBe(jobId);
      expect(finalized?.status).toBe('finalized');
      expect(finalized?.retries.retryCount).toBe(1);

      const third = h.createPublisher({ ...RETRY_LANE, knowledgeAssetVmPublishHandler: handler });
      expect(await third.claimNext('wallet-3')).toBeNull();
      const stats = await third.getStats();
      expect([stats.accepted, stats.claimed, stats.failed, stats.finalized]).toEqual([0, 0, 0, 1]);
      expect(attempts.n).toBe(2);
    });

    it('lets an operator retry() race the sweep for at most one budget unit', async () => {
      const attempts = { n: 0 };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: failsOnceThenPublishes(() => schedulerBusy(), attempts),
      });
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      expectFailed(await publisher.processNext('wallet-1'));
      h.advance(100);

      // Manual retry lands first; the due sweep then finds nothing failed to reaccept.
      expect(await publisher.retry()).toBe(1);
      const finalized = await publisher.processNext('wallet-2');

      expect(finalized?.jobId).toBe(jobId);
      expect(finalized?.status).toBe('finalized');
      expect(finalized?.retries.retryCount).toBe(1);
      expect(attempts.n).toBe(2);
    });
  });
});

// Keep the type import used even when a row above is removed during mutation checks.
export type { LiftJob };
