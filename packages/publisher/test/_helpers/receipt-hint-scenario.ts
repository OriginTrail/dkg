/**
 * Shared receipt-hint test harness (r21 3878490032): the parked one-wallet and two-wallet
 * scenario builders, the polling helpers, and the wallet-lock assertion, behind one factory so
 * the three focused suites (core/evidence, scheduling/fairness, failure/retry) carry only
 * their distinguishing setup. Each suite creates a fresh harness per test.
 */
import { expect } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
  type PublishResult,
} from '../../src/index.js';
import {
  CONTROL_LOCKED_JOB,
  DEFAULT_WALLET_LOCK_GRAPH_URI,
  walletLockSubject,
} from '../../src/async-lift-control-plane.js';
import {
  KA_VM_EXECUTOR_TX_HASH,
  kaVmPublishRequest,
  kaVmRecoveryEvidence,
  recoveredResolution,
  stageKnowledgeAssetShareSnapshot,
} from './ka-vm-publish.js';

export function createReceiptHintHarness() {
  const state = { now: 1_000, ids: 0 };
  const store = new OxigraphStore();
  const graphManager = new GraphManager(store);

  function harnessCreatePublisher(
    config: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator'> = {},
  ): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++state.now,
      idGenerator: () => `job-${++state.ids}`,
      ...config,
    });
  }

  async function harnessStageShareSnapshot(): Promise<void> {
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
    const publisher = harnessCreatePublisher({
      detachReceiptReconciliation: true,
      chainProofResolver: async () => (
        recoveredResolution()),
      knowledgeAssetVmPublishRecoveryResolver: async () => kaVmRecoveryEvidence(),
      ...options.config,
      knowledgeAssetVmPublishHandler: {
        execute: async (input): Promise<PublishResult> => {
          await input.publishOptions.onBeforeBroadcast?.({
            txHash: KA_VM_EXECUTOR_TX_HASH,
            operationKind: options.operationKind ?? 'create',
          });
          input.publishOptions.onBroadcastAccepted?.({
            txHash: KA_VM_EXECUTOR_TX_HASH,
            operationKind: options.operationKind ?? 'create',
          });
          await new Promise((resolve) => setTimeout(resolve, 10));
          input.publishOptions.onPublishConfirmed?.({
            txHash: options.hintTxHash ?? KA_VM_EXECUTOR_TX_HASH,
          });
          hinted = true;
          if (options.tailAction === 'throw') {
            throw new Error('post-write-ahead failure: recovery owns the record from here');
          }
          await tailParked;
          // The rows never consume this result: detached executions drop it by design, and the
          // no-detach row pins the historical inline path, where this stub has always settled
          // with `undefined`. Returning a synthetic PublishResult here would CHANGE what
          // recordPublishResult receives on that path, so the historical value is kept.
          return undefined as unknown as PublishResult;
        },
        finalizeRecovered: options.finalizeRecovered ?? (async () => {}),
      },
    });
    await harnessStageShareSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.processNext('wallet-1');
    await waitForCondition(() => hinted, 'the executor never fired the hint');
    return { publisher, jobId, releaseTail };
  }

  /**
   * r15 (3878098531) — the two-wallet variant: two jobs on two wallets, both detached, with
   * per-row control over which executions fire hints (parked) versus fail immediately
   * (ordinary live broadcasts owned by the normal walk). Rows keep only their distinguishing
   * resolvers, budgets, and injected store behavior.
   */
  async function parkedTwoWalletScenario(options: {
    hinted?: 'both' | 'first';
    config?: Partial<AsyncLiftPublisherConfig>;
  } = {}) {
    let executions = 0;
    let hintedCount = 0;
    const tails: Array<() => void> = [];
    const publisher = harnessCreatePublisher({
      detachReceiptReconciliation: true,
      chainProofResolver: async () => recoveredResolution(),
      knowledgeAssetVmPublishRecoveryResolver: async () => kaVmRecoveryEvidence(),
      ...options.config,
      knowledgeAssetVmPublishHandler: {
        execute: async (input): Promise<PublishResult> => {
          executions += 1;
          // Captured at entry: the shared counter moves while this execution sleeps.
          const myExecution = executions;
          await input.publishOptions.onBeforeBroadcast?.({
            txHash: KA_VM_EXECUTOR_TX_HASH,
            operationKind: 'create',
          });
          input.publishOptions.onBroadcastAccepted?.({
            txHash: KA_VM_EXECUTOR_TX_HASH,
            operationKind: 'create',
          });
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (options.hinted !== 'first' || myExecution === 1) {
            input.publishOptions.onPublishConfirmed?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
            hintedCount += 1;
            await new Promise<void>((resolve) => { tails.push(resolve); });
          }
          throw new Error('post-write-ahead failure: recovery owns the record from here');
        },
        finalizeRecovered: async () => {},
      },
    });
    await harnessStageShareSnapshot();
    await stageKnowledgeAssetShareSnapshot({ store, graphManager, shareOperationId: 'share-op-2' });
    const jobA = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const jobB = await publisher.enqueueKnowledgeAssetVmPublish(
      kaVmPublishRequest({ name: 'albums-next', shareOperationId: 'share-op-2' }),
    );
    await publisher.processNext('wallet-1');
    await publisher.processNext('wallet-2');
    const expectedHints = options.hinted === 'first' ? 1 : 2;
    await waitForCondition(() => hintedCount === expectedHints, 'executors must fire their hints');
    await waitForCondition(() => executions === 2, 'both executors must run');
    return {
      publisher,
      jobA,
      jobB,
      releaseTails: () => { for (const release of tails) release(); },
    };
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


  return {
    store,
    graphManager,
    createPublisher: harnessCreatePublisher,
    stageShareSnapshot: harnessStageShareSnapshot,
    parkedHintScenario,
    parkedTwoWalletScenario,
    waitForCondition,
    expectWalletLock,
    waitForStatus,
  };
}
