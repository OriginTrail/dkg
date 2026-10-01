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
 *
 * This file: pre-dispatch classification (A), caller-proof independence (C) and the neighbouring
 * classifications that must not move (D). Post-dispatch holds and chain-proof recovery are in
 * async-lift-store-rejection-recovery-2940; retry-lane controls in async-lift-store-rejection-retry-2940.
 * Shared fixtures: test/_helpers/store-rejection-2940.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { StoreOperationTimeoutError } from '@origintrail-official/dkg-storage';
import type { ActiveLiftJobClaim } from '../src/index.js';
import { executionFailureEvidence } from '../src/async-lift-publisher-impl.js';
import { TX_HASH, confirmedPublishResult, createAsyncLift2270Harness, expectFailed, scheduledDelay } from './_helpers/async-lift-2270-harness.js';
import { seedLegacyRawLiftTestJob } from './_helpers/legacy-raw-lift.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { RETRY_LANE, adapterRewrap, createStoreRejectionFixtures, rawLiftRequest, schedulerBusy } from './_helpers/store-rejection-2940.js';
import type { FlushableStore } from './_helpers/store-rejection-2940.js';

describe('GH#2940 store-scheduler rejection vs transaction-submission timeout: classification', () => {
  const h = createAsyncLift2270Harness();
  const { stage, failsOnceThenPublishes, expectRecordedAsPreDispatchStoreRejection } = createStoreRejectionFixtures(h);

  beforeEach(() => h.reset());

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
      // The typed contract, not the prose, decides: this message carries none of the words the
      // legacy keyword chain looks for, so without typed precedence it falls through to a
      // terminal `canonicalization_failed` (or the broadcast catch-all), never the retry lane.
      ['a typed not_started whose message carries no keyword', () => new StoreOperationTimeoutError({
        backend: 'managed-oxigraph',
        operation: 'construct',
        outcome: 'not_started',
        message: 'Managed Oxigraph is recovering; construct was not started',
      })],
      // The storage guard deliberately accepts a re-wrapped error that kept only the stable code
      // and outcome; that is still the storage layer's own statement that nothing started.
      ['a re-wrapped typed not_started that kept only code and outcome', () => Object.assign(
        new Error('re-wrapped by a transport'),
        { code: 'STORE_OPERATION_TIMEOUT', outcome: 'not_started' },
      )],
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

    it('fails closed if the write-ahead hook is invoked again after it was rejected', async () => {
      // The recorder's once-only latch stays set when the first attempt fails. Without a
      // fail-closed re-entry, a caller that reuses the hook across dispatches would get a silent
      // success and could send under the one outcome the failure writer reads as "nothing left
      // this node".
      let secondInvocation: 'rejected' | 'returned' | undefined;
      let flushes = 0;
      (h.store as unknown as FlushableStore).flush = async () => {
        flushes += 1;
        if (flushes === 1) throw schedulerBusy();
      };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: {
          execute: async (input) => {
            let firstError: unknown;
            try {
              await input.publishOptions.onBeforeBroadcast?.({ txHash: TX_HASH, nonce: 7 });
            } catch (hookError) {
              firstError = hookError;
            }
            try {
              await input.publishOptions.onBeforeBroadcast?.({ txHash: TX_HASH, nonce: 7 });
              secondInvocation = 'returned';
            } catch {
              secondInvocation = 'rejected';
            }
            throw adapterRewrap(firstError);
          },
        },
      });
      await stage();
      await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      const failed = expectFailed(await publisher.processNext('wallet-1'));

      expect(secondInvocation).toBe('rejected');
      expectRecordedAsPreDispatchStoreRejection(failed, schedulerBusy());
    });

    it('applies to an UPDATE-kind job too: pre-dispatch retries as the same job', async () => {
      // `reset_to_accepted` replays the immutable request, which is safe for an update only
      // because nothing was sent — the case the chain-proof lane refuses to release by absence.
      const publisher = h.createPublisher(RETRY_LANE);
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
        vmCurrentAssertion: 'aa'.repeat(32),
        assertionVersion: '2',
        name: 'update-album',
        shareOperationId: 'update-op',
        intentKey: `sha256:${'d1'.repeat(32)}`,
      }));
      const claimed = await publisher.claimNext('wallet-1');
      await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      const session = publisher.openClaimSession(claimed as ActiveLiftJobClaim);

      const failed = expectFailed(await session.recordExecutionFailure(
        'broadcast',
        schedulerBusy(),
        { neverDispatched: true },
      ));

      expectRecordedAsPreDispatchStoreRejection(failed, schedulerBusy());
      expect(publisher.describeConfiguredRetryState(failed)).toEqual({
        autoRetryEligible: true,
        waitingReason: 'backoff',
      });
      h.advance(100);
      const reclaimed = await publisher.claimNext('wallet-2');
      expect(reclaimed?.jobId).toBe(jobId);
      expect(reclaimed?.retries.retryCount).toBe(1);
    });

    it('keeps one contiguous journal and binds a client re-submit to the SAME job', async () => {
      const attempts = { n: 0 };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        journalWrites: true,
        knowledgeAssetVmPublishHandler: failsOnceThenPublishes(() => schedulerBusy(), attempts),
      });
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      expectFailed(await publisher.processNext('wallet-1'));

      // A client re-submitting the identical request while the job waits in backoff gets the
      // SAME job back — never a replacement for a lifecycle that already has one.
      expect(await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest())).toBe(jobId);
      expect((await publisher.getStats()).accepted + (await publisher.getStats()).failed).toBe(1);

      h.advance(100);
      const finalized = await publisher.processNext('wallet-2');
      expect(finalized?.jobId).toBe(jobId);

      const journal = await publisher.readJournalByJob(jobId);
      const kinds = journal.entries.map((e) => e.kind);
      expect(journal.complete).toBe(true);
      expect(journal.entries.map((e) => e.seq)).toEqual(journal.entries.map((_, i) => i));
      // The pre-flush rollback sentinel never lands in the journal as an entry.
      expect(kinds).not.toContain('rollback-noop' as never);
      // The failure is journalled under the class it really is, not as a transaction timeout.
      const failedEntry = journal.entries.find((e) => e.kind === 'failed');
      expect(failedEntry?.failureCode).toBe('workspace_unavailable');
      expect(journal.entries.some((e) => e.failureCode === 'tx_submit_timeout')).toBe(false);
      // No transaction hash is journalled up to and including the failure: nothing was signed.
      // (The later successful retry journals its own hash — that is a different attempt.)
      const failedAt = journal.entries.findIndex((e) => e.kind === 'failed');
      expect(journal.entries.slice(0, failedAt + 1).every((e) => e.txHash === undefined)).toBe(true);
    });

    it('records a typed rejection from the FINAL pre-execute preflight the same way', async () => {
      // The second `handler.preflight` runs after the recorder exists and before `execute`; its
      // failure goes through the same failure writer and must carry the same proof.
      const attempts = { n: 0 };
      let preflights = 0;
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: {
          preflight: async () => {
            preflights += 1;
            if (preflights === 2) throw schedulerBusy();
            return { action: 'execute' as const };
          },
          execute: async () => {
            attempts.n += 1;
            return confirmedPublishResult();
          },
        },
      });
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      const failed = expectFailed(await publisher.processNext('wallet-1'));

      expect(preflights).toBe(2);
      expect(attempts.n).toBe(0);
      expectRecordedAsPreDispatchStoreRejection(failed, schedulerBusy());
      h.advance(100);
      const finalized = await publisher.processNext('wallet-2');
      expect(finalized?.jobId).toBe(jobId);
      expect(finalized?.status).toBe('finalized');
      expect(finalized?.retries.retryCount).toBe(1);
    });

    it('applies the same proof to the legacy raw-lift executor path', async () => {
      const attempts = { n: 0 };
      const rawRequest = rawLiftRequest();
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
  // C. Each barrier is independent. The positional proof and the persisted status overlap in
  // practice (a recorded write-ahead leaves the record at 'broadcast'), so a row that only runs
  // the happy flow cannot tell them apart. These drive the claim session directly.
  // ---------------------------------------------------------------------------------------------
  describe('C. the caller proof is trusted on its own, not inferred from the record', () => {
    async function validatedSession(publisher: ReturnType<typeof h.createPublisher>) {
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      const claimed = await publisher.claimNext('wallet-1');
      if (!claimed) throw new Error('expected a claim');
      await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      return publisher.openClaimSession(claimed as ActiveLiftJobClaim);
    }

    it('keeps the legacy failure when the caller says a transaction may have been dispatched', async () => {
      // The record reads 'validated' and the cause is typed — everything but the caller's proof
      // says "pre-send". The proof is positional (the write-ahead's own outcome); a record that
      // merely LOOKS pre-send is not evidence that nothing left the node.
      const publisher = h.createPublisher(RETRY_LANE);
      const session = await validatedSession(publisher);

      const failed = expectFailed(await session.recordExecutionFailure(
        'broadcast',
        schedulerBusy(),
        { neverDispatched: false },
      ));

      expect(failed.failure.failedFromState).toBe('broadcast');
      expect(failed.failure.code).toBe('tx_submit_timeout');
      expect(failed.timestamps.nextRetryAt).toBeUndefined();
    });

    it('keeps the legacy failure when no proof is supplied at all', async () => {
      const publisher = h.createPublisher(RETRY_LANE);
      const session = await validatedSession(publisher);

      const failed = expectFailed(await session.recordExecutionFailure('broadcast', schedulerBusy()));

      expect(failed.failure.failedFromState).toBe('broadcast');
      expect(failed.failure.code).toBe('tx_submit_timeout');
    });

    it('re-routes on the same session call once the caller proves the attempt never dispatched', async () => {
      // The positive twin of the two rows above: only the caller's proof differs.
      const publisher = h.createPublisher(RETRY_LANE);
      const session = await validatedSession(publisher);

      const failed = expectFailed(await session.recordExecutionFailure(
        'broadcast',
        schedulerBusy(),
        { neverDispatched: true },
      ));

      expect(failed.failure.failedFromState).toBe('validated');
      expect(failed.failure.code).toBe('workspace_unavailable');
      expect(failed.failure.timeout).toBeUndefined();
    });

    it('reads the typed cause from the write-ahead failure when the thrown error is message-only', async () => {
      const publisher = h.createPublisher(RETRY_LANE);
      const session = await validatedSession(publisher);

      const failed = expectFailed(await session.recordExecutionFailure(
        'broadcast',
        adapterRewrap(schedulerBusy()),
        { neverDispatched: true, writeAheadFailure: schedulerBusy() },
      ));

      expect(failed.failure.failedFromState).toBe('validated');
      expect(failed.failure.code).toBe('workspace_unavailable');
      // The thrown (re-wrapped) message is what is persisted, so the stage is visible in it.
      expect(failed.failure.message).toContain('chain:writeahead hook failed before publish broadcast');
    });

    it('does not take an untyped write-ahead failure as a store rejection, even with the proof', async () => {
      const publisher = h.createPublisher(RETRY_LANE);
      const session = await validatedSession(publisher);

      const failed = expectFailed(await session.recordExecutionFailure(
        'broadcast',
        adapterRewrap(new Error('ENOSPC: no space left on device')),
        { neverDispatched: true, writeAheadFailure: new Error('ENOSPC: no space left on device') },
      ));

      expect(failed.failure.failedFromState).toBe('broadcast');
      expect(failed.failure.code).not.toBe('workspace_unavailable');
    });
  });

  describe('C. the recorder outcome maps to the caller proof', () => {
    // The persisted-status barrier masks a wrong mapping in every natural flow (a recorded
    // write-ahead leaves the record at 'broadcast'), so the mapping is pinned on its own.
    const recorder = (outcome: 'not-reached' | 'recorded-durable' | 'rolled-back-pre-send', writeAheadFailure?: unknown) => ({
      onBeforeBroadcast: async () => undefined,
      outcome,
      writeAheadFailure,
    });

    it('proves nothing dispatched only when no hash was durably recorded', () => {
      const failure = schedulerBusy();
      expect(executionFailureEvidence(recorder('not-reached'))).toEqual({
        neverDispatched: true,
        writeAheadFailure: undefined,
      });
      expect(executionFailureEvidence(recorder('rolled-back-pre-send', failure))).toEqual({
        neverDispatched: true,
        writeAheadFailure: failure,
      });
      expect(executionFailureEvidence(recorder('recorded-durable'))).toEqual({ neverDispatched: false });
    });

    it('never forwards a write-ahead failure alongside a dispatched outcome', () => {
      expect(executionFailureEvidence(recorder('recorded-durable', schedulerBusy())))
        .toEqual({ neverDispatched: false });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // D. Neighbouring classifications must not move: the fix is a proof, not a relabel.
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

    // The write-ahead leg has its own typed gate: a flush that fails for any other reason rolls
    // back exactly as before and keeps today's classification — only the storage layer's own
    // `not_started` statement earns the retry lane.
    const FLUSH_FAILURES: ReadonlyArray<readonly [string, () => Error]> = [
      ['an untyped flush failure', () => new Error('ENOSPC: no space left on device')],
      ['an INDETERMINATE store timeout during the write-ahead', () => new StoreOperationTimeoutError({
        backend: 'managed-oxigraph', operation: 'flush', outcome: 'indeterminate',
      })],
    ];

    it.each(FLUSH_FAILURES)(
      'keeps %s on the legacy broadcast-origin classification after a clean rollback',
      async (_label, make) => {
        let flushes = 0;
        (h.store as unknown as FlushableStore).flush = async () => {
          flushes += 1;
          if (flushes === 1) throw make();
        };
        const publisher = h.createPublisher({
          ...RETRY_LANE,
          knowledgeAssetVmPublishHandler: {
            execute: async (input) => {
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
        expect(failed.failure.failedFromState).toBe('broadcast');
        expect(failed.failure.code).not.toBe('workspace_unavailable');
        expect(failed.timestamps.nextRetryAt).toBeUndefined();
        // Rolled back: no phantom broadcast record, so no evidence and no hold.
        expect((await publisher.getStatus(jobId))?.broadcast).toBeUndefined();
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
});
