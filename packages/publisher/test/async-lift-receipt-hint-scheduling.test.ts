/**
 * GH#2359 receipt-hint lane, scheduling/fairness rows: pass ceiling, lane alternation,\n * rotation, deadline truncation, starvation in both directions.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { walletLockSubject } from '../src/async-lift-control-plane.js';
import { recoveredResolution } from '../../../scripts/testing/ka-vm-publish.js';
import { createReceiptHintHarness } from './_helpers/receipt-hint-scenario.js';

describe('receipt-hint lane: scheduling and fairness', () => {
  let h: ReturnType<typeof createReceiptHintHarness>;

  beforeEach(() => {
    h = createReceiptHintHarness();
  });

  it('a non-cooperating recovery resolver cannot hang the pass past its budget', async () => {
    // r1 (3877430460) - the early lane races its canonical-evidence read against the pass
    // deadline exactly as the settle-time finalize does: a resolver that never settles and
    // ignores the abort signal costs the budget, not the process. No release, no transition,
    // pending work reported so the cadence retries.
    const { publisher, jobId, releaseTail } = await h.parkedHintScenario({
      config: {
        chainProofDispatchTimeBudgetMs: 50,
        // Never settles and ignores the signal - the hostile case the deadline exists for.
        knowledgeAssetVmPublishRecoveryResolver: () => new Promise(() => {}),
      },
    });

    try {
      // The pass must return NEAR its configured budget (50ms here; the 1s ceiling is a 20x
      // margin for CI wall-clock noise, still far below any accidental multi-second deadline -
      // r9 3877850648), report the hinted job as pending, and mutate nothing.
      const startedAt = Date.now();
      expect(await publisher.reconciliationScheduling.reconcile())
        .toEqual({ reconciled: 0, pendingWork: true });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
      await h.expectWalletLock('wallet-1', 'held');
    } finally {
      releaseTail();
    }
  });

  it('rotates past a budget-consuming hinted proof so a second hinted wallet is released', async () => {
    // r4 (3877669618 + 3877669330) - two detached hinted jobs; wallet-1's proof never settles
    // and ignores the signal, consuming the leading lane's sub-budget. Pass 1 must still
    // report the skipped hinted candidate as pending; a later hint-leading pass rotates to
    // wallet-2, proves it, stamps included, and releases ONLY its wallet.
    const { publisher, jobA, jobB, releaseTails } = await h.parkedTwoWalletScenario({
      config: {
        chainProofDispatchTimeBudgetMs: 100,
        chainProofResolver: (lookup: { walletId: string }) => (lookup.walletId === 'wallet-1'
          ? new Promise(() => {})
          : Promise.resolve(recoveredResolution())),
      },
    });
    try {
      // Pass 1 (hints lead): wallet-1 eats the sub-budget; skipped wallet-2 stays pending.
      expect(await publisher.reconciliationScheduling.reconcile())
        .toEqual({ reconciled: 0, pendingWork: true });
      // Pass 2 (walk leads - both jobs executor-owned, so it is empty and fast); the hint
      // lane then rotates to wallet-2 and releases it.
      expect(await publisher.reconciliationScheduling.reconcile())
        .toEqual({ reconciled: 0, pendingWork: true });
      expect((await publisher.getStatus(jobB))?.status).toBe('included');
      await h.expectWalletLock('wallet-2', 'released');
      expect((await publisher.getStatus(jobA))?.status).toBe('broadcast');
      await h.expectWalletLock('wallet-1', 'held');
    } finally {
      releaseTails();
    }
  });

  it('keeps a deadline-skipped hinted candidate pending when the budget went to a successful release', async () => {
    // r4 (3877669330) - candidate A's proof and release SUCCEED, but the lock deletion overruns
    // the whole pass budget (the release path never re-checks the signal mid-transition). A
    // contributes nothing to the unresolved count, candidate B is cut off by the absolute pass
    // deadline - only the truncation accounting keeps B pending, so the coalesced wake is not
    // consumed with B's wallet still locked.
    const { publisher, jobA, jobB, releaseTails } = await h.parkedTwoWalletScenario({
      config: { chainProofDispatchTimeBudgetMs: 150 },
    });
    const originalDelete = h.store.deleteByPattern.bind(h.store);
    let slowNextLockDelete = true;
    (h.store as unknown as { deleteByPattern: typeof originalDelete }).deleteByPattern =
      async (pattern: { subject?: string; graph?: string }) => {
        if (slowNextLockDelete && pattern?.subject === walletLockSubject('wallet-1')) {
          slowNextLockDelete = false;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return originalDelete(pattern as never);
      };
    try {
      expect(await publisher.reconciliationScheduling.reconcile())
        .toEqual({ reconciled: 0, pendingWork: true });
      expect((await publisher.getStatus(jobA))?.status).toBe('included');
      await h.expectWalletLock('wallet-1', 'released');
      expect((await publisher.getStatus(jobB))?.status).toBe('broadcast');
      await h.expectWalletLock('wallet-2', 'held');

      // Pass 2 (walk leads, empty) reaches B through the hint lane and releases it.
      await publisher.reconcileTransactions();
      expect((await publisher.getStatus(jobB))?.status).toBe('included');
      await h.expectWalletLock('wallet-2', 'released');
    } finally {
      releaseTails();
    }
  });

  it('a hanging hinted proof cannot starve an ordinary broadcast job out of the pass', async () => {
    // r5 (3877726336) - hinted job A's proof never settles and ignores the signal; ordinary
    // broadcast job B (executor settled, small real macrotask proof) must still be proven and
    // finalized in the SAME pass: the leading hint lane is bounded by its half-budget
    // sub-deadline, and the trailing walk keeps the remainder.
    const { publisher, jobA, jobB, releaseTails } = await h.parkedTwoWalletScenario({
      hinted: 'first',
      config: {
        chainProofDispatchTimeBudgetMs: 300,
        chainProofResolver: async (lookup: { walletId: string }) => {
          if (lookup.walletId === 'wallet-1') return new Promise(() => {}) as never;
          // A REAL (small) macrotask, as any RPC would pay: an in-memory instant resolver
          // would win even a zero-budget abort race on microtasks alone.
          await new Promise((resolve) => setTimeout(resolve, 5));
          return recoveredResolution();
        },
      },
    });
    try {
      const outcome = await publisher.reconciliationScheduling.reconcile();
      expect(outcome.reconciled).toBeGreaterThanOrEqual(1);
      expect(outcome.pendingWork).toBe(true);
      expect((await publisher.getStatus(jobB))?.status).toBe('finalized');
      await h.expectWalletLock('wallet-2', 'released');
      expect((await publisher.getStatus(jobA))?.status).toBe('broadcast');
      await h.expectWalletLock('wallet-1', 'held');
    } finally {
      releaseTails();
    }
  });

  it('a hint-transition overrun ends the pass instead of launching post-deadline proof reads', async () => {
    // r15 (3878098525) - the configured budget is an ABSOLUTE ceiling on launching recovery
    // reads. Wallet-1's lock deletion succeeds but overruns the whole 150ms pass: the
    // already-started transition completes (never aborted mid-write), ordinary job B is NOT
    // probed in that pass (zero proof asks - no fresh window after the deadline, the r13 shape
    // this replaces), and B is reported pending. The next pass, with the walk leading, probes
    // and finalizes B.
    let ordinaryAsks = 0;
    const { publisher, jobA, jobB, releaseTails } = await h.parkedTwoWalletScenario({
      hinted: 'first',
      config: {
        chainProofDispatchTimeBudgetMs: 150,
        chainProofResolver: async (lookup: { walletId: string }) => {
          if (lookup.walletId === 'wallet-2') {
            ordinaryAsks += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return recoveredResolution();
        },
      },
    });
    const originalDelete = h.store.deleteByPattern.bind(h.store);
    let slowNextLockDelete = true;
    (h.store as unknown as { deleteByPattern: typeof originalDelete }).deleteByPattern =
      async (pattern: { subject?: string; graph?: string }) => {
        if (slowNextLockDelete && pattern?.subject === walletLockSubject('wallet-1')) {
          slowNextLockDelete = false;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return originalDelete(pattern as never);
      };
    try {
      const outcome = await publisher.reconciliationScheduling.reconcile();
      // A's release completed (slowly); B was never probed after the deadline and is pending.
      expect((await publisher.getStatus(jobA))?.status).toBe('included');
      await h.expectWalletLock('wallet-1', 'released');
      expect(ordinaryAsks).toBe(0);
      expect(outcome.pendingWork).toBe(true);
      expect((await publisher.getStatus(jobB))?.status).toBe('broadcast');

      // Pass 2: the walk leads and B is proven and finalized within the normal budget.
      const outcome2 = await publisher.reconciliationScheduling.reconcile();
      expect(outcome2.reconciled).toBeGreaterThanOrEqual(1);
      expect(ordinaryAsks).toBe(1);
      expect((await publisher.getStatus(jobB))?.status).toBe('finalized');
      await h.expectWalletLock('wallet-2', 'released');
    } finally {
      releaseTails();
    }
  });

  it('a walk-led overrun costs the hinted lane at most one pass', async () => {
    // r17 (3878148764) - the reverse half of lane fairness. The walk leads (lead pinned
    // directly: priming with a spare pass would consume the parked hint first) and its
    // ordinary job overruns the absolute deadline during an awaited durable release; the
    // trailing hint lane is cut off and its candidate reported pending. The next, hint-led
    // pass releases the hinted wallet.
    const { publisher, jobA, jobB, releaseTails } = await h.parkedTwoWalletScenario({
      hinted: 'first',
      config: { chainProofDispatchTimeBudgetMs: 150 },
    });
    (publisher as unknown as { hintLaneLeads: boolean }).hintLaneLeads = false;
    // Ordinary job B's release (wallet-2) overruns the whole pass budget.
    const originalDelete = h.store.deleteByPattern.bind(h.store);
    let slowNextLockDelete = true;
    (h.store as unknown as { deleteByPattern: typeof originalDelete }).deleteByPattern =
      async (pattern: { subject?: string; graph?: string }) => {
        if (slowNextLockDelete && pattern?.subject === walletLockSubject('wallet-2')) {
          slowNextLockDelete = false;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return originalDelete(pattern as never);
      };
    try {
      // Pass 1 (walk leads): B's already-started release completes past the deadline (the
      // wallet frees), but the mutating repair may not START past it (the r26 rule), so B
      // stays tx-bearing; the trailing hint lane is cut off and A stays pending, wallet held.
      const outcome = await publisher.reconciliationScheduling.reconcile();
      expect(outcome.pendingWork).toBe(true);
      expect((await publisher.getStatus(jobB))?.status).toBe('broadcast');
      await h.expectWalletLock('wallet-2', 'released');
      expect((await publisher.getStatus(jobA))?.status).toBe('broadcast');
      await h.expectWalletLock('wallet-1', 'held');

      // Pass 2 (hints lead): the hinted wallet is reached and released; the trailing walk
      // finishes B within the normal budget.
      await publisher.reconcileTransactions();
      expect((await publisher.getStatus(jobA))?.status).toBe('included');
      await h.expectWalletLock('wallet-1', 'released');
      expect((await publisher.getStatus(jobB))?.status).toBe('finalized');
    } finally {
      releaseTails();
    }
  });

  it('a lone walk lane gets the full pass budget, not the competing-lanes split', async () => {
    // r20 (3878410728) - with no receipt hints there is nothing to reserve budget for: an
    // ordinary proof that needs more than half the pass must still complete in one pass, even
    // on a walk-leading turn.
    const { publisher, jobId, releaseTail } = await h.parkedHintScenario({
      hintTxHash: undefined,
      tailAction: 'throw',
      config: {
        chainProofDispatchTimeBudgetMs: 100,
        chainProofResolver: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return recoveredResolution();
        },
      },
    });
    // The throw-mode executor settles immediately, so the job is an ordinary live broadcast;
    // its hint is consumed/dropped by settle-path territory rules. Force a walk-leading turn.
    (publisher as unknown as { hintLaneLeads: boolean }).hintLaneLeads = false;
    (publisher as unknown as { executorProofHints: Map<string, unknown> }).executorProofHints.clear();
    await publisher.drainDetachedExecutions();

    const outcome = await publisher.reconciliationScheduling.reconcile();
    expect(outcome.reconciled).toBeGreaterThanOrEqual(1);
    expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
    releaseTail();
  });
});
