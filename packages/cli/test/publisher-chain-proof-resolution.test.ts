/**
 * GH#2270 — the runner's chain lookup must be able to say WHICH chain fact it found.
 *
 * This resolver used to answer `AsyncLiftPublisherRecoveryResult | null`, and that `null` covered
 * a reverted tx, a mined non-publish tx, a tx still in the mempool, a tx the node has never heard
 * of, and an RPC that simply failed. The publisher's dispatcher turns on telling the fourth apart
 * from the rest: only there is a resend safe.
 *
 * The verdict VOCABULARY belongs to the publisher (`AsyncLiftChainProofResolution`); what these
 * rows pin is the rule this side owns — that an absence must be ESTABLISHED, so every unknown
 * this module can produce comes out `inconclusive` and never `not-found`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PublishTransactionResolution } from '@origintrail-official/dkg-chain';
import { TripleStoreAsyncLiftPublisher } from '@origintrail-official/dkg-publisher';
import type { DKGPublisher, LiftJobBroadcast, LiftJob } from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  createChainProofResolver,
  hasChainPublishLookup,
} from '../src/publisher-runner.js';

const TX_HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;
const WALLET = '0x1111111111111111111111111111111111111111';
const KA_ID = (BigInt(WALLET) << 96n) | 7n;
const KA_CONTRACT = '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD';

function onChainPublish() {
  return {
    batchId: KA_ID,
    kaId: KA_ID,
    knowledgeAssetsContract: KA_CONTRACT,
    merkleRoot: Buffer.from('12'.repeat(32), 'hex'),
    authorAddress: WALLET,
    startKAId: KA_ID,
    endKAId: KA_ID,
    txHash: TX_HASH,
    blockNumber: 77,
    txIndex: 4,
    blockTimestamp: 1_700_000_077,
    publisherAddress: WALLET,
  };
}

/** A publisher whose adapter exposes exactly the members passed in — nothing else. */
function publishersWith(chain: Record<string, unknown> | undefined): Map<string, DKGPublisher> {
  return new Map([[WALLET, { chain } as unknown as DKGPublisher]]);
}

function triStateAdapter(resolution: PublishTransactionResolution, extra: Record<string, unknown> = {}) {
  return {
    chainId: 'evm:31337',
    resolvePublishTransaction: vi.fn(async () => resolution),
    ...extra,
  };
}

const job = { status: 'broadcast', broadcast: { txHash: TX_HASH, walletId: WALLET } } as LiftJobBroadcast;

describe('GH#2270 runner chain-proof resolution', () => {
  describe('reports the chain fact instead of collapsing it', () => {
    // Each of these produced the SAME `null` before, and `pending` vs `not-found` is the pair
    // the whole distinction exists for: resending on the first is a double publish.
    it.each([
      ['pending' as const],
      ['not-found' as const],
      ['reverted' as const],
      ['unrecognized' as const],
    ])('surfaces %s from the adapter', async (status) => {
      const publishers = publishersWith(triStateAdapter({ status }));

      expect(await createChainProofResolver(publishers)(job)).toEqual({ status });
    });

    it('maps a confirmed publish to the recovery evidence the dispatcher finalizes with', async () => {
      const publishers = publishersWith(
        triStateAdapter({ status: 'confirmed', publish: onChainPublish() as never }),
      );

      const resolution = await createChainProofResolver(publishers)(job);

      expect(resolution.status).toBe('recovered');
      expect(resolution.status === 'recovered' ? resolution.recovery : null).toMatchObject({
        inclusion: { txHash: TX_HASH, blockNumber: 77 },
        finalization: { mode: 'published', txHash: TX_HASH, publisherAddress: WALLET },
      });
    });
  });

  describe('never reports an absence it did not establish', () => {
    // The load-bearing row. A legacy two-state adapter cannot see the mempool, so its `null`
    // is "we do not know", not "it did not happen". Reading it as `not-found` would authorise
    // a resend of a transaction that is about to be mined.
    it('reports inconclusive — NOT not-found — for a legacy adapter that answers null', async () => {
      const resolvePublishByTxHash = vi.fn(async () => null);
      const publishers = publishersWith({ chainId: 'evm:31337', resolvePublishByTxHash });

      const resolution = await createChainProofResolver(publishers)(job);

      expect(resolution).toEqual({ status: 'inconclusive' });
      expect(resolution.status).not.toBe('not-found');
      expect(resolvePublishByTxHash).toHaveBeenCalledWith(TX_HASH);
    });

    it('reports inconclusive when the lookup throws', async () => {
      const publishers = publishersWith({
        chainId: 'evm:31337',
        resolvePublishTransaction: vi.fn(async () => {
          throw new Error('ETIMEDOUT: rpc unreachable');
        }),
      });

      expect(await createChainProofResolver(publishers)(job)).toEqual({ status: 'inconclusive' });
    });

    it('reports inconclusive for an unknown wallet and for an adapter with no publish lookup', async () => {
      const unknownWallet = createChainProofResolver(new Map());
      const noLookup = createChainProofResolver(publishersWith({ chainId: 'evm:31337' }));
      const noAdapter = createChainProofResolver(publishersWith(undefined));

      expect(await unknownWallet(job)).toEqual({ status: 'inconclusive' });
      expect(await noLookup(job)).toEqual({ status: 'inconclusive' });
      expect(await noAdapter(job)).toEqual({ status: 'inconclusive' });
    });

    it('reports inconclusive when a CONFIRMED publish cannot be mapped to evidence', async () => {
      // The chain is not in doubt here — this node just cannot resolve the contract address.
      // That is a gap in what we can use, so it must not be reported as a chain fact, and
      // above all not as absence.
      const publish = { ...onChainPublish(), knowledgeAssetsContract: undefined };
      const publishers = publishersWith(
        triStateAdapter({ status: 'confirmed', publish: publish as never }, {
          getDKGKnowledgeAssetsAddress: vi.fn(async () => {
            throw new Error('hub unreachable');
          }),
        }),
      );

      const resolution = await createChainProofResolver(publishers)(job);

      expect(resolution).toEqual({ status: 'inconclusive' });
      expect(resolution.status).not.toBe('not-found');
    });
  });

  describe('adapter selection', () => {
    it('prefers the tri-state lookup when the adapter offers both', async () => {
      const resolvePublishByTxHash = vi.fn(async () => onChainPublish());
      const publishers = publishersWith(
        triStateAdapter({ status: 'pending' }, { resolvePublishByTxHash }),
      );

      // The legacy surface would have answered with a confirmed publish. The tri-state one
      // says the tx is still in the mempool, and that is the answer that must win.
      expect(await createChainProofResolver(publishers)(job)).toEqual({ status: 'pending' });
      expect(resolvePublishByTxHash).not.toHaveBeenCalled();
    });

    it('still resolves a confirmed publish through a legacy-only adapter', async () => {
      // The legacy fallback must stay a real path, not a permanently-inconclusive stub.
      const publishers = publishersWith({
        chainId: 'evm:31337',
        resolvePublishByTxHash: vi.fn(async () => onChainPublish()),
      });

      expect((await createChainProofResolver(publishers)(job)).status).toBe('recovered');
    });

    it('hasChainPublishLookup accepts either lookup and rejects an adapter with neither', () => {
      const withLegacy = { chain: { resolvePublishByTxHash: () => null } } as unknown as DKGPublisher;
      const withTriState = { chain: { resolvePublishTransaction: () => null } } as unknown as DKGPublisher;
      const withBoth = {
        chain: { resolvePublishByTxHash: () => null, resolvePublishTransaction: () => null },
      } as unknown as DKGPublisher;
      const withNeither = { chain: { chainId: 'evm:31337' } } as unknown as DKGPublisher;

      expect(hasChainPublishLookup(withLegacy)).toBe(true);
      expect(hasChainPublishLookup(withTriState)).toBe(true);
      expect(hasChainPublishLookup(withBoth)).toBe(true);
      expect(hasChainPublishLookup(withNeither)).toBe(false);
      expect(hasChainPublishLookup({} as unknown as DKGPublisher)).toBe(false);
    });
  });

  // The two halves composed. Everything above tests this module in isolation and everything in
  // async-lift-chain-proof-dispatch-2270 tests the publisher's dispatch on a hand-written verdict;
  // neither can catch a rule that is right on one side of the boundary and wrong at the join.
  // These drive a REAL publisher whose resolver is the real `createChainProofResolver`.
  describe('composed with the publisher dispatcher', () => {
    async function heldJobOn(chain: Record<string, unknown>): Promise<{
      publisher: TripleStoreAsyncLiftPublisher;
      jobId: string;
      status: () => Promise<LiftJob | null>;
    }> {
      const store = new OxigraphStore();
      let now = 1_000;
      let ids = 0;
      const publishers = publishersWith(chain);
      const publisher = new TripleStoreAsyncLiftPublisher(store, {
        now: () => ++now,
        idGenerator: () => `job-${++ids}`,
        chainRecoveryResolver: createChainProofResolver(publishers),
        knowledgeAssetVmPublishRecoveryResolver: async () => null,
      });
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish({
        contextGraphId: 'music-social',
        name: 'albums',
        shareOperationId: 'share-op-1',
        roots: [],
        contentScopeVersion: 2,
        kaUal: 'did:dkg:31337/0x1111111111111111111111111111111111111111/7',
        assertionVersion: '1',
        publicTripleCount: 2,
        privateTripleCount: 0,
        seal: {
          merkleRoot: `0x${'12'.repeat(32)}`,
          authorAddress: WALLET as `0x${string}`,
          signature: { r: `0x${'34'.repeat(32)}`, vs: `0x${'56'.repeat(32)}` },
          schemeVersion: 1,
        },
        sealChainId: '31337',
        sealKav10Address: '0x2222222222222222222222222222222222222222',
        sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
        sealMerkleRoot: `0x${'12'.repeat(32)}`,
        intentKey: `sha256:${'ab'.repeat(32)}`,
        kaNumber: '7',
      } as never);
      await publisher.claimNext(WALLET);
      await publisher.update(jobId, 'validated', {
        validation: {
          canonicalRoots: [],
          canonicalRootMap: {},
          swmQuadCount: 2,
          authorityProofRef: 'proof:owner:1',
          transitionType: 'CREATE',
        },
      });
      await publisher.update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId: WALLET } });
      await publisher.recordPublishFailure(jobId, {
        error: new Error('RPC endpoint temporarily unavailable'),
        failedFromState: 'broadcast',
        errorPayloadRef: `urn:dkg:test:error:${jobId}`,
      });
      return { publisher, jobId, status: () => publisher.getStatus(jobId) };
    }

    it('keeps a held job held when a LEGACY adapter cannot see the mempool', async () => {
      // The cross-package falsifier. `resolvePublishByTxHash` answering null is the shape a
      // two-state adapter produces for a transaction it cannot find AND for one sitting in the
      // mempool. If this module let that read as `not-found`, the publisher would take it as
      // proof and put the job back on the queue — a second transaction for a KA that may already
      // be publishing. The rule lives here; the damage would happen there.
      const { publisher, jobId, status } = await heldJobOn({
        chainId: 'evm:31337',
        resolvePublishByTxHash: vi.fn(async () => null),
      });

      expect((await status())?.status).toBe('failed');
      expect(await publisher.recover()).toBe(0);

      const after = await status();
      expect(after?.status).toBe('failed');
      expect(after?.status).not.toBe('accepted');
      expect(after?.jobId).toBe(jobId);
    });

    it('releases a held job when a TRI-STATE adapter establishes the transaction is absent', async () => {
      // The other polarity, so the row above cannot pass by the dispatcher simply never running.
      // Same job, same code path, and the only difference is an adapter that actually asked the
      // node for the transaction.
      const { publisher, status } = await heldJobOn({
        chainId: 'evm:31337',
        resolvePublishTransaction: vi.fn(async () => ({ status: 'not-found' as const })),
      });

      expect((await status())?.status).toBe('failed');
      expect(await publisher.recover()).toBe(1);

      const after = await status();
      expect(after?.status).toBe('accepted');
      expect(after?.recovery?.txHashChecked).toBe(TX_HASH);
    });
  });
});
