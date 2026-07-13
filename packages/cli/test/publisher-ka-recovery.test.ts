import { describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { DKGPublisher, LiftJobBroadcast } from '@origintrail-official/dkg-publisher';
import { createKnowledgeAssetVmPublishRecoveryFinalizer } from '../src/daemon/lifecycle.js';
import { createChainRecoveryResolver } from '../src/publisher-runner.js';

describe('named KA publisher recovery wiring', () => {
  it('reconstructs the canonical V10 UAL from a confirmed transaction receipt', async () => {
    const txHash = `0x${'ab'.repeat(32)}` as `0x${string}`;
    const kaId = 123456789n;
    const walletId = '0x1111111111111111111111111111111111111111';
    const resolvePublishByTxHash = vi.fn(async () => ({
      batchId: kaId,
      kaId,
      knowledgeAssetsContract: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
      startKAId: kaId,
      endKAId: kaId,
      txHash,
      blockNumber: 77,
      blockTimestamp: 1_700_000_077,
      publisherAddress: walletId,
    }));
    const publisher = {
      chain: {
        chainId: 'evm:31337',
        resolvePublishByTxHash,
      },
    } as unknown as DKGPublisher;
    const resolver = createChainRecoveryResolver(new Map([[walletId, publisher]]));

    const resolved = await resolver({
      status: 'broadcast',
      broadcast: { txHash, walletId },
    } as LiftJobBroadcast);

    expect(resolvePublishByTxHash).toHaveBeenCalledWith(txHash);
    expect(resolved).toEqual({
      inclusion: {
        txHash,
        blockNumber: 77,
        blockTimestamp: 1_700_000_077,
      },
      finalization: {
        mode: 'published',
        txHash,
        ual: `did:dkg:evm:31337/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd/${kaId}`,
        batchId: kaId.toString(),
        startKAId: kaId.toString(),
        endKAId: kaId.toString(),
        publisherAddress: walletId,
      },
    });
  });

  it('forwards the immutable job and wallet-scoped publisher to the agent repair method', async () => {
    const finalizeRecoveredQueuedKnowledgeAssetVmPublish = vi.fn(async () => undefined);
    const finalizer = createKnowledgeAssetVmPublishRecoveryFinalizer({
      finalizeRecoveredQueuedKnowledgeAssetVmPublish,
    } as unknown as DKGAgent);
    const input = {
      walletId: 'wallet-1',
      request: { name: 'albums' },
      job: { jobId: 'job-1', status: 'broadcast' },
      recovery: { inclusion: { txHash: '0x1' }, finalization: { ual: 'did:dkg:test' } },
      publisher: { marker: 'wallet-scoped' },
    } as any;

    await finalizer(input);

    expect(finalizeRecoveredQueuedKnowledgeAssetVmPublish).toHaveBeenCalledOnce();
    expect(finalizeRecoveredQueuedKnowledgeAssetVmPublish).toHaveBeenCalledWith(input);
  });
});
