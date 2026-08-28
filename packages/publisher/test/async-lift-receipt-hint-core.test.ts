/**
 * GH#2359 receipt-hint lane, core/evidence rows (split from the monolithic suite, r21\n * 3878490032): hint validation, proof gating, single payment, terminal verdicts, evidence\n * binding, stale-cache and update rails.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AsyncLiftRunner } from '../src/index.js';
import {
  KA_VM_EXECUTOR_TX_HASH,
  kaVmPublishRequest,
  kaVmRecoveryEvidence,
  recoveredResolution,
} from './_helpers/ka-vm-publish.js';
import { createReceiptHintHarness } from './_helpers/receipt-hint-scenario.js';

describe('receipt-hint lane: core and evidence', () => {
  let h: ReturnType<typeof createReceiptHintHarness>;

  beforeEach(() => {
    h = createReceiptHintHarness();
  });

  it('frees the wallet through the receipt hint while the executor tail is still running', async () => {
    // GH#2359 item 2 - the headline discriminator. The executor confirms its receipt (fires
    // onPublishConfirmed) and then PARKS in its local post-receipt tail. Without the hint lane,
    // job2 waits for that tail to settle before job1's wallet can be proven and released; with
    // it, the demanded pass proves the transaction with the reconciler's own reads, stamps
    // 'included', and frees the wallet while the tail is still running - so job2's claim is the
    // observable. The poll is parked: only the hint-driven release can move job2.
    let releaseTail!: () => void;
    const tailParked = new Promise<void>((resolve) => { releaseTail = resolve; });
    let executions = 0;
    const publisher = h.createPublisher({
      detachReceiptReconciliation: true,
      chainProofResolver: async () => (
        recoveredResolution()),
      knowledgeAssetVmPublishRecoveryResolver: async () => kaVmRecoveryEvidence(),
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          executions += 1;
          await input.publishOptions.onBeforeBroadcast?.({
            txHash: KA_VM_EXECUTOR_TX_HASH,
            operationKind: 'create',
          });
          input.publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          await new Promise((resolve) => setTimeout(resolve, 20));
          input.publishOptions.onPublishConfirmed?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          await tailParked;
          throw new Error('tail released late: queue truth is settled by proof, not this result');
        },
        finalizeRecovered: async () => {},
      },
    });
    await h.stageShareSnapshot();
    const job1 = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const job2 = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'albums-next' }));

    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      pollIntervalMs: 600_000,
      recoveryIntervalMs: 600_000,
      activeRecoveryIntervalMs: 10,
      errorBackoffMs: 10,
    });
    await runner.start();
    try {
      await h.waitForStatus(
        publisher,
        job2,
        (status) => status !== undefined && status !== 'accepted',
        (status) => `job2 was never claimed through the hint-driven release (job2: ${status})`,
      );
      // job1's queue truth at this instant: inclusion observed and stamped, wallet gone, but
      // NOT finalized - the mutating repair must wait for the executor to settle (r26).
      expect((await publisher.getStatus(job1))?.status).toBe('included');
      // job2 went all the way to its own executor through the freed wallet.
      expect(executions).toBeGreaterThanOrEqual(2);

      releaseTail();
      await h.waitForStatus(
        publisher,
        job1,
        (status) => status === 'finalized',
        (status) => `job1 never finalized after the executor tail settled (status: ${status})`,
      );
    } finally {
      releaseTail();
      await runner.stop();
    }
  });

  it('ignores a receipt hint whose hash does not match the persisted write-ahead evidence', async () => {
    // The hint is scheduling-only: an executor that reports a hash the durable write-ahead
    // never recorded (a lie, or a stale attempt surviving a reset) must not move the record or
    // the wallet. Everything then flows through the normal settle path.
    const { publisher, jobId, releaseTail } = await h.parkedHintScenario({
      hintTxHash: `0x${'99'.repeat(32)}`,
    });

    // Two passes: the mismatched hint must not act on the first, and must be GONE (not merely
    // unlucky) on the second.
    await publisher.reconcileTransactions();
    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
    await h.expectWalletLock('wallet-1', 'held');

    // The normal settle path is untouched: tail settles, the demanded pass proves and finalizes.
    releaseTail();
    await publisher.drainDetachedExecutions();
    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
  });

  it('does not release on a hint until the reconciler own proof says recovered', async () => {
    // The hint authorizes nothing: while the chain answer is 'pending' (receipt not final at
    // the operator's confirmation depth) the wallet stays locked, and the pass advertises the
    // hinted job as pending work so the active cadence retries before settle.
    let verdict: 'pending' | 'recovered' = 'pending';
    const { publisher, jobId, releaseTail } = await h.parkedHintScenario({
      config: {
        chainProofResolver: async () => (verdict === 'pending'
          ? { status: 'pending' }
          : recoveredResolution()),
      },
    });

    expect(await publisher.reconciliationScheduling.reconcile())
      .toEqual({ reconciled: 0, pendingWork: true });
    expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
    await h.expectWalletLock('wallet-1', 'held');

    verdict = 'recovered';
    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('included');
    await h.expectWalletLock('wallet-1', 'released');

    releaseTail();
    await publisher.drainDetachedExecutions();
    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
  });

  it('pays each canonical chain read once: the settle-time finalize consumes the early proof', async () => {
    // The early release runs the reconciler's two reads; the settle-time finalize must consume
    // that cached proof instead of re-asking the chain - otherwise the hint lane would ADD
    // chain load to every publish instead of moving it earlier.
    let proofAsks = 0;
    let recoveryAsks = 0;
    const { publisher, jobId, releaseTail } = await h.parkedHintScenario({
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
    expect(proofAsks).toBe(1);
    expect(recoveryAsks).toBe(1);

    releaseTail();
    await publisher.drainDetachedExecutions();
    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
    expect(proofAsks).toBe(1);
    expect(recoveryAsks).toBe(1);
  });

  it('records no hint for a publish that cannot detach receipt reconciliation', async () => {
    // r1 (3877430478) - with no chain-proof resolver this publish can never detach, so a
    // recorded hint would be a dead entry that only occupies the bounded map (and could evict
    // a still-useful proof). The gate keeps ineligible publishes out entirely. The map is
    // private state, peeked deliberately: the invariant IS about internal hygiene.
    const { publisher } = await h.parkedHintScenario({
      tailAction: 'throw',
      config: {
        chainProofResolver: undefined,
        knowledgeAssetVmPublishRecoveryResolver: undefined,
      },
    });
    await publisher.drainDetachedExecutions();
    const hints = (publisher as unknown as { executorProofHints: Map<string, unknown> }).executorProofHints;
    expect(hints.size).toBe(0);
  });

  it('does not release on a hint when the handler has no lifecycle finalizer', async () => {
    // r9 (3877850638) - a handler may legally omit finalizeRecovered; the settle path then
    // answers 'unsupported' and expects the wallet lock intact. Early release would strand an
    // internally inconsistent held job, so hints are not even recorded for such a publisher:
    // the job follows plain detached behavior with its lock held.
    let hinted = false;
    let releaseTail!: () => void;
    const tailParked = new Promise<void>((resolve) => { releaseTail = resolve; });
    const publisher = h.createPublisher({
      detachReceiptReconciliation: true,
      chainProofResolver: async () => (
        recoveredResolution()),
      knowledgeAssetVmPublishRecoveryResolver: async () => kaVmRecoveryEvidence(),
      knowledgeAssetVmPublishHandler: {
        // Deliberately NO finalizeRecovered - valid under the public type.
        execute: async (input) => {
          await input.publishOptions.onBeforeBroadcast?.({
            txHash: KA_VM_EXECUTOR_TX_HASH,
            operationKind: 'create',
          });
          input.publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          await new Promise((resolve) => setTimeout(resolve, 10));
          input.publishOptions.onPublishConfirmed?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          hinted = true;
          await tailParked;
        },
      } as never,
    });
    await h.stageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.processNext('wallet-1');
    await h.waitForCondition(() => hinted, 'the executor never fired the hint');

    try {
      await publisher.reconcileTransactions();
      await publisher.reconcileTransactions();
      // No early release, no included stamp: the wallet lock stays with the tx-bearing job.
      expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
      await h.expectWalletLock('wallet-1', 'held');
    } finally {
      releaseTail();
    }
  });

  it('a reverted verdict in the hint lane releases nothing and hands the job to settle-time policy', async () => {
    // r14 (3878067032) - terminal verdicts are the settle path's to interpret. The early lane
    // must not stamp inclusion or free the wallet on 'reverted', must drop the hint (observable:
    // the second early pass performs no further proof ask - the job is executor-owned, so only
    // the hint lane could have asked), and settle-time reconciliation applies the established
    // policy: held failure, wallet released.
    let proofAsks = 0;
    const { publisher, jobId, releaseTail } = await h.parkedHintScenario({
      config: {
        chainProofResolver: async () => {
          proofAsks += 1;
          return { status: 'reverted' };
        },
      },
    });

    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
    await h.expectWalletLock('wallet-1', 'held');
    expect(proofAsks).toBe(1);
    await publisher.reconcileTransactions();
    expect(proofAsks).toBe(1);

    releaseTail();
    await publisher.drainDetachedExecutions();
    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('failed');
    await h.expectWalletLock('wallet-1', 'released');
  });

  it('a not-found verdict in the hint lane defers the create reset to settle-time policy', async () => {
    // r14 (3878067032) - same discipline for proven absence: no early stamp or release, hint
    // dropped after one ask, and settle applies the create-only reset (write-before-release)
    // that frees the wallet with the job back on the queue.
    let proofAsks = 0;
    const { publisher, jobId, releaseTail } = await h.parkedHintScenario({
      config: {
        chainProofResolver: async () => {
          proofAsks += 1;
          return { status: 'not-found' };
        },
      },
    });

    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
    await h.expectWalletLock('wallet-1', 'held');
    expect(proofAsks).toBe(1);
    await publisher.reconcileTransactions();
    expect(proofAsks).toBe(1);

    releaseTail();
    await publisher.drainDetachedExecutions();
    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('accepted');
    await h.expectWalletLock('wallet-1', 'released');
  });

  it('a stale cached proof for a superseded transaction is ignored at consumption time', async () => {
    // r8 (3877817702) - the consumption-time hash guard: cached evidence whose hint hash no
    // longer matches the persisted broadcast (a reset and re-run happened between caching and
    // settle) must not finalize the job; the canonical resolver is asked fresh. The stale
    // cache is injected directly - constructing it naturally needs a full reset cycle, and the
    // guard under test only sees the map state.
    let proofAsks = 0;
    let recoveryAsks = 0;
    const { publisher, jobId, releaseTail } = await h.parkedHintScenario({
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
    const hints = (publisher as unknown as {
      executorProofHints: Map<string, { txHash: string; proof?: unknown }>;
    }).executorProofHints;
    hints.set(jobId, {
      txHash: `0x${'99'.repeat(32)}`,
      proof: {
        recovery: { txHash: `0x${'99'.repeat(32)}` },
        resolved: {
          inclusion: { blockNumber: 999, txHash: `0x${'99'.repeat(32)}` },
          finalization: { merkleRoot: `0x${'99'.repeat(32)}` },
        },
      },
    });

    releaseTail();
    await publisher.drainDetachedExecutions();
    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
    // The stale cache was bypassed: both canonical reads happened fresh.
    expect(proofAsks).toBe(1);
    expect(recoveryAsks).toBe(1);
    expect(hints.has(jobId)).toBe(false);
  });

  it('unbound recovery evidence is never stamped or cached; the next pass reads fresh', async () => {
    // r18 (3878212037) - the resolver returns structurally valid evidence whose inclusion hash
    // does not match the queued transaction. Nothing durable may happen with it: no included
    // stamp, no release, no cache. The next pass re-reads, gets corrected evidence, and
    // proceeds normally.
    let recoveryAsks = 0;
    const { publisher, jobId, releaseTail } = await h.parkedHintScenario({
      config: {
        knowledgeAssetVmPublishRecoveryResolver: async () => {
          recoveryAsks += 1;
          if (recoveryAsks === 1) {
            const bad = kaVmRecoveryEvidence(`0x${'99'.repeat(32)}` as `0x${string}`);
            return bad;
          }
          return kaVmRecoveryEvidence();
        },
      },
    });

    // Pass 1: mismatched evidence - no stamp, no release, nothing cached.
    expect(await publisher.reconciliationScheduling.reconcile())
      .toEqual({ reconciled: 0, pendingWork: true });
    expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
    await h.expectWalletLock('wallet-1', 'held');

    // Pass 2: fresh read returns bound evidence - stamped and released.
    await publisher.reconcileTransactions();
    expect(recoveryAsks).toBe(2);
    expect((await publisher.getStatus(jobId))?.status).toBe('included');
    await h.expectWalletLock('wallet-1', 'released');

    releaseTail();
    await publisher.drainDetachedExecutions();
    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
  });

  it('releases and finalizes an UPDATE through the hint lane with the update lookup intact', async () => {
    // r11 (3877968154) - the lane must carry the update-only facts: the durable marker makes
    // queuedLiftOperationKind answer 'update', the proof lookup must be the update variant with
    // the intended root (the request's sealMerkleRoot), the wallet releases before the executor
    // tail settles, and the settle-time finalize consumes the cached update evidence with no
    // further chain reads.
    const lookups: Array<{ operationKind?: string; intendedUpdateRoot?: string }> = [];
    let proofAsks = 0;
    let recoveryAsks = 0;
    // r19 (3878327545) - the UPDATE verdict's canonical evidence must reach the recovery
    // resolver AS THE SAME OBJECT the proof verdict carried (production consumes it there to
    // avoid re-verifying the update). Reference identity is the discriminator: dropping or
    // substituting the third argument fails this row.
    const updateVerdictRecovery = kaVmRecoveryEvidence();
    const receivedVerdicts: unknown[] = [];
    const { publisher, jobId, releaseTail } = await h.parkedHintScenario({
      operationKind: 'update',
      config: {
        chainProofResolver: async (lookup: { operationKind?: string; intendedUpdateRoot?: string }) => {
          proofAsks += 1;
          lookups.push({ operationKind: lookup.operationKind, intendedUpdateRoot: lookup.intendedUpdateRoot });
          return { status: 'recovered', recovery: updateVerdictRecovery } as never;
        },
        knowledgeAssetVmPublishRecoveryResolver: async (
          _job: unknown,
          _lookup: unknown,
          verdictRecovery: unknown,
        ) => {
          recoveryAsks += 1;
          receivedVerdicts.push(verdictRecovery);
          return kaVmRecoveryEvidence();
        },
      },
    });

    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('included');
    await h.expectWalletLock('wallet-1', 'released');
    expect(lookups).toHaveLength(1);
    expect(lookups[0].operationKind).toBe('update');
    // The intended root rides the update lookup: the request's seal root, exactly.
    expect(lookups[0].intendedUpdateRoot?.toLowerCase()).toBe(`0x${'12'.repeat(32)}`);
    expect(receivedVerdicts).toHaveLength(1);
    expect(receivedVerdicts[0]).toBe(updateVerdictRecovery);

    releaseTail();
    await publisher.drainDetachedExecutions();
    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
    expect(proofAsks).toBe(1);
    expect(recoveryAsks).toBe(1);
  });
});
