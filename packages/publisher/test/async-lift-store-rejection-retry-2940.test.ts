/**
 * GH#2940 — the recovery of a provably pre-dispatch store rejection rides the EXISTING retry-lane
 * machinery unchanged: operator kill-switch, shared budget/backoff, restart, pause, wallet release
 * and the manual retry() race. Classification rows are in async-lift-store-rejection-2940; shared
 * fixtures in test/_helpers/store-rejection-2940.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createAsyncLift2270Harness, expectFailed, scheduledDelay } from './_helpers/async-lift-2270-harness.js';
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { RETRY_LANE, createStoreRejectionFixtures, schedulerBusy } from './_helpers/store-rejection-2940.js';

describe('GH#2940 store-scheduler rejection vs transaction-submission timeout: retry-lane controls', () => {
  const h = createAsyncLift2270Harness();
  const { stage, failsOnceThenPublishes, expectRecordedAsPreDispatchStoreRejection } = createStoreRejectionFixtures(h);

  beforeEach(() => h.reset());

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
        blocker: expect.objectContaining({ code: 'auto_retry_disabled' }),
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
        blocker: expect.objectContaining({ code: 'retry_budget_spent' }),
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

    it('is not retried while the publisher is paused, and resumes as the same job', async () => {
      const attempts = { n: 0 };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: failsOnceThenPublishes(() => schedulerBusy(), attempts),
      });
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      expectFailed(await publisher.processNext('wallet-1'));
      h.advance(100);

      await publisher.pause();
      expect(await publisher.claimNext('wallet-2')).toBeNull();
      expect((await publisher.getStatus(jobId))?.status).toBe('failed');
      expect(attempts.n).toBe(1);

      await publisher.resume();
      const finalized = await publisher.processNext('wallet-2');
      expect(finalized?.jobId).toBe(jobId);
      expect(finalized?.status).toBe('finalized');
      expect(attempts.n).toBe(2);
    });

    it('releases the signing wallet: the same wallet claims the next job right after the rejection', async () => {
      // A pre-dispatch failure leaves nothing for the wallet to be proof-bound to; a retained
      // lock would strand every other job on this wallet behind a job that is only waiting.
      const attempts = { n: 0 };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: failsOnceThenPublishes(() => schedulerBusy(), attempts),
      });
      await stage();
      const firstId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      const secondId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
        name: 'album-2',
        shareOperationId: 'share-op-2',
        intentKey: `sha256:${'2'.repeat(64)}`,
      }));
      expectFailed(await publisher.processNext('wallet-1'));

      const next = await publisher.claimNext('wallet-1');

      expect(next?.jobId).toBe(secondId);
      expect(next?.jobId).not.toBe(firstId);
      expect(next?.claim?.walletId).toBe('wallet-1');
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
