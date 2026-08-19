import { describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import {
  TripleStoreAsyncLiftPublisher,
  type DKGPublisher,
  type LiftJobBroadcast,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { createKnowledgeAssetVmPublishHandler } from '../src/daemon/lifecycle.js';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { createChainProofResolver, type PublisherChainAdapters } from '../src/publisher-chain-proof.js';
import {
  createKnowledgeAssetVmPublishRecoveryResolver,
  scopeKnowledgeAssetVmPublishHandler,
} from '../src/publisher-runner.js';

describe('named KA publisher recovery wiring', () => {
  it('preserves the queued graph UAL while generic recovery retains the public token UAL', async () => {
    const txHash = `0x${'ab'.repeat(32)}` as `0x${string}`;
    const blockHash = `0x${'bc'.repeat(32)}` as `0x${string}`;
    const walletId = '0x1111111111111111111111111111111111111111';
    const kaNumber = 7n;
    const kaId = (BigInt(walletId) << 96n) | kaNumber;
    const graphUal = `did:dkg:evm:31337/${walletId}/${kaNumber}`;
    const merkleRoot = `0x${'12'.repeat(32)}` as `0x${string}`;
    const resolvePublishByTxHash = vi.fn(async () => ({
      batchId: kaId,
      kaId,
      knowledgeAssetsContract: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
      merkleRoot: Buffer.from(merkleRoot.slice(2), 'hex'),
      authorAddress: walletId,
      startKAId: kaId,
      endKAId: kaId,
      txHash,
      blockNumber: 77,
      txIndex: 4,
      blockTimestamp: 1_700_000_077,
      publisherAddress: walletId,
    }));
    const resolveCanonicalFinalizationReceipt = vi.fn(async () => ({
      status: 'confirmed' as const,
      receipt: {
        txHash,
        blockNumber: 77,
        blockHash,
        txIndex: 4,
        merkleRoot: Buffer.from(merkleRoot.slice(2), 'hex'),
        publisherAddress: walletId,
        authorAddress: walletId,
        batchId: kaId,
        kaId,
        startKAId: kaId,
        endKAId: kaId,
        knowledgeAssetsContract: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
      },
    }));
    // GH#2270 PR-3 r2 — the factories take a wallet→ADAPTER map, so tests supply one directly
    // instead of a publisher whose private `chain` field had to be asserted through.
    const publishers: PublisherChainAdapters = new Map([[walletId, {
      chainId: 'evm:31337',
      resolvePublishByTxHash,
      resolveCanonicalFinalizationReceipt,
      // r14 — the create branch gates on finality like every other mined verdict.
      isReceiptBlockFinalAndCanonical: vi.fn(async () => true),
    } as unknown as ChainAdapter]]);
    const resolver = createKnowledgeAssetVmPublishRecoveryResolver(publishers);

    const job = {
      status: 'broadcast',
      request: {
        jobType: 'knowledge-asset-vm-publish',
        knowledgeAssetVmPublish: {
          contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
          kaUal: graphUal,
        },
      },
      broadcast: { txHash, walletId },
    } as LiftJobBroadcast;
    const resolved = await resolver(job, { txHash, walletId });

    expect(resolveCanonicalFinalizationReceipt).toHaveBeenCalledWith(txHash);
    expect(resolved).toEqual({
      inclusion: {
        txHash,
        blockNumber: 77,
        blockHash,
      },
      finalization: {
        mode: 'published',
        txHash,
        ual: graphUal,
        batchId: kaId.toString(),
        startKAId: kaId.toString(),
        endKAId: kaId.toString(),
        publisherAddress: walletId,
      },
      publishProof: { merkleRoot, authorAddress: walletId, txIndex: 4 },
    });

    await expect(createChainProofResolver(publishers)({ txHash, walletId })).resolves.toMatchObject({
      status: 'recovered',
      recovery: {
        finalization: {
          ual: `did:dkg:evm:31337/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd/${kaId}`,
        },
      },
    });
    expect(resolvePublishByTxHash).toHaveBeenCalledWith(txHash);
  });

  it('resolves a queued UPDATE through verifyKAUpdate, bound to the intended root [GH#2270 r4]', async () => {
    const txHash = `0x${'ee'.repeat(32)}` as `0x${string}`;
    const blockHash = `0x${'bd'.repeat(32)}` as `0x${string}`;
    const walletId = '0x1111111111111111111111111111111111111111';
    const author = '0x3333333333333333333333333333333333333333';
    const kaNumber = 7n;
    const kaId = (BigInt(author) << 96n) | kaNumber;
    const graphUal = `did:dkg:evm:31337/${author}/${kaNumber}`;
    const intendedRoot = `0x${'12'.repeat(32)}` as `0x${string}`;
    const verifyKAUpdate = vi.fn(async () => ({
      verified: true,
      onChainMerkleRoot: Buffer.from('12'.repeat(32), 'hex'),
      blockNumber: 91,
      blockHash,
      txIndex: 3,
    }));
    // No publish-receipt surfaces at all: an update must not need them, and reaching for them
    // would prove the lane fell through to the create path. This drives the resolver with NO
    // verdict recovery — the LIVE-lane path — so it verifies once itself, behind the finality
    // gate (PR #2300 r2).
    const publishers: PublisherChainAdapters = new Map([[walletId, {
      chainId: 'evm:31337',
      verifyKAUpdate,
      isReceiptBlockFinalAndCanonical: vi.fn(async () => true),
    } as unknown as ChainAdapter]]);
    const resolver = createKnowledgeAssetVmPublishRecoveryResolver(publishers);

    const job = {
      status: 'failed',
      request: {
        jobType: 'knowledge-asset-vm-publish',
        knowledgeAssetVmPublish: {
          contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
          kaUal: graphUal,
          seal: { authorAddress: author },
        },
      },
      broadcast: { txHash, walletId },
    } as unknown as LiftJobBroadcast;
    const lookup = {
      txHash,
      walletId,
      publishIdentityKaId: kaId.toString(),
      operationKind: 'update' as const,
      intendedUpdateRoot: intendedRoot,
    };

    expect(await resolver(job, lookup)).toEqual({
      inclusion: { txHash, blockNumber: 91, blockHash },
      finalization: {
        mode: 'published',
        txHash,
        ual: graphUal,
        batchId: kaId.toString(),
        startKAId: kaId.toString(),
        endKAId: kaId.toString(),
        publisherAddress: walletId,
      },
      publishProof: { merkleRoot: intendedRoot, authorAddress: author, txIndex: 3 },
    });
    expect(verifyKAUpdate).toHaveBeenCalledWith(txHash, kaId, walletId);

    // A verified update for the WRONG root is someone else's update: null, and the job stays
    // held. (PR #2300 r1 — each negative sub-case asks about a DISTINCT transaction: the shared
    // verifier memoizes a POSITIVE verification per (txHash, kaId, intendedRoot) — that is the
    // once-only property — so a re-ask about the already-proven transaction above would be
    // served from the cache by design.)
    const wrongRootTx = `0x${'e1'.repeat(32)}` as `0x${string}`;
    verifyKAUpdate.mockResolvedValueOnce({
      verified: true,
      onChainMerkleRoot: Buffer.from('ff'.repeat(32), 'hex'),
      blockNumber: 91,
      blockHash,
      txIndex: 3,
    });
    await expect(resolver(job, { ...lookup, txHash: wrongRootTx })).resolves.toBeNull();

    // No canonical block hash → no durable evidence → null (fail-closed, not fabricated).
    const hashlessTx = `0x${'e2'.repeat(32)}` as `0x${string}`;
    verifyKAUpdate.mockResolvedValueOnce({
      verified: true,
      onChainMerkleRoot: Buffer.from('12'.repeat(32), 'hex'),
      blockNumber: 91,
      txIndex: 3,
    });
    await expect(resolver(job, { ...lookup, txHash: hashlessTx })).resolves.toBeNull();
  });

  it('falls back to the adapter knowledge-assets address when the receipt omits it', async () => {
    const txHash = `0x${'cd'.repeat(32)}` as `0x${string}`;
    const blockHash = `0x${'bc'.repeat(32)}` as `0x${string}`;
    const walletId = '0x1111111111111111111111111111111111111111';
    const kaId = 42n;
    const merkleRoot = `0x${'12'.repeat(32)}` as `0x${string}`;
    const chain = {
      chainId: 'evm:31337',
      isReceiptBlockFinalAndCanonical: vi.fn(async () => true),
      resolveCanonicalFinalizationReceipt: vi.fn(async () => ({
        status: 'confirmed' as const,
        receipt: {
          txHash,
          blockNumber: 9,
          blockHash,
          txIndex: 2,
          merkleRoot: Buffer.from(merkleRoot.slice(2), 'hex'),
          publisherAddress: walletId,
          authorAddress: walletId,
          batchId: kaId,
          kaId,
          startKAId: kaId,
          endKAId: kaId,
        },
      })),
      resolvePublishByTxHash: vi.fn(async () => ({
        batchId: kaId,
        kaId,
        startKAId: kaId,
        endKAId: kaId,
        merkleRoot: Buffer.from(merkleRoot.slice(2), 'hex'),
        authorAddress: walletId,
        txHash,
        blockNumber: 9,
        txIndex: 2,
        blockTimestamp: 1_700_000_009,
        publisherAddress: walletId,
      })),
      getDKGKnowledgeAssetsAddress: vi.fn(async () => '0x2222222222222222222222222222222222222222'),
    };
    const publisher = chain as unknown as ChainAdapter;

    const resolved = await createKnowledgeAssetVmPublishRecoveryResolver(new Map([[walletId, publisher]]))(
      { status: 'broadcast', broadcast: { txHash, walletId } } as LiftJobBroadcast,
      { txHash, walletId },
    );

    expect(chain.getDKGKnowledgeAssetsAddress).toHaveBeenCalledOnce();
    expect(resolved?.finalization.ual).toBe(
      `did:dkg:evm:31337/0x2222222222222222222222222222222222222222/${kaId}`,
    );
  });

  it('fails closed for named-KA recovery when the receipt lacks a transaction index', async () => {
    const txHash = `0x${'de'.repeat(32)}` as `0x${string}`;
    const walletId = '0x1111111111111111111111111111111111111111';
    const kaId = 42n;
    const publisher = {
      chainId: 'evm:31337',
      resolveCanonicalFinalizationReceipt: vi.fn(async () => ({
        status: 'confirmed' as const,
        receipt: {
          txHash,
          blockNumber: 9,
          blockHash: `0x${'bc'.repeat(32)}`,
          merkleRoot: Buffer.from('12'.repeat(32), 'hex'),
          publisherAddress: walletId,
          authorAddress: walletId,
          batchId: kaId,
          kaId,
          startKAId: kaId,
          endKAId: kaId,
          knowledgeAssetsContract: '0x2222222222222222222222222222222222222222',
        },
      })),
      resolvePublishByTxHash: vi.fn(async () => ({
        batchId: kaId,
        kaId,
        knowledgeAssetsContract: '0x2222222222222222222222222222222222222222',
        startKAId: kaId,
        endKAId: kaId,
        merkleRoot: Buffer.from('12'.repeat(32), 'hex'),
        authorAddress: walletId,
        txHash,
        blockNumber: 9,
        blockTimestamp: 1_700_000_009,
        publisherAddress: walletId,
      })),
    } as unknown as ChainAdapter;
    const publishers: PublisherChainAdapters = new Map([[walletId, publisher]]);
    const job = {
      status: 'broadcast',
      broadcast: { txHash, walletId },
    } as LiftJobBroadcast;

    expect((await createChainProofResolver(publishers)({ txHash, walletId })).status).toBe('recovered');
    await expect(createKnowledgeAssetVmPublishRecoveryResolver(publishers)(job, { txHash, walletId }))
      .resolves.toBeNull();
  });

  it('forwards the immutable job and wallet-scoped publisher to the agent repair method', async () => {
    const finalizeRecoveredQueuedKnowledgeAssetVmPublish = vi.fn(async () => undefined);
    const handler = createKnowledgeAssetVmPublishHandler({
      finalizeRecoveredQueuedKnowledgeAssetVmPublish,
    } as unknown as DKGAgent);
    const input = {
      walletId: 'wallet-1',
      request: { name: 'albums' },
      job: { jobId: 'job-1', status: 'broadcast' },
      recovery: { inclusion: { txHash: '0x1' }, finalization: { ual: 'did:dkg:test' } },
      publisher: { marker: 'wallet-scoped' },
    } as any;

    await handler.finalizeRecovered!(input);

    expect(finalizeRecoveredQueuedKnowledgeAssetVmPublish).toHaveBeenCalledOnce();
    expect(finalizeRecoveredQueuedKnowledgeAssetVmPublish).toHaveBeenCalledWith(input);
  });

  it('selects the claimed wallet publisher for runtime recovery finalization', async () => {
    const walletA = '0x1111111111111111111111111111111111111111';
    const walletB = '0x2222222222222222222222222222222222222222';
    const publisherA = { wallet: 'A' } as unknown as DKGPublisher;
    const publisherB = { wallet: 'B' } as unknown as DKGPublisher;
    const finalizeRecovered = vi.fn(async () => undefined);
    const scoped = scopeKnowledgeAssetVmPublishHandler(
      new Map([[walletA, publisherA], [walletB, publisherB]]),
      {
        execute: async () => { throw new Error('not used'); },
        finalizeRecovered,
      },
    );
    const txHash = `0x${'ef'.repeat(32)}` as `0x${string}`;
    const authorAddress = '0x3333333333333333333333333333333333333333';
    const kaId = (BigInt(authorAddress) << 96n) | 7n;
    const recoveredUal = `did:dkg:evm:31337/${authorAddress.toLowerCase()}/7`;
    const request = {
      contextGraphId: 'music-social',
      name: 'albums',
      shareOperationId: 'share-op-1',
      roots: [],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: recoveredUal,
      assertionVersion: '1',
      publicTripleCount: 1,
      privateTripleCount: 0,
      seal: {
        merkleRoot: `0x${'12'.repeat(32)}`,
        authorAddress,
        signature: { r: `0x${'34'.repeat(32)}`, vs: `0x${'56'.repeat(32)}` },
        schemeVersion: 1,
        reservedKaId: kaId.toString(),
      },
      sealChainId: '31337',
      sealKav10Address: '0x4444444444444444444444444444444444444444',
      sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
      sealMerkleRoot: `0x${'12'.repeat(32)}`,
      intentKey: `sha256:${'ab'.repeat(32)}`,
    } as const;
    const runtimePublisher = new TripleStoreAsyncLiftPublisher(new OxigraphStore(), {
      knowledgeAssetVmPublishHandler: scoped,
      knowledgeAssetVmPublishRecoveryResolver: async () => ({
        inclusion: {
          txHash,
          blockNumber: 9,
          blockHash: `0x${'bc'.repeat(32)}`,
        },
        finalization: {
          mode: 'published',
          txHash,
          ual: recoveredUal,
          batchId: kaId.toString(),
          startKAId: kaId.toString(),
          endKAId: kaId.toString(),
          publisherAddress: walletB,
        },
        publishProof: {
          merkleRoot: request.sealMerkleRoot,
          authorAddress: request.seal.authorAddress,
          txIndex: 4,
        },
      }),
    });
    const jobId = await runtimePublisher.enqueueKnowledgeAssetVmPublish(request as any);
    await runtimePublisher.claimNext(walletB);
    await runtimePublisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: [],
        canonicalRootMap: {},
        swmQuadCount: 1,
        authorityProofRef: 'knowledge-asset-lifecycle',
        transitionType: 'CREATE',
      },
    });
    await runtimePublisher.update(jobId, 'broadcast', {
      broadcast: { txHash, walletId: walletB, merkleRoot: request.sealMerkleRoot },
    });

    expect(await runtimePublisher.recover()).toBe(1);

    expect(finalizeRecovered).toHaveBeenCalledWith(expect.objectContaining({
      walletId: walletB,
      publisher: publisherB,
    }));
  });
  it('does not finalize a live CREATE from an unfinalized receipt [r14]', async () => {
    // 3814018304 — the create branch reads a canonical receipt directly rather than going through
    // the gated verdict, so it needed the finality rule stated on its own path: a confirmed receipt
    // whose block is not yet final (or no longer canonical at its height) must not start
    // finalization, because a reorg can still rewrite it.
    const txHash = `0x${'ab'.repeat(32)}` as const;
    const walletId = `0x${'cd'.repeat(20)}`;
    const isReceiptBlockFinalAndCanonical = vi.fn(async () => false);
    const publishers: PublisherChainAdapters = new Map([[walletId, {
      chainId: 'evm:31337',
      isReceiptBlockFinalAndCanonical,
      resolveCanonicalFinalizationReceipt: vi.fn(async () => ({
        status: 'confirmed' as const,
        receipt: {
          txHash,
          blockNumber: 9,
          blockHash: `0x${'ef'.repeat(32)}`,
          txIndex: 2,
          merkleRoot: Buffer.from('12'.repeat(32), 'hex'),
          publisherAddress: walletId,
          authorAddress: walletId,
          batchId: '7',
          knowledgeAssetsContract: `0x${'11'.repeat(20)}`,
        },
      })),
    } as unknown as ChainAdapter]]);

    const resolved = await createKnowledgeAssetVmPublishRecoveryResolver(publishers)(
      {
        status: 'broadcast',
        request: {
          jobType: 'knowledge-asset-vm-publish',
          knowledgeAssetVmPublish: {
            contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
            kaUal: 'did:dkg:31337/0x1111111111111111111111111111111111111111/7',
          },
        },
        broadcast: { txHash, walletId },
      } as never,
      { txHash, walletId, operationKind: 'create' } as never,
    );

    expect(resolved).toBeNull();
    expect(isReceiptBlockFinalAndCanonical).toHaveBeenCalled();
  });

});
