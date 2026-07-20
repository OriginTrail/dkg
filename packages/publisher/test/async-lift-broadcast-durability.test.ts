import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
} from '../src/index.js';

// Regression: the mutable 'broadcast' record must be fsync-durable BEFORE the
// on-chain send. It is written inside the write-ahead hook (onBroadcast, awaited
// strictly before the tx sends). Without a flush there, a daemon crash in the
// flush->send window loses the record; on restart the job reads back as
// 'validated', recover() resets it, and it re-broadcasts with a fresh hash — a
// double on-chain submission. writeJob must flush on the execute-capable
// 'broadcast' transition, and only there (to avoid a whole-store snapshot on
// every state change).
describe('async lift publisher broadcast durability', () => {
  let now = 1_000;
  let ids = 0;
  let store: OxigraphStore;

  beforeEach(() => {
    now = 1_000;
    ids = 0;
    store = new OxigraphStore();
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

  function kaVmPublishRequest() {
    const authorAddress = '0x1111111111111111111111111111111111111111';
    const kaNumber = 7n;
    const kaUal = `did:dkg:31337/${authorAddress}/${kaNumber.toString()}`;
    return {
      contextGraphId: 'music-social',
      name: 'albums',
      shareOperationId: 'share-op-1',
      roots: [] as string[],
      contentScopeVersion: 2 as const,
      kaUal,
      assertionVersion: '1',
      publicTripleCount: 2,
      privateTripleCount: 0,
      seal: {
        merkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
        authorAddress: authorAddress as `0x${string}`,
        signature: { r: (`0x${'34'.repeat(32)}`) as `0x${string}`, vs: (`0x${'56'.repeat(32)}`) as `0x${string}` },
        schemeVersion: 1,
        reservedKaId: ((BigInt(authorAddress) << 96n) | kaNumber).toString() as `${bigint}`,
      },
      sealChainId: '31337' as `${bigint}`,
      sealKav10Address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
      sealMerkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
      intentKey: `sha256:${'ab'.repeat(32)}`,
      wmCurrentAssertion: '12'.repeat(32),
      swmCurrentAssertion: '12'.repeat(32),
      kaNumber: kaNumber.toString(),
      reservedUal: kaUal,
    };
  }

  it('fsyncs the store on the broadcast transition, and not on earlier transitions', async () => {
    const publisher = createPublisher();

    let flushCount = 0;
    const orig = store.flush?.bind(store);
    (store as unknown as { flush?: () => Promise<void> }).flush = async () => {
      flushCount += 1;
      await orig?.();
    };

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: [],
        canonicalRootMap: {},
        swmQuadCount: 2,
        authorityProofRef: 'knowledge-asset-lifecycle',
        transitionType: 'CREATE',
      },
    });
    // accepted / claimed / validated are not execute-capable — no fsync.
    expect(flushCount).toBe(0);

    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: `0x${'cd'.repeat(32)}` as `0x${string}`, walletId: 'wallet-1' },
    });
    // broadcast is written inside the pre-send write-ahead hook — must fsync.
    expect(flushCount).toBe(1);

    // The record is durably readable as 'broadcast' (a restart would not reset it).
    const persisted = await publisher.getStatus(jobId);
    expect(persisted?.status).toBe('broadcast');
    expect(persisted?.broadcast?.txHash).toBe(`0x${'cd'.repeat(32)}`);
  });
});
