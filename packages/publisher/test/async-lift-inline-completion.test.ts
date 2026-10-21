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
  it.each([false, true])('persists a malformed legacy receipt before mapping, surviving lease expiry and disk reopen (certified=%s)', async certified => {
    const directory = await mkdtemp(join(tmpdir(), 'invalid-inline-receipt-')); directories.push(directory);
    const path = join(directory, 'store.nq');
    const store = new OxigraphStore(path); stores.push(store);
    let now = 1_000;
    const malformed = result(certified);
    delete (malformed.onChainResult as Partial<NonNullable<typeof malformed.onChainResult>>).batchId;
    const execute = vi.fn(async () => malformed);
    const repair = vi.fn(async () => {});
    const options = { now: () => now, detachReceiptReconciliation: false,
      chainProofResolver: async () => recoveredResolution(),
      knowledgeAssetVmPublishRecoveryResolver: async () => kaVmRecoveryEvidence(),
      knowledgeAssetVmPublishHandler: { execute, finalizeRecovered: repair } };
    const publisher = new TripleStoreAsyncLiftPublisher(store, options);
    await stageKnowledgeAssetShareSnapshot({ store });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');
    expect(processed?.status).toBe('broadcast');
    expect(processed?.broadcast?.txHash).toBe(KA_VM_EXECUTOR_TX_HASH);
    now = processed!.claim!.claimLeaseExpiresAt + 1;
    // Reopen without closing/flushing the original store: the post-send checkpoint
    // itself must already be on disk before a mapping error is swallowed.
    const reopened = new OxigraphStore(path); stores.push(reopened);
    const recovery = new TripleStoreAsyncLiftPublisher(reopened, options);
    expect((await recovery.getStatus(jobId))?.broadcast?.txHash).toBe(KA_VM_EXECUTOR_TX_HASH);
    await recovery.recover();
    await recovery.reconcileTransactions();
    expect(await recovery.processNext('wallet-1')).toBeNull();
    const recovered = await recovery.getStatus(jobId);
    expect(recovered?.status).toBe('finalized');
    expect(recovered?.broadcast?.txHash).toBe(KA_VM_EXECUTOR_TX_HASH);
    expect(execute).toHaveBeenCalledOnce();
    expect(repair).toHaveBeenCalledOnce();
  });
  it('propagates a post-send checkpoint failure without rolling the transaction back to validated', async () => {
    const store = new OxigraphStore(); stores.push(store);
    const execute = vi.fn(async () => result(true));
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      detachReceiptReconciliation: false,
      chainProofResolver: async () => recoveredResolution(),
      knowledgeAssetVmPublishRecoveryResolver: async () => kaVmRecoveryEvidence(),
      knowledgeAssetVmPublishHandler: { execute, finalizeRecovered: async () => {} },
    });
    await stageKnowledgeAssetShareSnapshot({ store });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const failure = new Error('post-send flush failed');
    const flush = vi.spyOn(store, 'flush').mockRejectedValueOnce(failure);
    await expect(publisher.processNext('wallet-1')).rejects.toBe(failure);
    expect(await publisher.getStatus(jobId)).toMatchObject({ status: 'broadcast', broadcast: { txHash: KA_VM_EXECUTOR_TX_HASH } });
    flush.mockRestore();
    await publisher.reconcileTransactions();
    expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
    expect(await publisher.processNext('wallet-1')).toBeNull();
    expect(execute).toHaveBeenCalledOnce();
  });
  it.each(['no-chain', 'private-no-acks', 'receipt'] as const)('preserves tentative %s transitions', async mode => {
    const store = new OxigraphStore(); stores.push(store);
    const confirmed = result(false);
    const execute = vi.fn(async () => ({ ...confirmed, status: 'tentative' as const,
      onChainResult: mode === 'receipt' ? confirmed.onChainResult : undefined,
      ...(mode !== 'receipt' ? { localChainSkipReason: mode } : {}),
    }));
    const publisher = new TripleStoreAsyncLiftPublisher(store, { knowledgeAssetVmPublishHandler: { execute } });
    await stageKnowledgeAssetShareSnapshot({ store });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const job = await publisher.processNext('wallet-1');
    expect(job?.status).toBe(mode === 'receipt' ? 'included' : mode === 'no-chain' ? 'finalized' : 'failed');
    if (mode === 'receipt') {
      expect(job?.broadcast?.txHash).toBe(KA_VM_EXECUTOR_TX_HASH);
      expect(job?.finalization).toBeUndefined();
    }
    if (mode === 'no-chain') expect(job?.finalization?.mode).toBe('local');
    await publisher.recover();
    expect(await publisher.processNext('wallet-1')).toBeNull();
    expect((await publisher.getStatus(jobId))?.status).toBe(job?.status);
    expect(execute).toHaveBeenCalledOnce();
  });

});
