/**
 * Wallet release / claim-demand integration rows (split from the reconciliation-demand suite,
 * r4 3875114218): everything that pins the event-driven wallet turnover channel on the REAL
 * publisher - the release poke at the one choke point, its ordering against the reset writes,
 * and the end-to-end reclaim through a runner with the poll parked.
 *
 * The ordering rows share one oracle: OxigraphStore.query executes the native query
 * synchronously before its first await, so query promises CAPTURED inside the release listener
 * read the store exactly as a claimer would see it at the instant the one-shot poke fires -
 * the job status must already be 'accepted' AND the wallet lock must already be gone
 * (r4 3875113431: an accepted job is still unclaimable while its lock exists, so a
 * status-only oracle would miss a notify-before-lock-delete regression).
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
  CONTROL_STATUS,
  DEFAULT_CONTROL_GRAPH_URI,
  DEFAULT_WALLET_LOCK_GRAPH_URI,
  jobSubject,
  walletLockSubject,
} from '../src/async-lift-control-plane.js';
import {
  KA_VM_EXECUTOR_TX_HASH,
  KA_VM_KA_UAL,
  KA_VM_VALIDATION,
  kaVmPublishRequest,
  stageKnowledgeAssetShareSnapshot,
} from './_helpers/ka-vm-publish.js';
import { seedLegacyRawLiftTestJob } from './_helpers/legacy-raw-lift.js';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';

describe('async-lift wallet release channel', () => {
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
   * The poke-time claimability oracle, shared by every reordered reset site: both queries are
   * issued synchronously inside the listener, so they read the store at the instant the poke
   * fired. Claimable means BOTH the reset is visible ('accepted') and the wallet lock is gone.
   */
  function claimabilityProbe(publisher: TripleStoreAsyncLiftPublisher, getJobId: () => string) {
    const pokes: Array<{
      walletId: string;
      status: ReturnType<typeof store.query>;
      lock: ReturnType<typeof store.query>;
    }> = [];
    const detach = publisher.reconciliationScheduling.attachScheduler({
      onReconciliationDemand: () => {},
      onWalletRelease: (walletId) => {
        pokes.push({
          walletId,
          status: store.query(`SELECT ?status WHERE {
            GRAPH <${DEFAULT_CONTROL_GRAPH_URI}> {
              <${jobSubject(getJobId())}> <${CONTROL_STATUS}> ?status .
            }
          }`),
          lock: store.query(`SELECT ?job WHERE {
            GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
              <${walletLockSubject(walletId)}> <${CONTROL_LOCKED_JOB}> ?job .
            }
          }`),
        });
      },
    });
    async function expectLastPokeClaimable(walletId: string): Promise<void> {
      expect(pokes.length).toBeGreaterThanOrEqual(1);
      const last = pokes[pokes.length - 1];
      expect(last.walletId).toBe(walletId);
      const status = await last.status;
      expect(status.type).toBe('bindings');
      if (status.type === 'bindings') {
        // Bindings carry N-Triples-serialized terms, so the literal arrives quoted.
        expect(status.bindings[0]?.['status']).toBe('"accepted"');
      }
      const lock = await last.lock;
      expect(lock.type).toBe('bindings');
      if (lock.type === 'bindings') expect(lock.bindings).toEqual([]);
    }
    return { pokes, detach, expectLastPokeClaimable };
  }

  it('pokes the wallet-release listener with the wallet id on a real finalize-release, exclusively attached', async () => {
    const txA = `0x${'aa'.repeat(32)}` as `0x${string}`;
    const publisher = createPublisher({
      chainProofResolver: async () => ({ status: 'recovered', recovery: { txHash: txA } } as never),
      knowledgeAssetVmPublishRecoveryResolver: async () => ({
        inclusion: { blockNumber: 1, txHash: txA },
        finalization: { merkleRoot: `0x${'12'.repeat(32)}` },
      } as never),
      knowledgeAssetVmPublishHandler: {
        execute: async () => { throw new Error('executor must not run in this test'); },
        finalizeRecovered: async () => {},
      },
    });
    const pokes: string[] = [];
    // Atomic takeover: the second attachScheduler supersedes BOTH callbacks of the first, and
    // the superseded owner's late detach is a no-op — ownership transfers wholesale, never split.
    const detachSuperseded = publisher.reconciliationScheduling.attachScheduler({
      onReconciliationDemand: () => pokes.push('superseded:demand'),
      onWalletRelease: (walletId) => pokes.push(`superseded:${walletId}`),
    });
    publisher.reconciliationScheduling.attachScheduler({
      onReconciliationDemand: () => {},
      onWalletRelease: (walletId) => pokes.push(walletId),
    });
    detachSuperseded();
    await stageShareSnapshot();

    const jobA = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-a');
    await publisher.update(jobA, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobA, 'broadcast', {
      broadcast: { txHash: txA, walletId: 'wallet-a', operationKind: 'create' },
    });

    expect(await publisher.reconciliationScheduling.reconcile()).toEqual({ reconciled: 1, pendingWork: false });
    expect((await publisher.getStatus(jobA))?.status).toBe('finalized');
    // The chain-proof release fired the poke with the released wallet's id — and only for the
    // current attachment.
    expect(pokes).toEqual(['wallet-a']);
  });

  it('completes a real wallet release even when the scheduler wallet listener throws', async () => {
    // The release choke point guarantees listener failures cannot escape into lock state; this
    // row proves it through an actual finalize-release: reconciliation resolves, the job is
    // finalized, and the wallet lock is gone despite the exploding listener.
    const txA = `0x${'aa'.repeat(32)}` as `0x${string}`;
    const publisher = createPublisher({
      chainProofResolver: async () => ({ status: 'recovered', recovery: { txHash: txA } } as never),
      knowledgeAssetVmPublishRecoveryResolver: async () => ({
        inclusion: { blockNumber: 1, txHash: txA },
        finalization: { merkleRoot: `0x${'12'.repeat(32)}` },
      } as never),
      knowledgeAssetVmPublishHandler: {
        execute: async () => { throw new Error('executor must not run in this test'); },
        finalizeRecovered: async () => {},
      },
    });
    publisher.reconciliationScheduling.attachScheduler({
      onReconciliationDemand: () => {},
      onWalletRelease: () => { throw new Error('scheduler exploded'); },
    });
    await stageShareSnapshot();
    const jobA = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-a');
    await publisher.update(jobA, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobA, 'broadcast', {
      broadcast: { txHash: txA, walletId: 'wallet-a', operationKind: 'create' },
    });

    expect(await publisher.reconciliationScheduling.reconcile()).toEqual({ reconciled: 1, pendingWork: false });
    expect((await publisher.getStatus(jobA))?.status).toBe('finalized');
    const lock = await store.query(`SELECT ?job WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject('wallet-a')}> <${CONTROL_LOCKED_JOB}> ?job .
      }
    }`);
    expect(lock.type).toBe('bindings');
    if (lock.type === 'bindings') expect(lock.bindings).toEqual([]);
  });

  it('stale-sweep recovery re-invites the claim once the reset is claim-visible', async () => {
    // r3 (🔴 3874961042) - the sweep runs BEFORE the recovery pass resets the expired job, so
    // its poke fires while the job is still 'claimed': a one-shot wake consumed on nothing
    // claimable. Counting that unusable early poke as success hid exactly the gap the wake
    // channel exists to close - the reset then landed unannounced and a parked runner would
    // idle out the poll. The LAST poke must find the job fully claimable.
    const publisher = createPublisher();
    let jobId = '';
    const probe = claimabilityProbe(publisher, () => jobId);
    await stageShareSnapshot();
    jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    // The "crash": the claim never progresses and its 5-minute lease expires.
    now += 6 * 60_000;

    await publisher.recover();
    expect((await publisher.getStatus(jobId))?.status).toBe('accepted');
    // Every poke funnels through the one choke point and names the freed wallet (deduplication
    // is not required - the poke is scheduling-only and the claim re-checks every guard).
    expect(new Set(probe.pokes.map((p) => p.walletId))).toEqual(new Set(['wallet-1']));
    await probe.expectLastPokeClaimable('wallet-1');
  });

  it('turns the wallet over to the next job through the release poke with the poll parked', async () => {
    // The end-to-end discriminator for event-driven turnover: with pollIntervalMs parked at ten
    // minutes, job2 can only leave 'accepted' if the wallet-release poke wakes the claim loop
    // after job1's finalize. job2 deliberately has no staged snapshot — it only needs to be
    // CLAIMED (its validation then fails), which is exactly the observable the wake governs.
    let proofAsks = 0;
    const publisher = createPublisher({
      detachReceiptReconciliation: true,
      chainProofResolver: async () => {
        proofAsks += 1;
        if (proofAsks < 2) return { status: 'pending' };
        return { status: 'recovered', recovery: { txHash: KA_VM_EXECUTOR_TX_HASH } } as never;
      },
      knowledgeAssetVmPublishRecoveryResolver: async () => ({
        inclusion: { blockNumber: 1, txHash: KA_VM_EXECUTOR_TX_HASH },
        finalization: { merkleRoot: `0x${'12'.repeat(32)}` },
      } as never),
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          await input.publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          input.publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error('detached executor result must not be needed for finalization');
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
      // THE point of this row: the claim poll is parked ten minutes out. job1 is claimed by the
      // loop's first iteration (no sleep precedes it); job2's claim can only come from the poke.
      pollIntervalMs: 600_000,
      recoveryIntervalMs: 600_000,
      activeRecoveryIntervalMs: 10,
      errorBackoffMs: 10,
      hasIncludedRecoveryResolver: true,
    });
    await runner.start();
    try {
      const deadline = Date.now() + 15_000;
      while (true) {
        const status2 = (await publisher.getStatus(job2))?.status;
        if (status2 && status2 !== 'accepted') break;
        if (Date.now() > deadline) {
          throw new Error(
            `job2 was never claimed through the release poke (job1: ${(await publisher.getStatus(job1))?.status}, job2: ${status2})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await runner.stop();
    }
    expect((await publisher.getStatus(job1))?.status).toBe('finalized');
  });

  it('reclaims a proof-driven reset promptly: the release poke fires only after the reset is claim-visible', async () => {
    // r2 (🔴 3874704509) - lock deletion and the job reset are separate writes, and the wake is a
    // one-shot. If the poke fired on lock deletion BEFORE the reset write, the woken loop would
    // find nothing accepted, park, and the reset would then land unannounced - idling out the
    // (parked) poll. This row pins the ordering end to end: one create job whose transaction is
    // proven not-found, no other accepted work, poll parked at ten minutes. The executor can only
    // run a second time if the reset-site poke found the reset already claim-visible.
    let executions = 0;
    const publisher = createPublisher({
      detachReceiptReconciliation: true,
      chainProofResolver: async () => ({ status: 'not-found' }),
      // Never invoked for a not-found proof, but its presence gates detached receipt
      // reconciliation - without it the executor is never detached and no boundary poke fires.
      knowledgeAssetVmPublishRecoveryResolver: async () => ({
        inclusion: { blockNumber: 1, txHash: KA_VM_EXECUTOR_TX_HASH },
        finalization: { merkleRoot: `0x${'12'.repeat(32)}` },
      } as never),
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          executions += 1;
          if (executions === 1) {
            // The write-ahead stamps the durable signed-operation marker: not-found release is
            // create-only, and queuedLiftOperationKind answers 'update' for an unmarked record.
            await input.publishOptions.onBeforeBroadcast?.({
              txHash: KA_VM_EXECUTOR_TX_HASH,
              operationKind: 'create',
            });
            input.publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw new Error('detached send fails after broadcast: proof must decide');
          }
          throw new Error('second attempt reached the executor: the reset was reclaimed');
        },
        finalizeRecovered: async () => {},
      },
    });
    await stageShareSnapshot();
    const job = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

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
      const deadline = Date.now() + 15_000;
      while (executions < 2) {
        if (Date.now() > deadline) {
          throw new Error(
            `the reset job was never reclaimed through the release poke (status: ${(await publisher.getStatus(job))?.status}, executions: ${executions})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await runner.stop();
    }
  });

  it('fires the release poke only after the not-found reset is claim-visible in the store', async () => {
    // r2 (🔴 3874704509) - the direct ordering oracle behind the reclaim row above. The wake is
    // a one-shot claim invitation, so at the instant it fires the reset must already be readable
    // by a claimer. The end-to-end row cannot pin that by itself: against this in-memory store
    // the reset write usually wins the race in either order, hiding exactly the bug the order
    // exists to prevent.
    const txA = `0x${'ab'.repeat(32)}` as `0x${string}`;
    const publisher = createPublisher({
      chainProofResolver: async () => ({ status: 'not-found' }),
      knowledgeAssetVmPublishHandler: {
        execute: async () => { throw new Error('executor must not run in this test'); },
        finalizeRecovered: async () => {},
      },
    });
    let jobA = '';
    const probe = claimabilityProbe(publisher, () => jobA);
    await stageShareSnapshot();
    jobA = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-a');
    await publisher.update(jobA, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobA, 'broadcast', {
      broadcast: { txHash: txA, walletId: 'wallet-a', operationKind: 'create' },
    });
    try {
      expect(await publisher.reconciliationScheduling.reconcile())
        .toEqual({ reconciled: 1, pendingWork: false });
    } finally {
      probe.detach();
    }
    expect(probe.pokes).toHaveLength(1);
    await probe.expectLastPokeClaimable('wallet-a');
  });

  it('raw evidence-free reset: the release poke fires only after the reset is claim-visible', async () => {
    // r4 (🔴 3875113431) - the reset sites were reordered independently, so each needs its own
    // poke-time oracle. This is the resolver-less raw lane: a broadcast raw job with NO recorded
    // transaction evidence is the one thing a node without a chain-proof resolver may reset.
    const publisher = createPublisher();
    let jobId = '';
    const probe = claimabilityProbe(publisher, () => jobId);
    // The evidence-free broadcast is a PRE-write-ahead residual: this build cannot produce one
    // (reaching 'broadcast' now records the signed hash first), so it arrives only through the
    // legacy record importer - seeded here in the crashed shape directly.
    jobId = await seedLegacyRawLiftTestJob(store, {
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
    }, {
      now: () => ++now,
      idGenerator: () => `raw-job-${++ids}`,
      overrides: {
        // The crashed shape: status moved to 'broadcast' but the crash preceded any signing,
        // so there is NO broadcast metadata - exactly what the evidence-free branch resets.
        status: 'broadcast',
        claim: { walletId: 'wallet-raw', claimToken: 'wallet-raw:legacy:1', claimLeaseExpiresAt: 999_999 },
      } as never,
    });

    expect(await publisher.reconciliationScheduling.reconcile())
      .toEqual({ reconciled: 1, pendingWork: false });
    expect((await publisher.getStatus(jobId))?.status).toBe('accepted');
    await probe.expectLastPokeClaimable('wallet-raw');
  });

  it('failed-job dispatcher reset: the release poke fires only after the reset is claim-visible', async () => {
    // r4 (🔴 3875113431) - the fourth reordered site: the dispatcher releases a HELD failed
    // create for a re-run once its transaction is proven absent, and that reset too must be
    // claim-visible before its one-shot poke fires.
    const publisher = createPublisher({
      chainProofResolver: async () => ({ status: 'not-found' }),
      knowledgeAssetVmPublishRecoveryResolver: async () => null,
    });
    let jobId = '';
    const probe = claimabilityProbe(publisher, () => jobId);
    await stageShareSnapshot();
    jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: KA_VM_EXECUTOR_TX_HASH, walletId: 'wallet-1', operationKind: 'create' },
    });
    await publisher.recordPublishFailure(jobId, {
      error: new Error('send window exploded'),
      failedFromState: 'broadcast',
      errorPayloadRef: `urn:dkg:test:error:${jobId}`,
    });

    expect(await publisher.reconciliationScheduling.reconcile())
      .toEqual({ reconciled: 1, pendingWork: false });
    expect((await publisher.getStatus(jobId))?.status).toBe('accepted');
    await probe.expectLastPokeClaimable('wallet-1');
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
      const deadline = Date.now() + 15_000;
      while (true) {
        const status2 = (await publisher.getStatus(job2))?.status;
        if (status2 && status2 !== 'accepted') break;
        if (Date.now() > deadline) {
          throw new Error(
            `job2 was never claimed through the hint-driven release (job1: ${(await publisher.getStatus(job1))?.status}, job2: ${status2})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // job1's queue truth at this instant: inclusion observed and stamped, wallet gone, but
      // NOT finalized - the mutating repair must wait for the executor to settle (r26).
      expect((await publisher.getStatus(job1))?.status).toBe('included');
      // job2 went all the way to its own executor through the freed wallet.
      expect(executions).toBeGreaterThanOrEqual(2);

      releaseTail();
      const finalizeDeadline = Date.now() + 15_000;
      while ((await publisher.getStatus(job1))?.status !== 'finalized') {
        if (Date.now() > finalizeDeadline) {
          throw new Error(
            `job1 never finalized after the executor tail settled (status: ${(await publisher.getStatus(job1))?.status})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      releaseTail();
      await runner.stop();
    }
  });

  it('ignores a receipt hint whose hash does not match the persisted write-ahead evidence', async () => {
    // The hint is scheduling-only: an executor that reports a hash the durable write-ahead
    // never recorded (a lie, or a stale attempt surviving a reset) must not move the record or
    // the wallet. Everything then flows through the normal settle path.
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
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          await input.publishOptions.onBeforeBroadcast?.({
            txHash: KA_VM_EXECUTOR_TX_HASH,
            operationKind: 'create',
          });
          input.publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          await new Promise((resolve) => setTimeout(resolve, 10));
          input.publishOptions.onPublishConfirmed?.({ txHash: `0x${'99'.repeat(32)}` });
          hinted = true;
          await tailParked;
        },
        finalizeRecovered: async () => {},
      },
    });
    await stageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.processNext('wallet-1');
    const hintDeadline = Date.now() + 5_000;
    while (!hinted) {
      if (Date.now() > hintDeadline) throw new Error('the executor never fired the hint');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Two passes: the mismatched hint must not act on the first, and must be GONE (not merely
    // unlucky) on the second.
    await publisher.reconcileTransactions();
    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
    const lock = await store.query(`SELECT ?job WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject('wallet-1')}> <${CONTROL_LOCKED_JOB}> ?job .
      }
    }`);
    expect(lock.type).toBe('bindings');
    if (lock.type === 'bindings') expect(lock.bindings).toHaveLength(1);

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
    let releaseTail!: () => void;
    const tailParked = new Promise<void>((resolve) => { releaseTail = resolve; });
    let hinted = false;
    let verdict: 'pending' | 'recovered' = 'pending';
    const publisher = createPublisher({
      detachReceiptReconciliation: true,
      chainProofResolver: async () => (verdict === 'pending'
        ? { status: 'pending' }
        : { status: 'recovered', recovery: { txHash: KA_VM_EXECUTOR_TX_HASH } } as never),
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
          hinted = true;
          await tailParked;
        },
        finalizeRecovered: async () => {},
      },
    });
    await stageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.processNext('wallet-1');
    const hintDeadline = Date.now() + 5_000;
    while (!hinted) {
      if (Date.now() > hintDeadline) throw new Error('the executor never fired the hint');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(await publisher.reconciliationScheduling.reconcile())
      .toEqual({ reconciled: 0, pendingWork: true });
    expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
    const lock = await store.query(`SELECT ?job WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject('wallet-1')}> <${CONTROL_LOCKED_JOB}> ?job .
      }
    }`);
    expect(lock.type).toBe('bindings');
    if (lock.type === 'bindings') expect(lock.bindings).toHaveLength(1);

    verdict = 'recovered';
    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('included');
    const lockAfter = await store.query(`SELECT ?job WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject('wallet-1')}> <${CONTROL_LOCKED_JOB}> ?job .
      }
    }`);
    expect(lockAfter.type).toBe('bindings');
    if (lockAfter.type === 'bindings') expect(lockAfter.bindings).toEqual([]);

    releaseTail();
    await publisher.drainDetachedExecutions();
    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
  });

  it('pays each canonical chain read once: the settle-time finalize consumes the early proof', async () => {
    // The early release runs the reconciler's two reads; the settle-time finalize must consume
    // that cached proof instead of re-asking the chain - otherwise the hint lane would ADD
    // chain load to every publish instead of moving it earlier.
    let releaseTail!: () => void;
    const tailParked = new Promise<void>((resolve) => { releaseTail = resolve; });
    let hinted = false;
    let proofAsks = 0;
    let recoveryAsks = 0;
    const publisher = createPublisher({
      detachReceiptReconciliation: true,
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
      knowledgeAssetVmPublishHandler: {
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
        finalizeRecovered: async () => {},
      },
    });
    await stageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.processNext('wallet-1');
    const hintDeadline = Date.now() + 5_000;
    while (!hinted) {
      if (Date.now() > hintDeadline) throw new Error('the executor never fired the hint');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

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
});
