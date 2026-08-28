import { beforeEach, describe, expect, it } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
} from '../src/index.js';
import {
  KA_VM_EXECUTOR_TX_HASH,
  KA_VM_VALIDATION,
  kaVmPublishRequest,
  stageKnowledgeAssetShareSnapshot,
} from './_helpers/ka-vm-publish.js';
import {
  DEFAULT_WALLET_LOCK_GRAPH_URI,
  walletLockSubject,
} from '../src/async-lift-control-plane.js';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('async-lift claim fencing', () => {
  let now: number;
  let ids: number;
  let claimTokens: number;
  let store: OxigraphStore;

  beforeEach(() => {
    now = 1_000;
    ids = 0;
    claimTokens = 0;
    store = new OxigraphStore();
  });

  function createPublisher(config: AsyncLiftPublisherConfig = {}): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => now,
      idGenerator: () => `job-${++ids}`,
      claimTokenGenerator: () => `claim-${++claimTokens}`,
      ...config,
    });
  }

  async function stageSnapshot(): Promise<void> {
    await stageKnowledgeAssetShareSnapshot({
      store,
      graphManager: new GraphManager(store),
    });
  }

  function gateNextSweepInventory(): {
    captured: Promise<void>;
    release(): void;
  } {
    const captured = deferred();
    const release = deferred();
    const originalQuery = store.query.bind(store);
    let gated = false;
    store.query = async (...args) => {
      const result = await originalQuery(...args);
      if (!gated && args[1]?.source === 'publisher.asyncLift.walletLock.sweep') {
        gated = true;
        captured.resolve();
        await release.promise;
      }
      return result;
    };
    return { captured: captured.promise, release: release.resolve };
  }

  it('does not recover a live pre-broadcast claim owned by another publisher instance', async () => {
    const executor = createPublisher();
    const recovery = createPublisher();
    await stageSnapshot();

    const jobId = await executor.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const claimed = await executor.claimNext('wallet-a');
    expect(claimed?.status).toBe('claimed');

    // The recovery/control instance has no in-memory activeProcessJobIds entry for the executor.
    // The durable, unexpired claim lock is therefore the cross-instance ownership authority.
    expect(await recovery.recover()).toBe(0);
    expect(await recovery.getStatus(jobId)).toMatchObject({
      status: 'claimed',
      claim: {
        walletId: 'wallet-a',
        claimToken: claimed?.claim?.claimToken,
      },
    });
  });

  it('does not let an expired worker fail a job reclaimed by the same wallet', async () => {
    const preflightEntered = deferred();
    const releasePreflight = deferred();
    const staleExecutor = createPublisher({
      knowledgeAssetVmPublishHandler: {
        preflight: async () => {
          preflightEntered.resolve();
          await releasePreflight.promise;
          throw new Error('stale canonicalization failure');
        },
        execute: async () => {
          throw new Error('execute must not run after stale preflight');
        },
        finalizeRecovered: async () => {},
      },
    });
    const recovery = createPublisher();
    await stageSnapshot();

    const jobId = await staleExecutor.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const staleRun = staleExecutor.processNext('wallet-a');
    await preflightEntered.promise;
    const staleClaimToken = (await recovery.getStatus(jobId))?.claim?.claimToken;

    now += 5 * 60_000 + 1;
    expect(await recovery.recover()).toBe(1);
    const replacement = await recovery.claimNext('wallet-a');
    expect(replacement).toMatchObject({ status: 'claimed', claim: { walletId: 'wallet-a' } });
    expect(replacement?.claim?.claimToken).not.toBe(staleClaimToken);

    releasePreflight.resolve();
    await expect(staleRun).resolves.toMatchObject({
      jobId,
      status: 'claimed',
      claim: { walletId: 'wallet-a', claimToken: replacement?.claim?.claimToken },
    });
    expect(await recovery.getStatus(jobId)).toMatchObject({
      status: 'claimed',
      claim: { walletId: 'wallet-a', claimToken: replacement?.claim?.claimToken },
    });
  });

  it('recovers an expired unchanged worker claim without requiring an independent recovery pass', async () => {
    const preflightEntered = deferred();
    const releasePreflight = deferred();
    const executor = createPublisher({
      knowledgeAssetVmPublishHandler: {
        preflight: async () => {
          preflightEntered.resolve();
          await releasePreflight.promise;
        },
        execute: async () => {
          throw new Error('execute must not run after the claim expires');
        },
        finalizeRecovered: async () => {},
      },
    });
    await stageSnapshot();

    const jobId = await executor.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const run = executor.processNext('wallet-a');
    await preflightEntered.promise;
    const originalToken = (await executor.getStatus(jobId))?.claim?.claimToken;

    now += 5 * 60_000 + 1;
    releasePreflight.resolve();

    await expect(run).resolves.toMatchObject({ jobId, status: 'accepted' });
    expect(await executor.getStatus(jobId)).toMatchObject({ jobId, status: 'accepted' });
    const replacement = await executor.claimNext('wallet-b');
    expect(replacement).toMatchObject({ jobId, status: 'claimed', claim: { walletId: 'wallet-b' } });
    expect(replacement?.claim.claimToken).not.toBe(originalToken);
  });

  it('does not let an expired worker write or send after another wallet reclaims the job', async () => {
    const executeEntered = deferred();
    const releaseExecute = deferred();
    let sends = 0;
    const staleExecutor = createPublisher({
      knowledgeAssetVmPublishHandler: {
        preflight: async () => {},
        execute: async (input) => {
          // Reach the real send boundary while this worker still owns the validated claim.
          executeEntered.resolve();
          await releaseExecute.promise;
          await input.publishOptions.onBeforeBroadcast?.({
            txHash: KA_VM_EXECUTOR_TX_HASH,
            nonce: 7,
            operationKind: 'create',
          });
          sends += 1;
          throw Object.assign(new Error('insufficient funds'), { code: 'INSUFFICIENT_FUNDS' });
        },
        finalizeRecovered: async () => {},
      },
    });
    const recovery = createPublisher();
    await stageSnapshot();

    const jobId = await staleExecutor.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const staleRun = staleExecutor.processNext('wallet-a');
    await executeEntered.promise;
    expect(await recovery.getStatus(jobId)).toMatchObject({ status: 'validated' });

    now += 5 * 60_000 + 1;
    expect(await recovery.recover()).toBe(1);
    const replacement = await recovery.claimNext('wallet-b');
    expect(replacement).toMatchObject({ status: 'claimed', claim: { walletId: 'wallet-b' } });

    releaseExecute.resolve();
    await expect(staleRun).resolves.toMatchObject({
      jobId,
      status: 'claimed',
      claim: { walletId: 'wallet-b', claimToken: replacement?.claim?.claimToken },
    });
    expect(sends).toBe(0);
    expect(await recovery.getStatus(jobId)).toMatchObject({
      status: 'claimed',
      claim: { walletId: 'wallet-b', claimToken: replacement?.claim?.claimToken },
    });
  });

  it('does not hold the global claim lock while wallet sweep inventory is paused', async () => {
    const executor = createPublisher();
    const recovery = createPublisher();
    await stageSnapshot();

    const expiredJobId = await executor.enqueueKnowledgeAssetVmPublish(
      kaVmPublishRequest({ name: 'expired-albums', intentKey: `sha256:${'01'.repeat(32)}` }),
    );
    await executor.claimNext('wallet-a');
    const unrelatedJobId = await executor.enqueueKnowledgeAssetVmPublish(
      kaVmPublishRequest({ name: 'unrelated-albums', intentKey: `sha256:${'02'.repeat(32)}` }),
    );
    now += 5 * 60_000 + 1;

    const sweep = gateNextSweepInventory();
    const recoveryRun = recovery.recover();
    await sweep.captured;

    // Inventory I/O is outside the global claim mutex, so this unrelated wallet can claim now.
    const unrelatedClaim = await executor.claimNext('wallet-b');
    expect(unrelatedClaim).toMatchObject({
      jobId: unrelatedJobId,
      status: 'claimed',
      claim: { walletId: 'wallet-b' },
    });

    sweep.release();
    await expect(recoveryRun).resolves.toBe(1);
    expect(await recovery.getStatus(expiredJobId)).toMatchObject({ status: 'accepted' });
    expect(await recovery.getStatus(unrelatedJobId)).toMatchObject({
      status: 'claimed',
      claim: { walletId: 'wallet-b', claimToken: unrelatedClaim?.claim.claimToken },
    });
  });

  it('preserves a wallet lock refreshed after stale sweep inventory was captured', async () => {
    const executor = createPublisher();
    const recovery = createPublisher();
    await stageSnapshot();

    const jobId = await executor.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const claimed = await executor.claimNext('wallet-a');
    expect(claimed).not.toBeNull();

    // Start a worker transition just before expiry. Gate its wallet-lock replace after the job
    // record already carries the renewed lease, leaving the old expiry visible to sweep inventory.
    now += 5 * 60_000 - 1;
    const walletWriteEntered = deferred();
    const releaseWalletWrite = deferred();
    const originalReplaceSubject = store.replaceSubject.bind(store);
    let gateWalletWrite = true;
    store.replaceSubject = async (...args) => {
      if (
        gateWalletWrite
        && args[0] === DEFAULT_WALLET_LOCK_GRAPH_URI
        && args[1] === walletLockSubject('wallet-a')
      ) {
        gateWalletWrite = false;
        walletWriteEntered.resolve();
        await releaseWalletWrite.promise;
      }
      await originalReplaceSubject(...args);
    };

    const renewal = executor.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await walletWriteEntered.promise;
    now += 2;

    const sweep = gateNextSweepInventory();
    const recoveryRun = recovery.recover();
    await sweep.captured;

    releaseWalletWrite.resolve();
    await renewal;
    sweep.release();

    await expect(recoveryRun).resolves.toBe(0);
    expect(await recovery.getStatus(jobId)).toMatchObject({
      status: 'validated',
      claim: { walletId: 'wallet-a', claimToken: claimed?.claim.claimToken },
    });
    const lockRows = await store.query(`SELECT ?job WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject('wallet-a')}> ?predicate ?job .
      }
    }`);
    expect(lockRows.type).toBe('bindings');
    if (lockRows.type === 'bindings') expect(lockRows.bindings.length).toBeGreaterThan(0);
  });
});
