import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/async-lift-publisher-impl.js';
import type { AsyncKnowledgeAssetVmPublishExecutionResult } from '../src/index.js';
import {
  KA_VM_AUTHOR_ADDRESS, KA_VM_EXECUTOR_TX_HASH, KA_VM_KA_UAL,
  kaVmPublishRequest, kaVmRecoveryEvidence, recoveredResolution, stageKnowledgeAssetShareSnapshot,
} from '../../../scripts/testing/ka-vm-publish.js';

const directories: string[] = [], stores: OxigraphStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function result(complete: boolean): AsyncKnowledgeAssetVmPublishExecutionResult {
  return {
    status: 'confirmed', ...(complete ? { localFinalizationComplete: true as const } : {}),
    kaId: 7n, ual: KA_VM_KA_UAL, merkleRoot: new Uint8Array(32).fill(0x12), kaManifest: [],
    onChainResult: { txHash: KA_VM_EXECUTOR_TX_HASH, blockNumber: 1, blockTimestamp: 1,
      batchId: 7n, startKAId: 7n, endKAId: 7n, publisherAddress: KA_VM_AUTHOR_ADDRESS },
  };
}

describe('inline named-KA completion certificate', () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])('retains incomplete work across restart without another send (certified=%s, writeAhead=%s)', async (certified, writeAhead) => {
    const directory = await mkdtemp(join(tmpdir(), 'inline-finalization-')); directories.push(directory);
    const path = join(directory, 'store.nq');
    const store = new OxigraphStore(path); stores.push(store);
    const execute = vi.fn(async ({ publishOptions }) => {
      if (writeAhead) await publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH, operationKind: 'create' });
      if (writeAhead) await publishOptions.onBroadcastAccepted?.({ txHash: KA_VM_EXECUTOR_TX_HASH, operationKind: 'create' });
      return result(certified);
    });
    const repair = vi.fn(async () => {});
    const options = {
      detachReceiptReconciliation: false,
      chainProofResolver: async () => recoveredResolution(),
      knowledgeAssetVmPublishRecoveryResolver: async () => kaVmRecoveryEvidence(),
      knowledgeAssetVmPublishHandler: { execute, finalizeRecovered: repair },
    };
    const publisher = new TripleStoreAsyncLiftPublisher(store, options);
    await stageKnowledgeAssetShareSnapshot({ store });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.processNext('wallet-1');
    expect((await publisher.getStatus(jobId))?.status).toBe(certified ? 'finalized' : writeAhead ? 'broadcast' : 'included');
    await store.close();
    const reopened = new OxigraphStore(path); stores.push(reopened);
    const recovery = new TripleStoreAsyncLiftPublisher(reopened, options);
    await recovery.reconcileTransactions();
    expect((await recovery.getStatus(jobId))?.status).toBe('finalized');
    expect(repair).toHaveBeenCalledTimes(certified ? 0 : 1);
    expect(execute).toHaveBeenCalledOnce();
  });
});
