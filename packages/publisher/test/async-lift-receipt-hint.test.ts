/**
 * GH#2359 receipt-hint lane (split from the wallet-release suite, r7 3877794566): the executor
 * confirms its receipt before its local post-receipt tail finishes, the publisher records a
 * scheduling-only {txHash} hint, and the reconcile pass proves the transaction with its OWN
 * canonical reads to stamp 'included' and free the wallet while the tail keeps running. These
 * rows pin that lane end to end: validation against persisted evidence, proof gating, single
 * payment of chain reads, retryability of the transition window, fairness in both directions,
 * deadline accounting, and observable failures.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  AsyncLiftRunner,
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
} from '../src/index.js';
import {
  CONTROL_LOCKED_JOB,
  DEFAULT_WALLET_LOCK_GRAPH_URI,
  walletLockSubject,
} from '../src/async-lift-control-plane.js';
import {
  KA_VM_EXECUTOR_TX_HASH,
  kaVmPublishRequest,
  stageKnowledgeAssetShareSnapshot,
} from './_helpers/ka-vm-publish.js';

describe('async-lift receipt-hint lane', () => {
  let now = 1_000;
  let ids = 0;
  let store: OxigraphStore;
  let graphManager: GraphManager;

  beforeEach(() => {
    now = 1_000;
    ids = 0;
    store = new OxigraphStore();
    graphManager = new GraphManager(store);
  });

  function createPublisher(
    config: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator'> = {},
  ): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++now,
      idGenerator: () => `job-${++ids}`,
      ...config,
    });
  }

  async function stageShareSnapshot(): Promise<void> {
    await stageKnowledgeAssetShareSnapshot({ store, graphManager });
  }

  /**
   * GH#2359 receipt-hint scenario builder (r1 3877454254): one detached KA-VM publish whose
   * executor confirms its receipt (firing the hint with a configurable hash) and then either
   * PARKS in its post-receipt tail (release with `releaseTail`) or fails immediately. Rows own
   * their distinguishing resolvers/config through `config`; everything else - staging, enqueue,
   * claim, the hint wait - is identical by construction.
   */
  async function parkedHintScenario(options: {
    hintTxHash?: string;
    tailAction?: 'park' | 'throw';
    operationKind?: 'create' | 'update';
    finalizeRecovered?: () => Promise<void>;
    config?: Partial<AsyncLiftPublisherConfig>;
  } = {}) {
    let releaseTail!: () => void;
    const tailParked = new Promise<void>((resolve) => { releaseTail = resolve; });
    let hinted = false;
    const publisher = createPublisher({
      detachReceiptReconciliation: true,
      chainProofResolver: async () => (
        { status: 'recovered', recovery: { txHash: KA_VM_EXECUTOR_TX_HASH } } as never),
      knowledgeAssetVmPublishRecoveryResolver: async () => ({
        inclusion: { blockNumber: 1, txHash: KA_VM_EXECUTOR_TX_HASH },
        finalization: { merkleRoot: `0x${'12'.repeat(32)}` },
      } as never),
      ...options.config,
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          await input.publishOptions.onBeforeBroadcast?.({
            txHash: KA_VM_EXECUTOR_TX_HASH,
            operationKind: options.operationKind ?? 'create',
          });
          input.publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          await new Promise((resolve) => setTimeout(resolve, 10));
          input.publishOptions.onPublishConfirmed?.({
            txHash: options.hintTxHash ?? KA_VM_EXECUTOR_TX_HASH,
          });
          hinted = true;
          if (options.tailAction === 'throw') {
            throw new Error('post-write-ahead failure: recovery owns the record from here');
          }
          await tailParked;
        },
        finalizeRecovered: options.finalizeRecovered ?? (async () => {}),
      },
    });
    await stageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.processNext('wallet-1');
    await waitForCondition(() => hinted, 'the executor never fired the hint');
    return { publisher, jobId, releaseTail };
  }

  async function waitForCondition(
    condition: () => boolean,
    message: string,
    timeoutMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(message);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function expectWalletLock(walletId: string, expected: 'held' | 'released'): Promise<void> {
    const lock = await store.query(`SELECT ?job WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject(walletId)}> <${CONTROL_LOCKED_JOB}> ?job .
      }
    }`);
    expect(lock.type).toBe('bindings');
    if (lock.type === 'bindings') {
      expect(lock.bindings).toHaveLength(expected === 'held' ? 1 : 0);
    }
  }

  async function waitForStatus(
    publisher: TripleStoreAsyncLiftPublisher,
    jobId: string,
    accept: (status: string | undefined) => boolean,
    message: (status: string | undefined) => string,
    timeoutMs = 15_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const status = (await publisher.getStatus(jobId))?.status;
      if (accept(status)) return;
      if (Date.now() > deadline) throw new Error(message(status));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

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
    const publisher = createPublisher({
      detachReceiptReconciliation: true,
      chainProofResolver: async () => (
        { status: 'recovered', recovery: { txHash: KA_VM_EXECUTOR_TX_HASH } } as never),
      knowledgeAssetVmPublishRecoveryResolver: async () => ({
        inclusion: { blockNumber: 1, txHash: KA_VM_EXECUTOR_TX_HASH },
        finalization: { merkleRoot: `0x${'12'.repeat(32)}` },
      } as never),
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
    await stageShareSnapshot();
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
      await waitForStatus(
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
      await waitForStatus(
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
    const { publisher, jobId, releaseTail } = await parkedHintScenario({
      hintTxHash: `0x${'99'.repeat(32)}`,
    });

    // Two passes: the mismatched hint must not act on the first, and must be GONE (not merely
    // unlucky) on the second.
    await publisher.reconcileTransactions();
    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
    await expectWalletLock('wallet-1', 'held');

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
    const { publisher, jobId, releaseTail } = await parkedHintScenario({
      config: {
        chainProofResolver: async () => (verdict === 'pending'
          ? { status: 'pending' }
          : { status: 'recovered', recovery: { txHash: KA_VM_EXECUTOR_TX_HASH } } as never),
      },
    });

    expect(await publisher.reconciliationScheduling.reconcile())
      .toEqual({ reconciled: 0, pendingWork: true });
    expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
    await expectWalletLock('wallet-1', 'held');

    verdict = 'recovered';
    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('included');
    await expectWalletLock('wallet-1', 'released');

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
    const { publisher, jobId, releaseTail } = await parkedHintScenario({
      config: {
        chainProofResolver: async () => {
          proofAsks += 1;
          return { status: 'recovered', recovery: { txHash: KA_VM_EXECUTOR_TX_HASH } } as never;
        },
        knowledgeAssetVmPublishRecoveryResolver: async () => {
          recoveryAsks += 1;
          return {
            inclusion: { blockNumber: 1, txHash: KA_VM_EXECUTOR_TX_HASH },
            finalization: { merkleRoot: `0x${'12'.repeat(32)}` },
          } as never;
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

  it('a non-cooperating recovery resolver cannot hang the pass past its budget', async () => {
    // r1 (3877430460) - the early lane races its canonical-evidence read against the pass
    // deadline exactly as the settle-time finalize does: a resolver that never settles and
    // ignores the abort signal costs the budget, not the process. No release, no transition,
    // pending work reported so the cadence retries.
    const { publisher, jobId, releaseTail } = await parkedHintScenario({
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
      await expectWalletLock('wallet-1', 'held');
    } finally {
      releaseTail();
    }
  });

  it('records no hint for a publish that cannot detach receipt reconciliation', async () => {
    // r1 (3877430478) - with no chain-proof resolver this publish can never detach, so a
    // recorded hint would be a dead entry that only occupies the bounded map (and could evict
    // a still-useful proof). The gate keeps ineligible publishes out entirely. The map is
    // private state, peeked deliberately: the invariant IS about internal hygiene.
    const { publisher } = await parkedHintScenario({
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

  it('retries a wallet release that failed after the included stamp', async () => {
    // r2 (3877540018) - persistence can succeed and the lock deletion then fail transiently.
    // That intermediate state (included, lock still held, executor still parked) must cost one
    // candidate turn, not the pass, and must stay retryable: a later pass re-proves and
    // completes the release instead of stranding the wallet until the tail settles.
    const { publisher, jobId, releaseTail } = await parkedHintScenario();
    const job2 = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'albums-next' }));
    // Installed AFTER the claim (claiming rewrites the lock subject too): the next deletion of
    // this wallet's lock is the early lane's release, and only that one fails.
    const originalDelete = store.deleteByPattern.bind(store);
    let failNextLockDelete = true;
    (store as unknown as { deleteByPattern: typeof originalDelete }).deleteByPattern =
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
      await expectWalletLock('wallet-1', 'held');

      // Pass 2: included-with-hint is retryable; the release completes.
      await publisher.reconcileTransactions();
      expect((await publisher.getStatus(jobId))?.status).toBe('included');
      await expectWalletLock('wallet-1', 'released');

      // The wallet is genuinely claimable again BEFORE the executor tail ever settles.
      expect((await publisher.claimNext('wallet-1'))?.jobId).toBe(job2);
    } finally {
      releaseTail();
    }
  });

  it('rotates past a budget-consuming hinted proof so a second hinted wallet is released', async () => {
    // r4 (3877669618 + 3877669330) - two wallets, two detached hinted jobs. Wallet-1's proof
    // lookup never settles and ignores the signal, so it consumes the whole (short) pass
    // budget. Pass 1 starts at wallet-1, times out, and must still report the SKIPPED hinted
    // candidate as pending work (the truncation fix) - otherwise the coalesced wake is consumed
    // and the runner idles with hinted wallets locked. Pass 2's rotation starts at wallet-2,
    // which proves, stamps included, and releases ONLY its wallet.
    let hinted = 0;
    const tails: Array<() => void> = [];
    const publisher = createPublisher({
      chainProofDispatchTimeBudgetMs: 100,
      detachReceiptReconciliation: true,
      chainProofResolver: (lookup: { walletId: string }) => (lookup.walletId === 'wallet-1'
        ? new Promise(() => {})
        : Promise.resolve({ status: 'recovered', recovery: { txHash: KA_VM_EXECUTOR_TX_HASH } } as never)),
      knowledgeAssetVmPublishRecoveryResolver: async () => ({
        inclusion: { blockNumber: 1, txHash: KA_VM_EXECUTOR_TX_HASH },
        finalization: { merkleRoot: `0x${'12'.repeat(32)}` },
      } as never),
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          await input.publishOptions.onBeforeBroadcast?.({
            txHash: KA_VM_EXECUTOR_TX_HASH,
            operationKind: 'create',
          });
          input.publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          await new Promise((resolve) => setTimeout(resolve, 10));
          input.publishOptions.onPublishConfirmed?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          hinted += 1;
          await new Promise<void>((resolve) => { tails.push(resolve); });
        },
        finalizeRecovered: async () => {},
      },
    });
    await stageShareSnapshot();
    await stageKnowledgeAssetShareSnapshot({ store, graphManager, shareOperationId: 'share-op-2' });
    const jobA = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const jobB = await publisher.enqueueKnowledgeAssetVmPublish(
      kaVmPublishRequest({ name: 'albums-next', shareOperationId: 'share-op-2' }),
    );
    await publisher.processNext('wallet-1');
    await publisher.processNext('wallet-2');
    await waitForCondition(() => hinted === 2, 'both executors must fire their hints');

    try {
      // Pass 1: wallet-1 consumes the budget; the skipped wallet-2 hint keeps the pass pending.
      expect(await publisher.reconciliationScheduling.reconcile())
        .toEqual({ reconciled: 0, pendingWork: true });

      // Pass 2: rotation starts at wallet-2 - proven, stamped, released; wallet-1 untouched.
      expect(await publisher.reconciliationScheduling.reconcile())
        .toEqual({ reconciled: 0, pendingWork: true });
      expect((await publisher.getStatus(jobB))?.status).toBe('included');
      await expectWalletLock('wallet-2', 'released');
      expect((await publisher.getStatus(jobA))?.status).toBe('broadcast');
      await expectWalletLock('wallet-1', 'held');
    } finally {
      for (const release of tails) release();
    }
  });

  it('keeps a deadline-skipped hinted candidate pending when the budget went to a successful release', async () => {
    // r4 (3877669330) - the sharp version of deadline truncation: candidate A's proof and
    // release SUCCEED, but its lock deletion is slow enough that the pass budget expires while
    // it completes (the release path deliberately never re-checks the signal mid-transition).
    // A therefore contributes nothing to the unresolved count, and candidate B is cut off by
    // the abort. Without the truncation accounting the pass would report pendingWork:false,
    // consuming the coalesced wake while B's wallet stays locked behind a parked executor.
    let hinted = 0;
    const tails: Array<() => void> = [];
    const publisher = createPublisher({
      chainProofDispatchTimeBudgetMs: 150,
      detachReceiptReconciliation: true,
      chainProofResolver: async () => (
        { status: 'recovered', recovery: { txHash: KA_VM_EXECUTOR_TX_HASH } } as never),
      knowledgeAssetVmPublishRecoveryResolver: async () => ({
        inclusion: { blockNumber: 1, txHash: KA_VM_EXECUTOR_TX_HASH },
        finalization: { merkleRoot: `0x${'12'.repeat(32)}` },
      } as never),
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          await input.publishOptions.onBeforeBroadcast?.({
            txHash: KA_VM_EXECUTOR_TX_HASH,
            operationKind: 'create',
          });
          input.publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          await new Promise((resolve) => setTimeout(resolve, 10));
          input.publishOptions.onPublishConfirmed?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          hinted += 1;
          await new Promise<void>((resolve) => { tails.push(resolve); });
        },
        finalizeRecovered: async () => {},
      },
    });
    await stageShareSnapshot();
    await stageKnowledgeAssetShareSnapshot({ store, graphManager, shareOperationId: 'share-op-2' });
    const jobA = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const jobB = await publisher.enqueueKnowledgeAssetVmPublish(
      kaVmPublishRequest({ name: 'albums-next', shareOperationId: 'share-op-2' }),
    );
    await publisher.processNext('wallet-1');
    await publisher.processNext('wallet-2');
    await waitForCondition(() => hinted === 2, 'both executors must fire their hints');

    // Installed AFTER the claims: wallet-1's lock deletion (the release) completes
    // successfully but takes longer than the pass budget.
    const originalDelete = store.deleteByPattern.bind(store);
    let slowNextLockDelete = true;
    (store as unknown as { deleteByPattern: typeof originalDelete }).deleteByPattern =
      async (pattern: { subject?: string; graph?: string }) => {
        if (slowNextLockDelete && pattern?.subject === walletLockSubject('wallet-1')) {
          slowNextLockDelete = false;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return originalDelete(pattern as never);
      };

    try {
      // A releases (slowly, past the deadline); B is cut off. The pass must stay pending for B.
      expect(await publisher.reconciliationScheduling.reconcile())
        .toEqual({ reconciled: 0, pendingWork: true });
      expect((await publisher.getStatus(jobA))?.status).toBe('included');
      await expectWalletLock('wallet-1', 'released');
      expect((await publisher.getStatus(jobB))?.status).toBe('broadcast');
      await expectWalletLock('wallet-2', 'held');

      // The next pass reaches B and releases it.
      await publisher.reconcileTransactions();
      expect((await publisher.getStatus(jobB))?.status).toBe('included');
      await expectWalletLock('wallet-2', 'released');
    } finally {
      for (const release of tails) release();
    }
  });

  it('a hanging hinted proof cannot starve an ordinary broadcast job out of the pass', async () => {
    // r5 (3877726336) - the hint lane runs first but under a half-budget sub-deadline: hinted
    // job A's proof never settles and ignores the signal, ordinary broadcast job B (no hint,
    // executor settled) has instant resolvers. One pass must still reconcile B - the walk
    // always keeps at least half the budget - while A stays pending.
    let hinted = false;
    const tails: Array<() => void> = [];
    let executions = 0;
    const publisher = createPublisher({
      chainProofDispatchTimeBudgetMs: 300,
      detachReceiptReconciliation: true,
      chainProofResolver: (lookup: { walletId: string }) => (lookup.walletId === 'wallet-1'
        ? new Promise(() => {})
        : Promise.resolve({ status: 'recovered', recovery: { txHash: KA_VM_EXECUTOR_TX_HASH } } as never)),
      knowledgeAssetVmPublishRecoveryResolver: async () => ({
        inclusion: { blockNumber: 1, txHash: KA_VM_EXECUTOR_TX_HASH },
        finalization: { merkleRoot: `0x${'12'.repeat(32)}` },
      } as never),
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          executions += 1;
          // Captured at entry: the shared counter moves while this execution sleeps.
          const myExecution = executions;
          await input.publishOptions.onBeforeBroadcast?.({
            txHash: KA_VM_EXECUTOR_TX_HASH,
            operationKind: 'create',
          });
          input.publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (myExecution === 1) {
            // Job A: hinted, executor tail parked - the hint lane's candidate.
            input.publishOptions.onPublishConfirmed?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
            hinted = true;
            await new Promise<void>((resolve) => { tails.push(resolve); });
          }
          // Job B: NO hint; the executor fails post-write-ahead, settling immediately, so B is
          // an ordinary live broadcast owned by the normal reconciliation walk.
          throw new Error('post-write-ahead failure: recovery owns the record from here');
        },
        finalizeRecovered: async () => {},
      },
    });
    await stageShareSnapshot();
    await stageKnowledgeAssetShareSnapshot({ store, graphManager, shareOperationId: 'share-op-2' });
    const jobA = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const jobB = await publisher.enqueueKnowledgeAssetVmPublish(
      kaVmPublishRequest({ name: 'albums-next', shareOperationId: 'share-op-2' }),
    );
    await publisher.processNext('wallet-1');
    await publisher.processNext('wallet-2');
    await waitForCondition(() => hinted, 'the first executor must fire its hint');
    await waitForCondition(() => executions === 2, 'the second executor must run');

    try {
      // One pass: A's hint eats its half-budget and stays pending; B still gets proven,
      // finalized, and its wallet released in the SAME pass.
      const outcome = await publisher.reconciliationScheduling.reconcile();
      expect(outcome.reconciled).toBeGreaterThanOrEqual(1);
      expect(outcome.pendingWork).toBe(true);
      expect((await publisher.getStatus(jobB))?.status).toBe('finalized');
      await expectWalletLock('wallet-2', 'released');
      expect((await publisher.getStatus(jobA))?.status).toBe('broadcast');
      await expectWalletLock('wallet-1', 'held');
    } finally {
      for (const release of tails) release();
    }
  });

  it('a deferred local repair retries through the cached proof without new chain reads', async () => {
    // r5 (3877726515) - after the early release, the settle-time repair can fail transiently
    // (repair-deferred: the wallet is already free, the job stays tx-bearing). The retry must
    // finalize through the CACHED proof - both chain-read counters stay at one across all
    // three passes.
    let proofAsks = 0;
    let recoveryAsks = 0;
    let repairAttempts = 0;
    const { publisher, jobId, releaseTail } = await parkedHintScenario({
      finalizeRecovered: async () => {
        repairAttempts += 1;
        if (repairAttempts === 1) throw new Error('transient local repair failure');
      },
      config: {
        chainProofResolver: async () => {
          proofAsks += 1;
          return { status: 'recovered', recovery: { txHash: KA_VM_EXECUTOR_TX_HASH } } as never;
        },
        knowledgeAssetVmPublishRecoveryResolver: async () => {
          recoveryAsks += 1;
          return {
            inclusion: { blockNumber: 1, txHash: KA_VM_EXECUTOR_TX_HASH },
            finalization: { merkleRoot: `0x${'12'.repeat(32)}` },
          } as never;
        },
      },
    });

    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('included');
    await expectWalletLock('wallet-1', 'released');

    releaseTail();
    await publisher.drainDetachedExecutions();

    // Settle pass: the repair throws once - repair-deferred, job stays included and released.
    await publisher.reconcileTransactions();
    expect(repairAttempts).toBe(1);
    expect((await publisher.getStatus(jobId))?.status).toBe('included');
    await expectWalletLock('wallet-1', 'released');

    // Retry pass: repair succeeds; the cached proof meant NO further chain reads anywhere.
    await publisher.reconcileTransactions();
    expect(repairAttempts).toBe(2);
    expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
    expect(proofAsks).toBe(1);
    expect(recoveryAsks).toBe(1);
  });

  it('an unexpected resolver failure in the hint lane surfaces instead of silently retrying', async () => {
    // r6 (3877748379) - the containment is scoped to the transition-and-release window (the
    // r2-validated retryable case). A programming error in a resolver must NOT be swallowed
    // into pending work: it propagates out of the pass to the runner's error path, exactly as
    // canonical-walk failures do, so a tight silent retry loop cannot form.
    const { publisher, jobId, releaseTail } = await parkedHintScenario({
      config: {
        chainProofResolver: () => { throw new TypeError('resolver programming error'); },
      },
    });
    try {
      await expect(publisher.reconcileTransactions()).rejects.toThrow('resolver programming error');
      expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
      await expectWalletLock('wallet-1', 'held');
    } finally {
      releaseTail();
    }
  });

  it('a persistently failing release escalates to the error path instead of looping silently', async () => {
    // r8 (3877817604) - transient containment has a budget. The lock deletion fails on EVERY
    // attempt: the first two passes are contained (pending work, hint retained), the third
    // escalates the error out of the pass to the runner's reporting and backoff. The hint
    // survives, so once the fault clears the release still completes.
    const { publisher, jobId, releaseTail } = await parkedHintScenario();
    const originalDelete = store.deleteByPattern.bind(store);
    let failLockDeletes = true;
    (store as unknown as { deleteByPattern: typeof originalDelete }).deleteByPattern =
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
      await expectWalletLock('wallet-1', 'released');
    } finally {
      releaseTail();
    }
  });

  it('a stale cached proof for a superseded transaction is ignored at consumption time', async () => {
    // r8 (3877817702) - the consumption-time hash guard: cached evidence whose hint hash no
    // longer matches the persisted broadcast (a reset and re-run happened between caching and
    // settle) must not finalize the job; the canonical resolver is asked fresh. The stale
    // cache is injected directly - constructing it naturally needs a full reset cycle, and the
    // guard under test only sees the map state.
    let proofAsks = 0;
    let recoveryAsks = 0;
    const { publisher, jobId, releaseTail } = await parkedHintScenario({
      config: {
        chainProofResolver: async () => {
          proofAsks += 1;
          return { status: 'recovered', recovery: { txHash: KA_VM_EXECUTOR_TX_HASH } } as never;
        },
        knowledgeAssetVmPublishRecoveryResolver: async () => {
          recoveryAsks += 1;
          return {
            inclusion: { blockNumber: 1, txHash: KA_VM_EXECUTOR_TX_HASH },
            finalization: { merkleRoot: `0x${'12'.repeat(32)}` },
          } as never;
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

  it('does not release on a hint when the handler has no lifecycle finalizer', async () => {
    // r9 (3877850638) - a handler may legally omit finalizeRecovered; the settle path then
    // answers 'unsupported' and expects the wallet lock intact. Early release would strand an
    // internally inconsistent held job, so hints are not even recorded for such a publisher:
    // the job follows plain detached behavior with its lock held.
    let hinted = false;
    let releaseTail!: () => void;
    const tailParked = new Promise<void>((resolve) => { releaseTail = resolve; });
    const publisher = createPublisher({
      detachReceiptReconciliation: true,
      chainProofResolver: async () => (
        { status: 'recovered', recovery: { txHash: KA_VM_EXECUTOR_TX_HASH } } as never),
      knowledgeAssetVmPublishRecoveryResolver: async () => ({
        inclusion: { blockNumber: 1, txHash: KA_VM_EXECUTOR_TX_HASH },
        finalization: { merkleRoot: `0x${'12'.repeat(32)}` },
      } as never),
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
    await stageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.processNext('wallet-1');
    await waitForCondition(() => hinted, 'the executor never fired the hint');

    try {
      await publisher.reconcileTransactions();
      await publisher.reconcileTransactions();
      // No early release, no included stamp: the wallet lock stays with the tx-bearing job.
      expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
      await expectWalletLock('wallet-1', 'held');
    } finally {
      releaseTail();
    }
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
    const { publisher, jobId, releaseTail } = await parkedHintScenario({
      operationKind: 'update',
      config: {
        chainProofResolver: async (lookup: { operationKind?: string; intendedUpdateRoot?: string }) => {
          proofAsks += 1;
          lookups.push({ operationKind: lookup.operationKind, intendedUpdateRoot: lookup.intendedUpdateRoot });
          return { status: 'recovered', recovery: { txHash: KA_VM_EXECUTOR_TX_HASH } } as never;
        },
        knowledgeAssetVmPublishRecoveryResolver: async () => {
          recoveryAsks += 1;
          return {
            inclusion: { blockNumber: 1, txHash: KA_VM_EXECUTOR_TX_HASH },
            finalization: { merkleRoot: `0x${'12'.repeat(32)}` },
          } as never;
        },
      },
    });

    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('included');
    await expectWalletLock('wallet-1', 'released');
    expect(lookups).toHaveLength(1);
    expect(lookups[0].operationKind).toBe('update');
    // The intended root rides the update lookup: the request's seal root, exactly.
    expect(lookups[0].intendedUpdateRoot?.toLowerCase()).toBe(`0x${'12'.repeat(32)}`);

    releaseTail();
    await publisher.drainDetachedExecutions();
    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
    expect(proofAsks).toBe(1);
    expect(recoveryAsks).toBe(1);
  });

  it('a slow successful hinted release does not consume the ordinary walk opportunity', async () => {
    // r13 (3878037023) - the half-budget sub-deadline bounds the hint lane's reads, but an
    // already-started transition is deliberately never aborted mid-write: wallet-1's lock
    // deletion succeeds SLOWLY, overrunning the whole 150ms pass budget. Ordinary broadcast
    // job B (executor settled, instant resolvers) must still be proven and finalized in the
    // SAME pass: the walk's budget is measured from its own start and is never below half.
    let hinted = 0;
    const tails: Array<() => void> = [];
    let executions = 0;
    const publisher = createPublisher({
      chainProofDispatchTimeBudgetMs: 150,
      detachReceiptReconciliation: true,
      chainProofResolver: async () => (
        { status: 'recovered', recovery: { txHash: KA_VM_EXECUTOR_TX_HASH } } as never),
      knowledgeAssetVmPublishRecoveryResolver: async () => ({
        inclusion: { blockNumber: 1, txHash: KA_VM_EXECUTOR_TX_HASH },
        finalization: { merkleRoot: `0x${'12'.repeat(32)}` },
      } as never),
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          executions += 1;
          const myExecution = executions;
          await input.publishOptions.onBeforeBroadcast?.({
            txHash: KA_VM_EXECUTOR_TX_HASH,
            operationKind: 'create',
          });
          input.publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (myExecution === 1) {
            input.publishOptions.onPublishConfirmed?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
            hinted += 1;
            await new Promise<void>((resolve) => { tails.push(resolve); });
          }
          throw new Error('post-write-ahead failure: recovery owns the record from here');
        },
        finalizeRecovered: async () => {},
      },
    });
    await stageShareSnapshot();
    await stageKnowledgeAssetShareSnapshot({ store, graphManager, shareOperationId: 'share-op-2' });
    const jobA = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const jobB = await publisher.enqueueKnowledgeAssetVmPublish(
      kaVmPublishRequest({ name: 'albums-next', shareOperationId: 'share-op-2' }),
    );
    await publisher.processNext('wallet-1');
    await publisher.processNext('wallet-2');
    await waitForCondition(() => hinted === 1, 'the first executor must fire its hint');
    await waitForCondition(() => executions === 2, 'the second executor must run');

    // Installed after the claims: wallet-1's release succeeds but takes longer than the
    // ENTIRE pass budget.
    const originalDelete = store.deleteByPattern.bind(store);
    let slowNextLockDelete = true;
    (store as unknown as { deleteByPattern: typeof originalDelete }).deleteByPattern =
      async (pattern: { subject?: string; graph?: string }) => {
        if (slowNextLockDelete && pattern?.subject === walletLockSubject('wallet-1')) {
          slowNextLockDelete = false;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return originalDelete(pattern as never);
      };

    try {
      const outcome = await publisher.reconciliationScheduling.reconcile();
      // A released (slowly) AND B fully reconciled in the same pass.
      expect(outcome.reconciled).toBeGreaterThanOrEqual(1);
      expect((await publisher.getStatus(jobA))?.status).toBe('included');
      await expectWalletLock('wallet-1', 'released');
      expect((await publisher.getStatus(jobB))?.status).toBe('finalized');
      await expectWalletLock('wallet-2', 'released');
    } finally {
      for (const release of tails) release();
    }
  });
});
