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
  KA_VM_VALIDATION,
  kaVmPublishRequest,
  stageKnowledgeAssetShareSnapshot,
} from './_helpers/ka-vm-publish.js';

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

  it('reports pending transaction reconciliation exactly while an unowned tx-bearing job exists', async () => {
    const publisher = createPublisher();
    await stageShareSnapshot();

    expect(await publisher.hasPendingTransactionReconciliation()).toBe(false);

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    expect(await publisher.hasPendingTransactionReconciliation()).toBe(false);

    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    expect(await publisher.hasPendingTransactionReconciliation()).toBe(false);

    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: KA_VM_EXECUTOR_TX_HASH, walletId: 'wallet-1', operationKind: 'create' },
    });
    expect(await publisher.hasPendingTransactionReconciliation()).toBe(true);

    await publisher.update(jobId, 'included', {
      broadcast: { txHash: KA_VM_EXECUTOR_TX_HASH, walletId: 'wallet-1' },
      inclusion: { txHash: KA_VM_EXECUTOR_TX_HASH, blockNumber: 42 },
    });
    expect(await publisher.hasPendingTransactionReconciliation()).toBe(true);

    // A held failure hands the job to the failed-job dispatcher, whose per-job due times pace
    // themselves — it must not keep the caller on the active cadence.
    await publisher.recordPublishFailure(jobId, {
      error: new Error('on-chain confirmation mismatch'),
      failedFromState: 'included',
      errorPayloadRef: `urn:dkg:test:error:${jobId}`,
    });
    expect(await publisher.hasPendingTransactionReconciliation()).toBe(false);
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
    let demandPokes = 0;
    publisher.setReconciliationDemandListener(() => { demandPokes += 1; });
    await stageShareSnapshot();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    const processed = await publisher.processNext('wallet-1');
    expect(processed?.status).toBe('broadcast');
    expect(processed?.timestamps.rpcAcceptedAt).toBeDefined();
    // The receipt task still owns the job: reconciliation would skip it, so it must not count as
    // pending work, and RPC acceptance alone must not have poked the listener.
    expect(await publisher.hasPendingTransactionReconciliation()).toBe(false);
    expect(demandPokes).toBe(0);

    releaseExecution();
    await publisher.drainDetachedExecutions();
    expect(demandPokes).toBe(1);
    expect(await publisher.hasPendingTransactionReconciliation()).toBe(true);
  });

  it('pokes the listener when an ambiguous post-write-ahead failure leaves a live broadcast behind', async () => {
    const publisher = createPublisher({
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          await input.publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          throw new Error('socket hang up mid-send');
        },
      },
    });
    let demandPokes = 0;
    publisher.setReconciliationDemandListener(() => { demandPokes += 1; });
    await stageShareSnapshot();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    const processed = await publisher.processNext('wallet-1');
    expect(processed?.status).toBe('broadcast');
    expect(demandPokes).toBe(1);
    expect(await publisher.hasPendingTransactionReconciliation()).toBe(true);
  });

  it('survives a listener that throws without touching job state', async () => {
    const publisher = createPublisher({
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          await input.publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
          throw new Error('socket hang up mid-send');
        },
      },
    });
    publisher.setReconciliationDemandListener(() => {
      throw new Error('scheduler exploded');
    });
    await stageShareSnapshot();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    const processed = await publisher.processNext('wallet-1');
    expect(processed?.status).toBe('broadcast');
    expect(await publisher.hasPendingTransactionReconciliation()).toBe(true);
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

    await publisher.reconcileTransactions();
    await publisher.reconcileTransactions();
    await publisher.reconcileTransactions();

    expect(asked.length).toBe(3);
    expect(new Set(asked).size).toBe(3);
    expect(new Set(asked)).toEqual(new Set(txHashes));
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
    const lock = await store.query(`SELECT ?job WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject('wallet-1')}> <${CONTROL_LOCKED_JOB}> ?job .
      }
    }`);
    expect(lock.type).toBe('bindings');
    if (lock.type === 'bindings') expect(lock.bindings).toEqual([]);
  });
});
