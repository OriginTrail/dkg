/**
 * GH#2359 receipt-hint lane, failure/retry rows: the retryable transition window, the\n * escalation budget, deferred repair, and the included-write failure.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  jobSubject,
  walletLockSubject,
} from '../src/async-lift-control-plane.js';
import {
  kaVmPublishRequest,
  kaVmRecoveryEvidence,
  recoveredResolution,
} from './_helpers/ka-vm-publish.js';
import { createReceiptHintHarness } from './_helpers/receipt-hint-scenario.js';

describe('receipt-hint lane: failure and retry', () => {
  let h: ReturnType<typeof createReceiptHintHarness>;

  beforeEach(() => {
    h = createReceiptHintHarness();
  });

  it('retries a wallet release that failed after the included stamp', async () => {
    // r2 (3877540018) - persistence can succeed and the lock deletion then fail transiently.
    // That intermediate state (included, lock still held, executor still parked) must cost one
    // candidate turn, not the pass, and must stay retryable: a later pass re-proves and
    // completes the release instead of stranding the wallet until the tail settles.
    const { publisher, jobId, releaseTail } = await h.parkedHintScenario();
    const job2 = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'albums-next' }));
    // Installed AFTER the claim (claiming rewrites the lock subject too): the next deletion of
    // this wallet's lock is the early lane's release, and only that one fails.
    const originalDelete = h.store.deleteByPattern.bind(h.store);
    let failNextLockDelete = true;
    (h.store as unknown as { deleteByPattern: typeof originalDelete }).deleteByPattern =
      async (pattern: { subject?: string; graph?: string }) => {
        if (failNextLockDelete && pattern?.subject === walletLockSubject('wallet-1')) {
          failNextLockDelete = false;
          throw new Error('transient store failure on lock deletion');
        }
        return originalDelete(pattern as never);
      };
    try {
      // Pass 1: proof + included stamp land, the lock deletion fails. The pass survives and
      // reports the job pending.
      expect(await publisher.reconciliationScheduling.reconcile())
        .toEqual({ reconciled: 0, pendingWork: true });
      expect((await publisher.getStatus(jobId))?.status).toBe('included');
      await h.expectWalletLock('wallet-1', 'held');

      // Pass 2: included-with-hint is retryable; the release completes.
      await publisher.reconcileTransactions();
      expect((await publisher.getStatus(jobId))?.status).toBe('included');
      await h.expectWalletLock('wallet-1', 'released');

      // The wallet is genuinely claimable again BEFORE the executor tail ever settles.
      expect((await publisher.claimNext('wallet-1'))?.jobId).toBe(job2);
    } finally {
      releaseTail();
    }
  });

  it('a persistently failing release escalates to the error path instead of looping silently', async () => {
    // r8 (3877817604) - transient containment has a budget. The lock deletion fails on EVERY
    // attempt: the first two passes are contained (pending work, hint retained), the third
    // escalates the error out of the pass to the runner's reporting and backoff. The hint
    // survives, so once the fault clears the release still completes.
    const { publisher, jobId, releaseTail } = await h.parkedHintScenario();
    const originalDelete = h.store.deleteByPattern.bind(h.store);
    let failLockDeletes = true;
    (h.store as unknown as { deleteByPattern: typeof originalDelete }).deleteByPattern =
      async (pattern: { subject?: string; graph?: string }) => {
        if (failLockDeletes && pattern?.subject === walletLockSubject('wallet-1')) {
          throw new Error('store rejects the lock deletion');
        }
        return originalDelete(pattern as never);
      };
    try {
      expect(await publisher.reconciliationScheduling.reconcile())
        .toEqual({ reconciled: 0, pendingWork: true });
      expect(await publisher.reconciliationScheduling.reconcile())
        .toEqual({ reconciled: 0, pendingWork: true });
      await expect(publisher.reconcileTransactions()).rejects.toThrow('store rejects the lock deletion');

      // The fault clears: the retained hint completes the release on the next pass.
      failLockDeletes = false;
      await publisher.reconcileTransactions();
      expect((await publisher.getStatus(jobId))?.status).toBe('included');
      await h.expectWalletLock('wallet-1', 'released');
    } finally {
      releaseTail();
    }
  });

  it('a deferred local repair retries with FRESH chain reads, never the possibly-rejected cache', async () => {
    // r5 (3877726515) + r18 (3878212037) - after the early release, the settle-time repair can
    // fail (repair-deferred: the wallet is already free, the job stays tx-bearing). A deferred
    // repair may mean the repair REJECTED the evidence, so the cache is dropped: the retry
    // re-reads canonically (counters go 1 -> 2) and a corrected chain answer can repair the
    // job instead of the cache replaying rejected evidence forever. (The success path's
    // single payment of reads is pinned by the accounting row above.)
    let proofAsks = 0;
    let recoveryAsks = 0;
    let repairAttempts = 0;
    const { publisher, jobId, releaseTail } = await h.parkedHintScenario({
      finalizeRecovered: async () => {
        repairAttempts += 1;
        if (repairAttempts === 1) throw new Error('transient local repair failure');
      },
      config: {
        chainProofResolver: async () => {
          proofAsks += 1;
          return recoveredResolution();
        },
        knowledgeAssetVmPublishRecoveryResolver: async () => {
          recoveryAsks += 1;
          return kaVmRecoveryEvidence();
        },
      },
    });

    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('included');
    await h.expectWalletLock('wallet-1', 'released');

    releaseTail();
    await publisher.drainDetachedExecutions();

    // Settle pass: the repair throws once - repair-deferred, job stays included and released,
    // and the possibly-rejected cache is dropped.
    await publisher.reconcileTransactions();
    expect(repairAttempts).toBe(1);
    expect((await publisher.getStatus(jobId))?.status).toBe('included');
    await h.expectWalletLock('wallet-1', 'released');

    // Retry pass: FRESH canonical reads (the cache did not outlive the rejection), repair
    // succeeds, finalized.
    await publisher.reconcileTransactions();
    expect(repairAttempts).toBe(2);
    expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
    expect(proofAsks).toBe(2);
    expect(recoveryAsks).toBe(2);
  });

  it('a failed included write releases nothing and the next pass completes write-before-release', async () => {
    // r20 (3878410966) - the other half of the transition window: the included WRITE itself
    // fails. Nothing may release (write-before-release is the invariant), the hint stays
    // retryable, and the next pass persists the stamp before freeing the wallet.
    const { publisher, jobId, releaseTail } = await h.parkedHintScenario();
    const originalReplace = h.store.replaceSubject.bind(h.store);
    let failNextJobWrite = true;
    (h.store as unknown as { replaceSubject: typeof originalReplace }).replaceSubject =
      async (graphUri: string, subject: string, quads: never) => {
        if (failNextJobWrite && subject === jobSubject(jobId)) {
          failNextJobWrite = false;
          throw new Error('transient store failure on the included write');
        }
        return originalReplace(graphUri, subject, quads);
      };
    try {
      expect(await publisher.reconciliationScheduling.reconcile())
        .toEqual({ reconciled: 0, pendingWork: true });
      expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
      await h.expectWalletLock('wallet-1', 'held');

      await publisher.reconcileTransactions();
      expect((await publisher.getStatus(jobId))?.status).toBe('included');
      await h.expectWalletLock('wallet-1', 'released');
    } finally {
      releaseTail();
    }
  });
  it('an unexpected resolver failure in the hint lane surfaces instead of silently retrying', async () => {
    // r6 (3877748379) - the containment is scoped to the transition-and-release window (the
    // r2-validated retryable case). A programming error in a resolver must NOT be swallowed
    // into pending work: it propagates out of the pass to the runner's error path, exactly as
    // canonical-walk failures do, so a tight silent retry loop cannot form.
    const { publisher, jobId, releaseTail } = await h.parkedHintScenario({
      config: {
        chainProofResolver: () => { throw new TypeError('resolver programming error'); },
      },
    });
    try {
      await expect(publisher.reconcileTransactions()).rejects.toThrow('resolver programming error');
      expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
      await h.expectWalletLock('wallet-1', 'held');
    } finally {
      releaseTail();
    }
  });
});
