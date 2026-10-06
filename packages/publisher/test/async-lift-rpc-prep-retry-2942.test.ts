/**
 * GH#2942 — a transient RPC failure while the publish transaction is being PREPARED is not a
 * transaction-submission timeout.
 *
 * `RpcFailoverClient.populateAndSign` throws a typed `RpcEndpointsExhaustedError` (no txHash) when
 * every endpoint failed during estimate / populate / sign. That error is raised strictly before the
 * pre-send write-ahead hook, so it can never follow a send of the publication transaction — yet it
 * is not store-typed, so it fell to the broadcast-origin classifier: `tx_submit_timeout` when its
 * text says "timed out" (check-chain resolution, but with no transaction to check), `rpc_unavailable`
 * (not auto-retryable) otherwise. Either way the job parked at `waitingReason: 'operator'` forever.
 *
 * What these rows pin, every one through the public queue entry points and read back from the
 * persisted record:
 *
 *   A. a typed transient transport failure that PROVABLY preceded dispatch recovers through the
 *      existing bounded lane, as the SAME job, with no timeout metadata and no hash evidence;
 *   B. the identical error after the write-ahead recorded a hash keeps its chain-proof behaviour;
 *   C. each conjunct of the guard is load-bearing (a solo-removal row per conjunct);
 *   D. neighbouring classifications that must not move: prose, hash-bearing transport errors,
 *      receipt lookups, and a retry that re-runs the immutable job's preconditions.
 *
 * Fixtures: test/_helpers/rpc-prep-failure-2942.ts (typed errors) and
 * test/_helpers/store-rejection-2940.ts (handlers, retry-lane knobs).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActiveLiftJobClaim } from '../src/index.js';
import { hasBroadcastEvidence, isHeldForChainProof } from '../src/async-lift-retry-disposition.js';
import { TX_HASH, confirmedPublishResult, createAsyncLift2270Harness, expectFailed, scheduledDelay } from './_helpers/async-lift-2270-harness.js';
import { seedLegacyRawLiftTestJob } from './_helpers/legacy-raw-lift.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { RETRY_LANE, createStoreRejectionFixtures, rawLiftRequest } from './_helpers/store-rejection-2940.js';
import type { RawExecutor } from './_helpers/store-rejection-2940.js';
import {
  KEYED_RPC_URL,
  boundedRequestTimeout,
  broadcastExhausted,
  governorQueueFull,
  preparationExhausted,
  receiptLookupFailed,
  receiptWaitTimeout,
} from './_helpers/rpc-prep-failure-2942.js';

describe('GH#2942 transient RPC preparation failure vs transaction-submission timeout', () => {
  const h = createAsyncLift2270Harness();
  const { stage, failsOnceThenPublishes, firesBroadcastThenThrows } = createStoreRejectionFixtures(h);

  beforeEach(() => h.reset());

  /** The recoverable pre-send shape every pre-dispatch row asserts. */
  function expectRecordedAsPreSendRpcPreparation(failed: ReturnType<typeof expectFailed>): void {
    expect(failed.failure).toMatchObject({
      failedFromState: 'validated',
      code: 'workspace_unavailable',
      mode: 'retryable',
      retryable: true,
      resolution: 'reset_to_accepted',
    });
    // The fake `timeoutMs: 0` placeholder cannot exist for a class that is not a timeout at all.
    expect(failed.failure.timeout).toBeUndefined();
    expect(failed.broadcast).toBeUndefined();
    expect(hasBroadcastEvidence(failed)).toBe(false);
    expect(isHeldForChainProof(failed)).toBe(false);
  }

  // ---------------------------------------------------------------------------------------------
  // A. Provably pre-dispatch → the existing bounded retry lane, same job.
  // ---------------------------------------------------------------------------------------------
  describe('A. a typed transient transport failure that provably preceded dispatch', () => {
    const PREPARATION_FAILURES: ReadonlyArray<readonly [string, () => Error]> = [
      ['preparation exhausted every endpoint (text says "timed out")', preparationExhausted],
      ['the request governor was full', governorQueueFull],
      ['a bounded estimate request timed out', boundedRequestTimeout],
    ];

    it.each(PREPARATION_FAILURES)(
      'records "%s" thrown before the write-ahead as a retryable pre-send failure and retries the SAME job',
      async (_label, make) => {
        const attempts = { n: 0 };
        const publisher = h.createPublisher({
          ...RETRY_LANE,
          knowledgeAssetVmPublishHandler: failsOnceThenPublishes(make, attempts),
        });
        await stage();
        const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

        const failed = expectFailed(await publisher.processNext('wallet-1'));

        expectRecordedAsPreSendRpcPreparation(failed);
        expect(scheduledDelay(failed)).toBe(100);
        expect(publisher.describeConfiguredRetryState(failed)).toMatchObject({
          autoRetryEligible: true,
          waitingReason: 'backoff',
        });
        // Not due yet: the claim-time sweep leaves it failed and nothing re-runs.
        expect(await publisher.claimNext('wallet-2')).toBeNull();
        expect(attempts.n).toBe(1);

        h.advance(100);
        const finalized = await publisher.processNext('wallet-2');

        // The SAME immutable job, one budget unit spent, the second attempt published once.
        expect(finalized?.jobId).toBe(jobId);
        expect(finalized?.status).toBe('finalized');
        expect(finalized?.retries.retryCount).toBe(1);
        expect(finalized?.timestamps.nextRetryAt).toBeUndefined();
        expect(attempts.n).toBe(2);
        expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
        expect((await publisher.getStats()).finalized).toBe(1);
      },
    );

    it('keeps the provider text out of the persisted failure when it quotes a URL that carries an API key', async () => {
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: failsOnceThenPublishes(preparationExhausted, { n: 0 }),
      });
      await stage();
      await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      const failed = expectFailed(await publisher.processNext('wallet-1'));

      expect(preparationExhausted().message).toContain(KEYED_RPC_URL);
      expect(failed.failure.message).not.toContain('SECRET-API-KEY');
      expect(failed.failure.message).not.toContain(KEYED_RPC_URL);
      // The host survives: an operator still learns WHICH provider failed.
      expect(failed.failure.message).toContain('rpc.example');
    });

    it('records the same failure from the FINAL pre-execute preflight the same way', async () => {
      const attempts = { n: 0 };
      let preflights = 0;
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: {
          preflight: async () => {
            preflights += 1;
            if (preflights === 2) throw preparationExhausted();
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
      expectRecordedAsPreSendRpcPreparation(failed);
      h.advance(100);
      const finalized = await publisher.processNext('wallet-2');
      expect(finalized?.jobId).toBe(jobId);
      expect(finalized?.status).toBe('finalized');
    });

    it('applies the same proof to an UPDATE-kind job and the legacy raw-lift executor path', async () => {
      const publisher = h.createPublisher(RETRY_LANE);
      const updateId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
        vmCurrentAssertion: 'aa'.repeat(32),
        assertionVersion: '2',
        name: 'update-album',
        shareOperationId: 'update-op',
        intentKey: `sha256:${'d1'.repeat(32)}`,
      }));
      const claimed = await publisher.claimNext('wallet-1');
      await publisher.update(updateId, 'validated', { validation: KA_VM_VALIDATION });
      const session = publisher.openClaimSession(claimed as ActiveLiftJobClaim);

      const failedUpdate = expectFailed(await session.recordExecutionFailure(
        'broadcast',
        preparationExhausted(),
        { neverDispatched: true },
      ));

      expectRecordedAsPreSendRpcPreparation(failedUpdate);
      h.advance(100);
      expect((await publisher.claimNext('wallet-2'))?.jobId).toBe(updateId);

      // Raw lift: a second publisher, so the two paths do not share a queue.
      h.reset();
      const attempts = { n: 0 };
      const executor: RawExecutor = async () => {
        attempts.n += 1;
        if (attempts.n === 1) throw preparationExhausted();
        return confirmedPublishResult();
      };
      const rawPublisher = h.createPublisher({ ...RETRY_LANE, publishExecutor: executor });
      await stage();
      const rawId = await seedLegacyRawLiftTestJob(h.store, rawLiftRequest(), {
        now: () => 1_000,
        idGenerator: () => 'raw-job-1',
      });

      const failedRaw = expectFailed(await rawPublisher.processNext('wallet-1'));

      expectRecordedAsPreSendRpcPreparation(failedRaw);
      h.advance(100);
      const finalized = await rawPublisher.processNext('wallet-2');
      expect(finalized?.jobId).toBe(rawId);
      expect(finalized?.status).toBe('finalized');
      expect(finalized?.retries.retryCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // B. The identical error after the write-ahead recorded a hash keeps its chain-proof behaviour.
  // ---------------------------------------------------------------------------------------------
  describe('B. the same error after the write-ahead recorded a transaction', () => {
    const POST_WRITE_AHEAD: ReadonlyArray<readonly [string, () => Error]> = [
      ['preparation-shaped exhaustion with timeout text', preparationExhausted],
      ['a bounded request timeout', boundedRequestTimeout],
      ['a governor-full rejection', governorQueueFull],
    ];

    it.each(POST_WRITE_AHEAD)(
      'leaves a KA VM job in broadcast with its evidence for "%s": never failed, reset, or resent',
      async (_label, make) => {
        const attempts = { n: 0 };
        const publisher = h.createPublisher({
          ...RETRY_LANE,
          knowledgeAssetVmPublishHandler: firesBroadcastThenThrows(make(), attempts),
        });
        await stage();
        const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

        const processed = await publisher.processNext('wallet-1');

        expect(processed?.status).toBe('broadcast');
        expect(processed && 'broadcast' in processed ? processed.broadcast?.txHash : undefined).toBe(TX_HASH);
        h.advance(10_000);
        expect(await publisher.claimNext('wallet-2')).toBeNull();
        expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
        expect(attempts.n).toBe(1);
      },
    );

    it('holds a raw-lift failure for chain proof: never auto-retried, never reset by retry()', async () => {
      const attempts = { n: 0 };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        publishExecutor: async (input) => {
          attempts.n += 1;
          await input.publishOptions.onBeforeBroadcast?.({ txHash: TX_HASH, nonce: 7 });
          throw preparationExhausted();
        },
      });
      await stage();
      const jobId = await seedLegacyRawLiftTestJob(h.store, rawLiftRequest(), {
        now: () => 1_000,
        idGenerator: () => 'raw-job-1',
      });

      const failed = expectFailed(await publisher.processNext('wallet-1'));

      expect(failed.failure.failedFromState).toBe('broadcast');
      expect(failed.failure.code).not.toBe('workspace_unavailable');
      expect(failed.broadcast?.txHash).toBe(TX_HASH);
      expect(isHeldForChainProof(failed)).toBe(true);
      expect(failed.timestamps.nextRetryAt).toBeUndefined();
      h.advance(10_000);
      expect(await publisher.claimNext('wallet-2')).toBeNull();
      expect(await publisher.retryDetailed()).toMatchObject({ retried: 0, blockedPendingRecovery: 1 });
      expect((await publisher.getStatus(jobId))?.status).toBe('failed');
      expect(attempts.n).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // C. Each barrier is independent. These drive the claim session directly so one conjunct at a
  // time can be taken away.
  // ---------------------------------------------------------------------------------------------
  describe('C. each conjunct of the guard is load-bearing', () => {
    async function validatedSession(publisher: ReturnType<typeof h.createPublisher>) {
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      const claimed = await publisher.claimNext('wallet-1');
      if (!claimed) throw new Error('expected a claim');
      await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      return { session: publisher.openClaimSession(claimed as ActiveLiftJobClaim), jobId };
    }

    it('re-routes once the caller proves the attempt never dispatched — the positive twin of the rows below', async () => {
      const { session } = await validatedSession(h.createPublisher(RETRY_LANE));

      const failed = expectFailed(await session.recordExecutionFailure(
        'broadcast',
        preparationExhausted(),
        { neverDispatched: true },
      ));

      expectRecordedAsPreSendRpcPreparation(failed);
    });

    it('keeps the legacy failure when the caller says a transaction may have been dispatched', async () => {
      const { session } = await validatedSession(h.createPublisher(RETRY_LANE));

      const failed = expectFailed(await session.recordExecutionFailure(
        'broadcast',
        preparationExhausted(),
        { neverDispatched: false },
      ));

      expect(failed.failure.failedFromState).toBe('broadcast');
      expect(failed.failure.code).toBe('tx_submit_timeout');
      expect(failed.timestamps.nextRetryAt).toBeUndefined();
    });

    it('keeps the legacy failure when no proof is supplied at all', async () => {
      const { session } = await validatedSession(h.createPublisher(RETRY_LANE));

      const failed = expectFailed(await session.recordExecutionFailure('broadcast', preparationExhausted()));

      expect(failed.failure.failedFromState).toBe('broadcast');
      expect(failed.failure.code).toBe('tx_submit_timeout');
    });

    it('keeps the held failure when the persisted record already carries a broadcast, even with the proof and a typed cause', async () => {
      // The persisted status is read under the transition lock. A record that already left
      // 'validated' for 'broadcast' + hash (what a failed write-ahead rollback leaves behind) must
      // never be recorded "from validated" — that would discard the hash evidence.
      const publisher = h.createPublisher(RETRY_LANE);
      const { session, jobId } = await validatedSession(publisher);
      await publisher.update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId: 'wallet-1' } });

      const failed = expectFailed(await session.recordExecutionFailure(
        'broadcast',
        preparationExhausted(),
        { neverDispatched: true },
      ));

      expect(failed.failure.failedFromState).toBe('broadcast');
      expect(failed.failure.code).not.toBe('workspace_unavailable');
      expect(failed.broadcast?.txHash).toBe(TX_HASH);
      expect(isHeldForChainProof(failed)).toBe(true);
      expect(failed.timestamps.nextRetryAt).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------------------------
  // D. Neighbouring classifications that must stay exactly as they were.
  // ---------------------------------------------------------------------------------------------
  describe('D. classifications that must stay exactly as they were', () => {
    const LEGACY_CONTROLS: ReadonlyArray<readonly [string, () => unknown, string]> = [
      ['prose that merely says "timed out" (no typed contract)', () => new Error('RPC submit timed out after 30s'), 'tx_submit_timeout'],
      ['the same exhaustion text re-wrapped without its code', () => new Error(preparationExhausted().message), 'tx_submit_timeout'],
      ['a broadcast exhaustion, which names the transaction it carried', () => broadcastExhausted(TX_HASH), 'tx_submit_timeout'],
      ['the receipt-wait timeout of a sent transaction', () => receiptWaitTimeout(TX_HASH), 'tx_submit_timeout'],
      ['a receipt-lookup failure', receiptLookupFailed, 'rpc_unavailable'],
    ];

    it.each(LEGACY_CONTROLS)(
      'keeps %s on the legacy broadcast-origin classification, never the pre-send retry lane',
      async (_label, make, expectedCode) => {
        const attempts = { n: 0 };
        const publisher = h.createPublisher({
          ...RETRY_LANE,
          knowledgeAssetVmPublishHandler: failsOnceThenPublishes(make, attempts),
        });
        await stage();
        await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

        const failed = expectFailed(await publisher.processNext('wallet-1'));

        expect(failed.failure.failedFromState).toBe('broadcast');
        expect(failed.failure.code).toBe(expectedCode);
        expect(failed.timestamps.nextRetryAt).toBeUndefined();
        expect(publisher.describeConfiguredRetryState(failed).autoRetryEligible).toBe(false);
        h.advance(10_000);
        expect(await publisher.claimNext('wallet-2')).toBeNull();
        expect(attempts.n).toBe(1);
      },
    );

    it('re-runs the preconditions of the immutable job on every retry: a stale intent fails terminally and never publishes', async () => {
      let preflights = 0;
      let executes = 0;
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: {
          preflight: async () => {
            preflights += 1;
            // Attempt 1 passes both preflights, then execute fails while preparing the tx.
            // Attempt 2's FIRST preflight finds the intent is no longer current.
            if (preflights >= 3) {
              throw Object.assign(new Error('the queued publish intent is stale'), { code: 'PUBLISH_INTENT_STALE' });
            }
            return { action: 'execute' as const };
          },
          execute: async () => {
            executes += 1;
            throw preparationExhausted();
          },
        },
      });
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      expectFailed(await publisher.processNext('wallet-1'));
      h.advance(100);

      const retried = expectFailed(await publisher.processNext('wallet-2'));

      expect(retried.jobId).toBe(jobId);
      expect(retried.failure.code).toBe('publish_intent_stale');
      expect(retried.failure.retryable).toBe(false);
      expect(executes).toBe(1);
      h.advance(60_000);
      expect(await publisher.claimNext('wallet-3')).toBeNull();
    });

    it('honours the operator kill-switch and the shared budget exactly as for any pre-send failure', async () => {
      const disabled = h.createPublisher({
        ...RETRY_LANE,
        autoRetryEnabled: false,
        knowledgeAssetVmPublishHandler: failsOnceThenPublishes(preparationExhausted, { n: 0 }),
      });
      await stage();
      await disabled.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      const failed = expectFailed(await disabled.processNext('wallet-1'));
      expectRecordedAsPreSendRpcPreparation(failed);
      expect(failed.timestamps.nextRetryAt).toBeUndefined();
      expect(disabled.describeConfiguredRetryState(failed)).toMatchObject({
        autoRetryEligible: false,
        waitingReason: 'operator',
      });

      h.reset();
      const attempts = { n: 0 };
      const bounded = h.createPublisher({
        ...RETRY_LANE,
        maxRetries: 1,
        knowledgeAssetVmPublishHandler: {
          execute: async () => {
            attempts.n += 1;
            throw preparationExhausted();
          },
        },
      });
      await stage();
      await bounded.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      expectFailed(await bounded.processNext('wallet-1'));
      h.advance(100);
      const exhausted = expectFailed(await bounded.processNext('wallet-2'));

      expect(exhausted.retries.retryCount).toBe(1);
      expect(exhausted.timestamps.nextRetryAt).toBeUndefined();
      expect(bounded.describeConfiguredRetryState(exhausted)).toMatchObject({
        autoRetryEligible: false,
        waitingReason: 'exhausted',
      });
      h.advance(60_000);
      expect(await bounded.claimNext('wallet-3')).toBeNull();
      expect(attempts.n).toBe(2);
    });
  });
});
