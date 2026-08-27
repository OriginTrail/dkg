/**
 * Demand-driven transaction reconciliation (10.0.14 async-publisher slowdown fix).
 *
 * Detached receipt reconciliation (#2310) moved finalization and wallet release of an
 * RPC-accepted publish onto `reconcileTransactions()`, which used to run only on the idle
 * `recoveryIntervalMs` sweep — so a successful transaction waited out up to several 60s windows
 * after its receipt task settled. These tests pin the demand channel that closes that gap:
 * the publisher pokes a listener at the moments a tx-bearing job stops being executor-owned,
 * reports whether unresolved chain questions remain, and rotates the live reconcile walk so a
 * budget-truncated pass cannot starve the tail. The end-to-end rows run a real runner with the
 * idle sweep effectively disabled (10-minute interval): finalization can then only happen
 * through the demand channel, which is exactly the property the fix must hold.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  KA_VM_KA_UAL,
  KA_VM_VALIDATION,
  kaVmPublishRequest,
  stageKnowledgeAssetShareSnapshot,
} from './_helpers/ka-vm-publish.js';
import { seedLegacyRawLiftTestJob } from './_helpers/legacy-raw-lift.js';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';

describe('async-lift reconciliation demand channel', () => {
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

  it('reports pass outcomes that track each job state: pendingWork only for unowned live transactions', async () => {
    const publisher = createPublisher({
      chainProofResolver: async () => ({ status: 'pending' }),
      knowledgeAssetVmPublishRecoveryResolver: async () => null,
    });
    await stageShareSnapshot();
    const reconcile = () => publisher.reconciliationScheduling.reconcile();

    expect(await reconcile()).toEqual({ reconciled: 0, pendingWork: false });

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    expect(await reconcile()).toEqual({ reconciled: 0, pendingWork: false });

    // A stranded pre-broadcast job is RESET by the pass (recover-reset lane), never pending:
    // nothing was sent, so there is no chain question to hold a cadence for.
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    expect(await reconcile()).toEqual({ reconciled: 1, pendingWork: false });
    expect((await publisher.getStatus(jobId))?.status).toBe('accepted');

    // Re-drive the same job to a live broadcast: now a chain question exists.
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: KA_VM_EXECUTOR_TX_HASH, walletId: 'wallet-1', operationKind: 'create' },
    });
    expect(await reconcile()).toEqual({ reconciled: 0, pendingWork: true });

    await publisher.update(jobId, 'included', {
      broadcast: { txHash: KA_VM_EXECUTOR_TX_HASH, walletId: 'wallet-1' },
      inclusion: { txHash: KA_VM_EXECUTOR_TX_HASH, blockNumber: 42 },
    });
    expect(await reconcile()).toEqual({ reconciled: 0, pendingWork: true });

    // A held failure hands the job to the failed-job dispatcher, whose per-job due times pace
    // themselves — it must not keep the caller on the active cadence.
    await publisher.recordPublishFailure(jobId, {
      error: new Error('on-chain confirmation mismatch'),
      failedFromState: 'included',
      errorPayloadRef: `urn:dkg:test:error:${jobId}`,
    });
    expect(await reconcile()).toEqual({ reconciled: 0, pendingWork: false });
  });

  it('does not advertise a named-KA broadcast as active work when no recovery lane can move it', async () => {
    // The degraded configuration: a persisted named-KA broadcast on a publisher with NEITHER
    // the chain-proof resolver NOR the named recovery resolver. The record is deliberately held
    // for safety and no pass can ever transition it — reporting it as pending would pin the
    // scheduling caller to the active cadence (a full inventory per tick) forever. It stays
    // eligible for the idle crash-recovery sweep and counts again once a resolver is configured.
    const publisher = createPublisher();
    await stageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: KA_VM_EXECUTOR_TX_HASH, walletId: 'wallet-1', operationKind: 'create' },
    });

    expect(await publisher.reconciliationScheduling.reconcile()).toEqual({ reconciled: 0, pendingWork: false });
    expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');

    // The same record on a resolver-equipped publisher over the same store IS active work.
    const equipped = createPublisher({
      chainProofResolver: async () => ({ status: 'pending' }),
      knowledgeAssetVmPublishRecoveryResolver: async () => null,
    });
    expect(await equipped.reconciliationScheduling.reconcile()).toEqual({ reconciled: 0, pendingWork: true });
  });

  it('excludes an executor-owned detached job from pending work and pokes the listener when it settles', async () => {
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const publisher = createPublisher({
      detachReceiptReconciliation: true,
      chainProofResolver: async () => ({ status: 'pending' }),
      knowledgeAssetVmPublishRecoveryResolver: async () => null,
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          await input.publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          input.publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          await executionGate;
          throw new Error('receipt polling timed out after accepted broadcast');
        },
      },
    });
    const outlookAtPoke: Promise<boolean>[] = [];
    publisher.reconciliationScheduling.attachScheduler({
      onWalletRelease: () => {},
      onReconciliationDemand: () => {
        // Ground truth at poke time: an invited pass must already be able to act — it reports
        // remaining work (or settles something) only if the announced job is visible to it.
        outlookAtPoke.push(publisher.reconciliationScheduling.reconcile()
          .then((outcome) => outcome.pendingWork || outcome.reconciled > 0));
      },
    });
    await stageShareSnapshot();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    const processed = await publisher.processNext('wallet-1');
    expect(processed?.status).toBe('broadcast');
    expect(processed?.timestamps.rpcAcceptedAt).toBeDefined();
    // The receipt task still owns the job: a pass running now must skip it and report no
    // pending work, and RPC acceptance alone must not have poked the listener.
    expect(await publisher.reconciliationScheduling.reconcile()).toEqual({ reconciled: 0, pendingWork: false });
    expect(outlookAtPoke).toHaveLength(0);

    releaseExecution();
    await publisher.drainDetachedExecutions();
    expect(outlookAtPoke).toHaveLength(1);
    // The settle poke fires after the detached-ownership marker is cleared, so the invited pass
    // can already act.
    await expect(outlookAtPoke[0]).resolves.toBe(true);
  });

  it('pokes the listener for an ambiguous post-write-ahead failure only at the ownership boundary', async () => {
    const publisher = createPublisher({
      chainProofResolver: async () => ({ status: 'pending' }),
      knowledgeAssetVmPublishRecoveryResolver: async () => null,
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          await input.publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          throw new Error('socket hang up mid-send');
        },
      },
    });
    // r1 (🔴 3872361393) — the poke must fire only once the invited pass can already act on the
    // job. Reading the outlook FROM the listener pins that: a poke emitted while the job still
    // held its activeProcessJobIds marker (the pre-fix placement, inside the ambiguous-broadcast
    // catch) reads false here, spends the one-shot demand on a pass that skips the job, and
    // parks it for the idle sweep.
    const outlookAtPoke: Promise<boolean>[] = [];
    publisher.reconciliationScheduling.attachScheduler({
      onWalletRelease: () => {},
      onReconciliationDemand: () => {
        // Ground truth at poke time: an invited pass must already be able to act — it reports
        // remaining work (or settles something) only if the announced job is visible to it.
        outlookAtPoke.push(publisher.reconciliationScheduling.reconcile()
          .then((outcome) => outcome.pendingWork || outcome.reconciled > 0));
      },
    });
    await stageShareSnapshot();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    const processed = await publisher.processNext('wallet-1');
    expect(processed?.status).toBe('broadcast');
    expect(outlookAtPoke).toHaveLength(1);
    await expect(outlookAtPoke[0]).resolves.toBe(true);
  });

  it('a stale detach from a superseded owner does not tear down the current attachment', async () => {
    const publisher = createPublisher({
      chainProofResolver: async () => ({ status: 'pending' }),
      knowledgeAssetVmPublishRecoveryResolver: async () => null,
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          await input.publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          throw new Error('socket hang up mid-send');
        },
      },
    });
    const pokes: string[] = [];
    const detachSuperseded = publisher.reconciliationScheduling.attachScheduler({
      onReconciliationDemand: () => pokes.push('superseded:demand'),
      onWalletRelease: (walletId) => pokes.push(`superseded:release:${walletId}`),
    });
    publisher.reconciliationScheduling.attachScheduler({
      onReconciliationDemand: () => pokes.push('current'),
      onWalletRelease: () => {},
    });
    // A new runner incarnation took over the attachment — BOTH callbacks together, so scheduler
    // ownership can never be split — and the superseded owner's detach firing late (e.g. from a
    // delayed stop()) must not silence the takeover.
    detachSuperseded();
    await stageShareSnapshot();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    const processed = await publisher.processNext('wallet-1');
    expect(processed?.status).toBe('broadcast');
    expect(pokes).toEqual(['current']);
  });

  it('survives a listener that throws without touching job state', async () => {
    const publisher = createPublisher({
      chainProofResolver: async () => ({ status: 'pending' }),
      knowledgeAssetVmPublishRecoveryResolver: async () => null,
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          await input.publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          throw new Error('socket hang up mid-send');
        },
      },
    });
    publisher.reconciliationScheduling.attachScheduler({
      onWalletRelease: () => {},
      onReconciliationDemand: () => {
        throw new Error('scheduler exploded');
      },
    });
    await stageShareSnapshot();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    const processed = await publisher.processNext('wallet-1');
    expect(processed?.status).toBe('broadcast');
    expect(await publisher.reconciliationScheduling.reconcile()).toEqual({ reconciled: 0, pendingWork: true });
  });

  it('rotates the live reconcile walk so a budget-truncated pass cannot starve the tail', async () => {
    const asked: string[] = [];
    const publisher = createPublisher({
      chainProofDispatchTimeBudgetMs: 5,
      // Never settles: every pass spends its whole budget on the first job it asks, which is
      // exactly the starvation shape — only the rotation lets the other jobs be reached.
      chainProofResolver: (lookup) => {
        asked.push((lookup as { txHash?: string }).txHash ?? 'unknown');
        return new Promise(() => {});
      },
      knowledgeAssetVmPublishRecoveryResolver: async () => null,
    });
    await stageShareSnapshot();

    const txHashes: string[] = [];
    for (const wallet of ['wallet-1', 'wallet-2', 'wallet-3'] as const) {
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(
        kaVmPublishRequest({ name: `album-${wallet}` }),
      );
      const txHash = `0x${wallet.slice(-1).repeat(64)}`;
      txHashes.push(txHash);
      await publisher.claimNext(wallet);
      await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      await publisher.update(jobId, 'broadcast', {
        broadcast: { txHash: txHash as `0x${string}`, walletId: wallet, operationKind: 'create' },
      });
    }

    // Each budget-truncated pass reports its remaining work atomically in its own outcome —
    // the probed job stays pending and the deadline-skipped tail counts as remaining too.
    for (let pass = 0; pass < 3; pass += 1) {
      const outcome = await publisher.reconciliationScheduling.reconcile();
      expect(outcome).toEqual({ reconciled: 0, pendingWork: true });
    }

    expect(asked.length).toBe(3);
    expect(new Set(asked).size).toBe(3);
    expect(new Set(asked)).toEqual(new Set(txHashes));
  });

  it('demands reconciliation when an escaped fault interrupts processNext after a durable broadcast', async () => {
    // r3 (🟡 3873024814, branarakic) — the write-ahead has durably recorded 'broadcast', then a
    // secondary store read fails (observed production shape: transient store-scheduler
    // saturation). processNext must still poke on its way out: ownership is released, only
    // reconciliation can settle the job, and without the poke it waits out the idle sweep.
    let failNextQuery = false;
    const saturatedStore = new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'query' && typeof value === 'function') {
          return async (...args: unknown[]) => {
            if (failNextQuery) {
              failNextQuery = false;
              throw new Error('store scheduler saturated');
            }
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as typeof store;
    const publisher = new TripleStoreAsyncLiftPublisher(saturatedStore, {
      now: () => ++now,
      idGenerator: () => `job-${++ids}`,
      chainProofResolver: async () => ({ status: 'pending' }),
      knowledgeAssetVmPublishRecoveryResolver: async () => null,
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          await input.publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          // Arm the failure for the next store read — the ambiguous path's own job re-read —
          // so the fault escapes process() AFTER the durable broadcast exists.
          failNextQuery = true;
          throw new Error('socket hang up mid-send');
        },
      },
    });
    const outlookAtPoke: Promise<boolean>[] = [];
    publisher.reconciliationScheduling.attachScheduler({
      onWalletRelease: () => {},
      onReconciliationDemand: () => {
        // Ground truth at poke time: an invited pass must already be able to act — it reports
        // remaining work (or settles something) only if the announced job is visible to it.
        outlookAtPoke.push(publisher.reconciliationScheduling.reconcile()
          .then((outcome) => outcome.pendingWork || outcome.reconciled > 0));
      },
    });
    await stageShareSnapshot();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    await expect(publisher.processNext('wallet-1')).rejects.toThrow('store scheduler saturated');
    expect(outlookAtPoke).toHaveLength(1);
    // The poke fired after ownership release, with the durable broadcast visible to the pass.
    await expect(outlookAtPoke[0]).resolves.toBe(true);
  });

  it('reports pendingWork for the unresolved job even when the same pass settles another', async () => {
    // A pass may both settle and leave work: settling one job must not report the queue quiet
    // while another transaction still awaits proof.
    const txA = `0x${'aa'.repeat(32)}` as `0x${string}`;
    const txB = `0x${'bb'.repeat(32)}` as `0x${string}`;
    const publisher = createPublisher({
      chainProofResolver: async (lookup) => {
        const txHash = (lookup as { txHash?: string }).txHash;
        if (txHash === txA) return { status: 'recovered', recovery: { txHash: txA } } as never;
        return { status: 'pending' };
      },
      knowledgeAssetVmPublishRecoveryResolver: async () => ({
        inclusion: { blockNumber: 1, txHash: txA },
        finalization: { merkleRoot: `0x${'12'.repeat(32)}` },
      } as never),
      knowledgeAssetVmPublishHandler: {
        execute: async () => { throw new Error('executor must not run in this test'); },
        finalizeRecovered: async () => {},
      },
    });
    await stageShareSnapshot();

    const jobA = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-a');
    await publisher.update(jobA, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobA, 'broadcast', {
      broadcast: { txHash: txA, walletId: 'wallet-a', operationKind: 'create' },
    });
    const jobB = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: 'albums-pending' }));
    await publisher.claimNext('wallet-b');
    await publisher.update(jobB, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobB, 'broadcast', {
      broadcast: { txHash: txB, walletId: 'wallet-b', operationKind: 'create' },
    });

    const outcome = await publisher.reconciliationScheduling.reconcile();
    expect(outcome).toEqual({ reconciled: 1, pendingWork: true });
    expect((await publisher.getStatus(jobA))?.status).toBe('finalized');
    expect((await publisher.getStatus(jobB))?.status).toBe('broadcast');
  });

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

  it('pokes the wallet-release listener when the stale-lock sweep frees a wallet', async () => {
    const publisher = createPublisher();
    const pokes: string[] = [];
    publisher.reconciliationScheduling.attachScheduler({
      onReconciliationDemand: () => {},
      onWalletRelease: (walletId) => pokes.push(walletId),
    });
    await stageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    // The "crash": the claim never progresses and its 5-minute lease expires.
    now += 6 * 60_000;

    await publisher.recover();
    expect((await publisher.getStatus(jobId))?.status).toBe('accepted');
    // Both the sweep and the recover-reset release funnel through the one choke point; the
    // listener heard the wallet become claimable (deduplication is not required — the poke is
    // scheduling-only and the claim attempt re-checks every guard).
    expect(pokes.length).toBeGreaterThanOrEqual(1);
    expect(new Set(pokes)).toEqual(new Set(['wallet-1']));
  });

  it('capability startup recovery performs the real crash-recovery effects, not just the outcome shape', async () => {
    // The runner's capability path replaced `publisher.recover()` as the production startup
    // entry point. This row drives the REAL publisher through a REAL runner start: a crashed
    // process left a claimed job behind an expired wallet lease, and startup must requeue the
    // job and release the lock before wallet processing begins — a `recover()` that merely
    // returned the outcome shape would leave the post-crash wallet locked forever.
    const publisher = createPublisher();
    await stageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    expect((await publisher.getStatus(jobId))?.status).toBe('claimed');
    // The "crash": nothing progresses the claim, and its 5-minute lease expires.
    now += 6 * 60_000;

    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      pollIntervalMs: 600_000,
      recoveryIntervalMs: 600_000,
      // Paused start: recovery must still run in maintenance mode, before any claiming.
      startPaused: true,
      hasIncludedRecoveryResolver: true,
    });
    await runner.start();
    try {
      expect((await publisher.getStatus(jobId))?.status).toBe('accepted');
      const lock = await store.query(`SELECT ?job WHERE {
        GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
          <${walletLockSubject('wallet-1')}> <${CONTROL_LOCKED_JOB}> ?job .
        }
      }`);
      expect(lock.type).toBe('bindings');
      if (lock.type === 'bindings') expect(lock.bindings).toEqual([]);
    } finally {
      await runner.stop();
    }
  });

  it('hands a job the pass itself just failed to the same pass dispatcher, not the idle sweep', async () => {
    // A live job can transition INTO the held-failed state during the pass (here: the raw
    // lane's inconclusive-recovery timeout). The failed-job dispatcher runs in the same pass
    // and must see that transition — through the shared snapshot it would keep the wallet
    // parked until the idle sweep, which the per-lane inventories it replaced never did.
    const resolverAsks: string[] = [];
    const publisher = createPublisher({
      recoveryLookupTimeoutMs: 1_000,
      chainProofResolver: async (lookup) => {
        resolverAsks.push((lookup as { txHash?: string }).txHash ?? 'unknown');
        return { status: 'pending' };
      },
      knowledgeAssetVmPublishRecoveryResolver: async () => null,
    });
    await stageShareSnapshot();
    const jobId = await seedLegacyRawLiftTestJob(store, {
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
    }, { now: () => ++now, idGenerator: () => `raw-job-${++ids}` });
    await publisher.claimNext('wallet-raw');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: KA_VM_EXECUTOR_TX_HASH, walletId: 'wallet-raw', operationKind: 'create' },
    });
    // Sail past the inconclusive-recovery window so the live lane fails the job THIS pass.
    now += 5_000;

    const outcome = await publisher.reconciliationScheduling.reconcile();
    expect((await publisher.getStatus(jobId))?.status).toBe('failed');
    expect(outcome).toEqual({ reconciled: 1, pendingWork: false });
    // Two chain reads in ONE pass: the live lane's probe that timed the job out, then the
    // dispatcher's proof-first turn for the freshly held job.
    expect(resolverAsks).toEqual([KA_VM_EXECUTOR_TX_HASH, KA_VM_EXECUTOR_TX_HASH]);
  });

  it('runs exactly one queue inventory per reconcile pass across all three lanes', async () => {
    // r3-1 follow-up (branarakic 3873026014) — the lanes share one list() snapshot; per-tick
    // inventory cost must not scale with the number of lanes.
    const publisher = createPublisher({
      chainProofResolver: async () => ({ status: 'pending' }),
      knowledgeAssetVmPublishRecoveryResolver: async () => null,
    });
    await stageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: KA_VM_EXECUTOR_TX_HASH, walletId: 'wallet-1', operationKind: 'create' },
    });

    const listSpy = vi.spyOn(publisher, 'list');
    const outcome = await publisher.reconciliationScheduling.reconcile();
    expect(outcome).toEqual({ reconciled: 0, pendingWork: true });
    expect(listSpy).toHaveBeenCalledTimes(1);
    listSpy.mockRestore();
  });

  it('suppresses pending work and reconciliation while processNext still owns a live broadcast', async () => {
    let releaseExecutor!: () => void;
    const executorGate = new Promise<void>((resolve) => { releaseExecutor = resolve; });
    let broadcastPersisted!: () => void;
    const broadcastReady = new Promise<void>((resolve) => { broadcastPersisted = resolve; });
    const resolverAsks: string[] = [];
    const publisher = createPublisher({
      chainProofResolver: async (lookup) => {
        resolverAsks.push((lookup as { txHash?: string }).txHash ?? 'unknown');
        return { status: 'pending' };
      },
      knowledgeAssetVmPublishRecoveryResolver: async () => null,
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          await input.publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          broadcastPersisted();
          await executorGate;
          throw new Error('socket hang up mid-send');
        },
      },
    });
    const outlookAtPoke: Promise<boolean>[] = [];
    publisher.reconciliationScheduling.attachScheduler({
      onWalletRelease: () => {},
      onReconciliationDemand: () => {
        // Ground truth at poke time: an invited pass must already be able to act — it reports
        // remaining work (or settles something) only if the announced job is visible to it.
        outlookAtPoke.push(publisher.reconciliationScheduling.reconcile()
          .then((outcome) => outcome.pendingWork || outcome.reconciled > 0));
      },
    });
    await stageShareSnapshot();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    const processing = publisher.processNext('wallet-1');
    await broadcastReady;
    // r2-3 (🟡 3872744759) — the third conjunct of the actionability rule: the job is durably
    // 'broadcast' but processNext still owns it, so it is not pending, no demand has fired, and
    // a reconcile pass running NOW must not spend a chain read on it.
    expect(await publisher.reconciliationScheduling.reconcile()).toEqual({ reconciled: 0, pendingWork: false });
    expect(resolverAsks).toHaveLength(0);
    expect(outlookAtPoke).toHaveLength(0);

    releaseExecutor();
    const processed = await processing;
    expect(processed?.status).toBe('broadcast');
    // Ownership released at the boundary: the poke fired with the work already visible, and a
    // pass now reaches the chain-proof resolver for this job.
    expect(outlookAtPoke).toHaveLength(1);
    await expect(outlookAtPoke[0]).resolves.toBe(true);
    const outcome = await publisher.reconciliationScheduling.reconcile();
    expect(outcome).toEqual({ reconciled: 0, pendingWork: true });
    // The poke-time ground-truth pass and the explicit pass above each reached the resolver.
    expect(resolverAsks).toEqual([KA_VM_EXECUTOR_TX_HASH, KA_VM_EXECUTOR_TX_HASH]);
  });

  it('finalizes a detached publish through the demand channel alone, one send, with the idle sweep parked', async () => {
    const executions: string[] = [];
    let proofAsks = 0;
    const publisher = createPublisher({
      detachReceiptReconciliation: true,
      // The first ask answers 'pending' (receipt not yet provable), later asks answer
      // 'recovered' — so finalization needs BOTH the settle poke and the active re-check
      // cadence, never the parked idle sweep.
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
          executions.push(input.walletId);
          await input.publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          input.publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          // Simulated receipt wait: settle shortly after acceptance, like a mined tx.
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error('detached executor result must not be needed for finalization');
        },
        finalizeRecovered: async () => {},
      },
    });
    await stageShareSnapshot();

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    const runner = new AsyncLiftRunner({
      publisher,
      walletIds: ['wallet-1'],
      pollIntervalMs: 5,
      // The idle sweep is parked ten minutes out: any finalization inside this test can only
      // have come through the demand poke plus the active re-check cadence.
      recoveryIntervalMs: 600_000,
      activeRecoveryIntervalMs: 10,
      // Keep the attempt floor below the active cadence; production keeps its 1s default.
      errorBackoffMs: 10,
      hasIncludedRecoveryResolver: true,
    });
    await runner.start();
    try {
      const deadline = Date.now() + 15_000;
      while ((await publisher.getStatus(jobId))?.status !== 'finalized') {
        if (Date.now() > deadline) {
          throw new Error(
            `job never finalized through the demand channel (status: ${(await publisher.getStatus(jobId))?.status})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await runner.stop();
    }

    // One send, at least two proof asks (the pending answer forced the active re-check), and the
    // wallet lock gone — chain proof released it, so the next job could claim this wallet.
    expect(executions).toEqual(['wallet-1']);
    expect(proofAsks).toBeGreaterThanOrEqual(2);
    // The settled queue reports no remaining live work — the false polarity of the atomic outcome.
    expect(await publisher.reconciliationScheduling.reconcile()).toEqual({ reconciled: 0, pendingWork: false });
    const lock = await store.query(`SELECT ?job WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject('wallet-1')}> <${CONTROL_LOCKED_JOB}> ?job .
      }
    }`);
    expect(lock.type).toBe('bindings');
    if (lock.type === 'bindings') expect(lock.bindings).toEqual([]);
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
});
