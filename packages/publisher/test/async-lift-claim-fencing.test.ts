import { beforeEach, describe, expect, it } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
} from '../src/index.js';
import {
  KA_VM_EXECUTOR_TX_HASH,
  kaVmPublishRequest,
  stageKnowledgeAssetShareSnapshot,
} from './_helpers/ka-vm-publish.js';

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

  it('does not let an expired worker write or send after another wallet reclaims the job', async () => {
    const preflightEntered = deferred();
    const releasePreflight = deferred();
    let preflightCalls = 0;
    let sends = 0;
    const staleExecutor = createPublisher({
      knowledgeAssetVmPublishHandler: {
        preflight: async () => {
          preflightCalls += 1;
          if (preflightCalls === 1) {
            preflightEntered.resolve();
            await releasePreflight.promise;
          }
        },
        execute: async (input) => {
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
    await preflightEntered.promise;

    now += 5 * 60_000 + 1;
    expect(await recovery.recover()).toBe(1);
    const replacement = await recovery.claimNext('wallet-b');
    expect(replacement).toMatchObject({ status: 'claimed', claim: { walletId: 'wallet-b' } });

    releasePreflight.resolve();
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
});
