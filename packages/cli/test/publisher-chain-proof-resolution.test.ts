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
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import { describe, expect, it, vi } from 'vitest';
import type { ChainAdapter, PublishTransactionResolution } from '@origintrail-official/dkg-chain';
import { TripleStoreAsyncLiftPublisher } from '@origintrail-official/dkg-publisher';
import type { AsyncLiftChainProofLookup, DKGPublisher, LiftJob } from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  createChainProofResolver,
  hasChainPublishLookup,
  type PublisherChainAdapters,
} from '../src/publisher-chain-proof.js';
import { createKnowledgeAssetVmPublishRecoveryResolver } from '../src/publisher-runner.js';

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

/** The wallet→adapter map the factories take, exposing exactly the members passed in. */
function publishersWith(chain: Record<string, unknown> | undefined): PublisherChainAdapters {
  return new Map(chain ? [[WALLET, chain as unknown as ChainAdapter]] : []);
}

function triStateAdapter(resolution: PublishTransactionResolution, extra: Record<string, unknown> = {}) {
  return {
    chainId: 'evm:31337',
    resolvePublishTransaction: vi.fn(async () => resolution),
    ...extra,
  };
}

/**
 * The lookup the publisher derives per held job. `nonce` is what turns an adapter's `not-found`
 * into a PROVEN absence, so a lookup without one can never release a job — most rows here do not
 * carry it, and the two that do say so.
 */
const SIGNED_NONCE = 41;
const lookup: AsyncLiftChainProofLookup = { txHash: TX_HASH, walletId: WALLET };
const lookupWithNonce: AsyncLiftChainProofLookup = { ...lookup, nonce: SIGNED_NONCE };

/**
 * GH#2270 PR-3 r4 — the ONE pinned-snapshot capability the absence decision reads. Rows script
 * the pair (nonce + minted state, one finalized block) rather than two independent reads, because
 * two independent reads are exactly what the capability exists to forbid.
 */
function proofSnapshot(
  snapshot: { accountNonce?: number; kaMinted?: boolean | null } | null,
  extra: Record<string, unknown> = {},
) {
  return {
    readFinalizedChainProofSnapshot: vi.fn(async () =>
      snapshot === null
        ? null
        : {
            blockNumber: 90,
            blockHash: `0x${'cd'.repeat(32)}`,
            accountNonce: SIGNED_NONCE + 1,
            ...snapshot,
          }),
    ...extra,
  };
}

describe('GH#2270 runner chain-proof resolution', () => {
  describe('reports the chain fact instead of collapsing it', () => {
    // Each of these produced the SAME `null` before. They pass through untouched: none of them is
    // an absence claim, so none needs earning.
    it.each([
      ['pending' as const],
      ['reverted' as const],
      ['unrecognized' as const],
    ])('surfaces %s from the adapter', async (status) => {
      const publishers = publishersWith(triStateAdapter({ status }));

      expect(await createChainProofResolver(publishers)(lookup)).toEqual({ status });
    });

    it('maps a confirmed publish to the recovery evidence the dispatcher finalizes with', async () => {
      const publishers = publishersWith(
        triStateAdapter({ status: 'confirmed', publish: onChainPublish() as never }),
      );

      const resolution = await createChainProofResolver(publishers)(lookup);

      expect(resolution.status).toBe('recovered');
      expect(resolution.status === 'recovered' ? resolution.recovery : null).toMatchObject({
        inclusion: { txHash: TX_HASH, blockNumber: 77 },
        finalization: { mode: 'published', txHash: TX_HASH, publisherAddress: WALLET },
      });
    });
  });

  // An adapter `not-found` is a point-in-time answer from ONE backend. The loss case that makes it
  // untrustworthy is concrete: a broadcast whose HTTP response timed out, which the node accepted
  // anyway and mines a minute later. These rows are the difference between "we looked and did not
  // see it" and "it can never mine".
  describe('not-found must be EARNED by nonce consumption at finality', () => {
    it('downgrades a bare adapter not-found to inconclusive when no nonce was recorded', async () => {
      // The reviewer's exact scenario: broadcast accepted, response timed out, the lookup answers
      // null, and the record carries no nonce. Nothing has been established. Note the adapter here
      // COULD prove consumption — it is the missing record, not a missing capability, that holds,
      // and the missing record means the snapshot is never even spent.
      const adapter = triStateAdapter({ status: 'not-found' }, proofSnapshot({ kaMinted: false }));
      const publishers = publishersWith(adapter);

      const resolution = await createChainProofResolver(publishers)({
        ...lookup,
        publishIdentityKaId: KA_ID.toString(),
      });

      expect(resolution).toEqual({ status: 'inconclusive' });
      expect(resolution.status).not.toBe('not-found');
      expect(adapter.readFinalizedChainProofSnapshot).not.toHaveBeenCalled();
    });

    it('reports not-found once the signed nonce is spent at a FINALIZED block', async () => {
      // The other polarity, and the only difference is the recorded nonce plus a finalized account
      // nonce past it: the slot was consumed by something else, so this transaction can never mine.
      // Both proofs arrive in the ONE pinned snapshot; the identity half has its own describe.
      const adapter = triStateAdapter(
        { status: 'not-found' },
        proofSnapshot({ accountNonce: SIGNED_NONCE + 1, kaMinted: false }),
      );

      expect(await createChainProofResolver(publishersWith(adapter))({
        ...lookupWithNonce,
        publishIdentityKaId: KA_ID.toString(),
      })).toEqual({ status: 'not-found' });
      expect(adapter.readFinalizedChainProofSnapshot).toHaveBeenCalledWith({
        address: WALLET,
        kaId: KA_ID,
      });
    });

    it('holds while the finalized nonce still EQUALS the signed slot', async () => {
      // Equality is not consumption: that slot is the next one to be used, so the transaction is
      // still perfectly able to mine. An off-by-one here would resend a live transaction.
      const publishers = publishersWith(triStateAdapter(
        { status: 'not-found' },
        proofSnapshot({ accountNonce: SIGNED_NONCE, kaMinted: false }),
      ));

      expect(await createChainProofResolver(publishers)({
        ...lookupWithNonce,
        publishIdentityKaId: KA_ID.toString(),
      })).toEqual({ status: 'inconclusive' });
    });

    it('holds when no endpoint can produce the pinned pair', async () => {
      // A chain with no finality, an endpoint that rejects the tag, or a provider set that cannot
      // serve the finalized block identity: the capability answers null, and nothing may fall back
      // to unpinned reads — that fallback IS the snapshot-skew hole.
      const publishers = publishersWith(triStateAdapter({ status: 'not-found' }, proofSnapshot(null)));

      expect(await createChainProofResolver(publishers)({
        ...lookupWithNonce,
        publishIdentityKaId: KA_ID.toString(),
      })).toEqual({ status: 'inconclusive' });
    });

    it('holds when the adapter has no snapshot capability, or the read throws', async () => {
      const noRead = publishersWith(triStateAdapter({ status: 'not-found' }));
      const throwing = publishersWith(triStateAdapter({ status: 'not-found' }, {
        readFinalizedChainProofSnapshot: vi.fn(async () => {
          throw new Error('endpoint rejected the finalized tag');
        }),
      }));
      const identity = { ...lookupWithNonce, publishIdentityKaId: KA_ID.toString() };

      expect(await createChainProofResolver(noRead)(identity)).toEqual({ status: 'inconclusive' });
      expect(await createChainProofResolver(throwing)(identity)).toEqual({ status: 'inconclusive' });
    });

    it('does not spend a snapshot read on a verdict that is not an absence claim', async () => {
      // The read is only meaningful for `not-found`. Firing it on every verdict would cost a chain
      // read per held job per tick for no decision.
      const adapter = triStateAdapter(
        { status: 'pending' },
        proofSnapshot({ accountNonce: SIGNED_NONCE + 1, kaMinted: false }),
      );

      expect(await createChainProofResolver(publishersWith(adapter))({
        ...lookupWithNonce,
        publishIdentityKaId: KA_ID.toString(),
      })).toEqual({ status: 'pending' });
      expect(adapter.readFinalizedChainProofSnapshot).not.toHaveBeenCalled();
    });
  });

  // Nonce consumption proves the recorded HASH can never mine. It does NOT prove the PUBLISH did
  // not happen: a same-calldata replacement — a fee bump from an operator, a shared signer, any
  // sender other than this process — consumes the very same slot AND performs the publish. A lane
  // that released on the nonce alone would re-run on top of a KA that is already on chain.
  describe('a replacement transaction that PUBLISHED must not read as absence', () => {
    const PINNED_KA_ID = KA_ID.toString();

    it('holds when the identity is already on chain, even with the nonce provably consumed', async () => {
      // The reviewer's scenario exactly: different hash, same nonce, and it did the publish.
      // Both nonce facts point at "release"; the identity is the only thing that says otherwise —
      // and it arrives in the SAME snapshot, so it cannot be a stale answer from another block.
      const publishers = publishersWith(triStateAdapter(
        { status: 'not-found' },
        proofSnapshot({ accountNonce: SIGNED_NONCE + 1, kaMinted: true }),
      ));

      const resolution = await createChainProofResolver(publishers)({
        ...lookupWithNonce,
        publishIdentityKaId: PINNED_KA_ID,
      });

      expect(resolution).toEqual({ status: 'inconclusive' });
      expect(resolution.status).not.toBe('not-found');
    });

    it('releases only when the identity is provably NOT on chain', async () => {
      const publishers = publishersWith(triStateAdapter(
        { status: 'not-found' },
        proofSnapshot({ accountNonce: SIGNED_NONCE + 1, kaMinted: false }),
      ));

      expect(await createChainProofResolver(publishers)({
        ...lookupWithNonce,
        publishIdentityKaId: PINNED_KA_ID,
      })).toEqual({ status: 'not-found' });
    });

    it('holds when the job pins NO identity — a re-run would mint a fresh one', async () => {
      // A job whose request does not fix its knowledge asset id allocates a new one on every
      // attempt, so a duplicate is neither contract-impossible nor checkable. The release path
      // narrows to nothing for it rather than the guard weakening — and no snapshot is spent on a
      // job that could never be released by one.
      const adapter = triStateAdapter(
        { status: 'not-found' },
        proofSnapshot({ accountNonce: SIGNED_NONCE + 1, kaMinted: false }),
      );

      expect(await createChainProofResolver(publishersWith(adapter))(lookupWithNonce))
        .toEqual({ status: 'inconclusive' });
      expect(adapter.readFinalizedChainProofSnapshot).not.toHaveBeenCalled();
    });

    it('holds when the minted half of the snapshot cannot answer', async () => {
      const publishers = publishersWith(triStateAdapter(
        { status: 'not-found' },
        proofSnapshot({ accountNonce: SIGNED_NONCE + 1, kaMinted: null }),
      ));
      const identity = { ...lookupWithNonce, publishIdentityKaId: PINNED_KA_ID };

      expect(await createChainProofResolver(publishers)(identity)).toEqual({ status: 'inconclusive' });
    });

    it('reads BOTH proofs from exactly ONE snapshot — never from the granular pair', async () => {
      // GH#2270 PR-3 r4 — the anti-splice property itself. A resolver that fell back to
      // `getFinalizedAccountNonce` + `isKnowledgeAssetMinted` (or issued two snapshot reads)
      // could combine facts observed at different blocks on different endpoints; the granular
      // reads here are live and would happily answer, so this row fails on any such fallback.
      const getFinalizedAccountNonce = vi.fn(async () => SIGNED_NONCE + 1);
      const isKnowledgeAssetMinted = vi.fn(async () => false);
      const adapter = triStateAdapter(
        { status: 'not-found' },
        proofSnapshot({ accountNonce: SIGNED_NONCE + 1, kaMinted: false }, {
          getFinalizedAccountNonce,
          isKnowledgeAssetMinted,
        }),
      );

      expect(await createChainProofResolver(publishersWith(adapter))({
        ...lookupWithNonce,
        publishIdentityKaId: PINNED_KA_ID,
      })).toEqual({ status: 'not-found' });
      expect(adapter.readFinalizedChainProofSnapshot).toHaveBeenCalledTimes(1);
      expect(getFinalizedAccountNonce).not.toHaveBeenCalled();
      expect(isKnowledgeAssetMinted).not.toHaveBeenCalled();
    });
  });

  // GH#2270 PR-3 r4 — named-KA UPDATE jobs. A mined update carries `KnowledgeAssetUpdated`, which
  // the publish parser reports `unrecognized`; and the create-shaped identity check answers
  // "minted" for every update (the CREATE minted the token years ago). Before this lane, an update
  // job could therefore never resolve at all.
  describe('a queued UPDATE resolves through canonical update recognition, never through absence', () => {
    const PINNED_KA_ID = KA_ID.toString();
    const INTENDED_ROOT = `0x${'12'.repeat(32)}`;
    const updateLookup: AsyncLiftChainProofLookup = {
      ...lookupWithNonce,
      publishIdentityKaId: PINNED_KA_ID,
      operationKind: 'update',
      intendedUpdateRoot: INTENDED_ROOT as `0x${string}`,
    };

    /**
     * The update-recognition stub, finality INCLUDED by default (PR #2300 r2 — recognition only
     * yields facts past the shared finality gate, so a stub without the capability can only ever
     * answer inconclusive and every negative row would stop discriminating its own reason).
     */
    function updateChain(extra: Record<string, unknown> = {}) {
      return triStateAdapter({ status: 'unrecognized' }, {
        getDKGKnowledgeAssetsAddress: vi.fn(async () => KA_CONTRACT),
        isReceiptBlockFinalAndCanonical: vi.fn(async () => true),
        ...extra,
      });
    }
    const verifiedAnswer = () => ({
      verified: true,
      onChainMerkleRoot: Buffer.from('12'.repeat(32), 'hex'),
      blockNumber: 88,
      blockHash: `0x${'ef'.repeat(32)}`,
      txIndex: 2,
    });

    it('recovers a mined update whose receipt proves OUR txHash installed OUR intended root', async () => {
      const verifyKAUpdate = vi.fn(async () => verifiedAnswer());
      const adapter = updateChain({ verifyKAUpdate });

      const resolution = await createChainProofResolver(publishersWith(adapter))(updateLookup);

      expect(resolution.status).toBe('recovered');
      expect(resolution.status === 'recovered' ? resolution.recovery : null).toMatchObject({
        inclusion: { txHash: TX_HASH, blockNumber: 88 },
        finalization: {
          mode: 'published',
          txHash: TX_HASH,
          batchId: PINNED_KA_ID,
          startKAId: PINNED_KA_ID,
          endKAId: PINNED_KA_ID,
        },
        // PR #2300 r2 — the verdict CARRIES the canonical evidence, which is what lets the named
        // finalizer consume this one verification instead of re-proving the transaction.
        canonicalUpdate: {
          onChainRoot: INTENDED_ROOT,
          blockHash: `0x${'ef'.repeat(32)}`,
          txIndex: 2,
        },
      });
      // The chain was asked about exactly our transaction, our pinned id, our signing wallet —
      // and the finality gate was consulted with the verified receipt's identity.
      expect(verifyKAUpdate).toHaveBeenCalledWith(TX_HASH, KA_ID, WALLET);
      expect(adapter.isReceiptBlockFinalAndCanonical).toHaveBeenCalledWith({
        txHash: TX_HASH,
        blockNumber: 88,
        blockHash: `0x${'ef'.repeat(32)}`,
      });
    });

    it('carries the verified history POSITION from verifyKAUpdate to the named publishProof [r7]', async () => {
      // 3812435587 — the A -> B -> A protection is only as good as the propagation: the position
      // has to survive verification -> verdict evidence -> named recovery evidence. Injecting it at
      // the last consumer proves the comparison and nothing about the pipeline, so this drives the
      // REAL resolvers from a verifyKAUpdate answer that reports it.
      const verifyKAUpdate = vi.fn(async () => ({ ...verifiedAnswer(), merkleRootCount: 1n }));
      const adapter = updateChain({ verifyKAUpdate });
      const publishers = publishersWith(adapter);

      const resolution = await createChainProofResolver(publishers)(updateLookup);
      expect(resolution.status).toBe('recovered');
      const verdictRecovery = resolution.status === 'recovered' ? resolution.recovery : undefined;
      expect(verdictRecovery?.canonicalUpdate?.merkleRootCount).toBe('1');

      // …and through the named lane the dispatcher hands to the agent finalizer.
      const named = await createKnowledgeAssetVmPublishRecoveryResolver(publishers)(
        {
          status: 'failed',
          request: {
            jobType: 'knowledge-asset-vm-publish',
            knowledgeAssetVmPublish: {
              // contentScopeVersion is a precondition of the named lane; without it the resolver
              // answers null, which an optional-chained assertion would read as 'no count'.
              contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
              kaUal: 'did:dkg:31337/0x1111111111111111111111111111111111111111/7',
              seal: { merkleRoot: INTENDED_ROOT, authorAddress: WALLET, reservedKaId: PINNED_KA_ID },
              sealMerkleRoot: INTENDED_ROOT,
            },
          },
        } as never,
        updateLookup,
        verdictRecovery,
      );

      // The result is the point of the row: a null here would satisfy an optional-chained field
      // assertion, so non-nullness is asserted first and the field second.
      expect(named).not.toBeNull();
      expect(named?.publishProof.merkleRootCount).toBe('1');
    });

    it('holds a verified update whose receipt block is NOT yet final — a mined update is not a fact', async () => {
      // PR #2300 r2 (🔴 3809616675) — the reorg polarity: same verified answer, but the block
      // carrying it is unfinalized (or no longer canonical at its height, which the shared
      // primitive folds into the same false). Treating it as fact would finalize a job from a
      // receipt a reorg can still rewrite.
      const verifyKAUpdate = vi.fn(async () => verifiedAnswer());
      const adapter = updateChain({
        verifyKAUpdate,
        isReceiptBlockFinalAndCanonical: vi.fn(async () => false),
      });

      expect(await createChainProofResolver(publishersWith(adapter))(updateLookup))
        .toEqual({ status: 'inconclusive' });
      expect(verifyKAUpdate).toHaveBeenCalledTimes(1);
    });

    it('caches NOTHING from an unfinalized ask — finality later yields a fresh verification', async () => {
      // PR #2300 r2 — no stale fact can survive, trivially: nothing unfinalized ever becomes a
      // fact, and there is no cache at all any more. The second ask re-verifies from scratch and
      // recovers once the gate answers true.
      const verifyKAUpdate = vi.fn(async () => verifiedAnswer());
      const gate = vi.fn(async () => false);
      const adapter = updateChain({ verifyKAUpdate, isReceiptBlockFinalAndCanonical: gate });
      const resolve = createChainProofResolver(publishersWith(adapter));

      expect(await resolve(updateLookup)).toEqual({ status: 'inconclusive' });
      gate.mockResolvedValue(true);
      expect((await resolve(updateLookup)).status).toBe('recovered');
      expect(verifyKAUpdate).toHaveBeenCalledTimes(2);
    });

    it('holds when the verified on-chain root is NOT the root this job intended', async () => {
      // A mined update for our kaId that installed some OTHER root is someone else's update (or a
      // different attempt's). Claiming it as ours would finalize this job against evidence that
      // does not commit to its seal.
      const publishers = publishersWith(updateChain({
        verifyKAUpdate: vi.fn(async () => ({
          ...verifiedAnswer(),
          onChainMerkleRoot: Buffer.from('ff'.repeat(32), 'hex'),
        })),
      }));

      expect(await createChainProofResolver(publishers)(updateLookup)).toEqual({ status: 'inconclusive' });
    });

    it('holds on an unverified answer, a missing capability, or a lookup with no update identity', async () => {
      const unverified = publishersWith(updateChain({
        verifyKAUpdate: vi.fn(async () => ({ verified: false })),
      }));
      const noCapability = publishersWith(triStateAdapter({ status: 'unrecognized' }));
      const noIdentity = publishersWith(updateChain({
        verifyKAUpdate: vi.fn(async () => verifiedAnswer()),
      }));

      expect(await createChainProofResolver(unverified)(updateLookup)).toEqual({ status: 'inconclusive' });
      expect(await createChainProofResolver(noCapability)(updateLookup)).toEqual({ status: 'inconclusive' });
      expect(await createChainProofResolver(noIdentity)({
        ...updateLookup,
        intendedUpdateRoot: undefined,
      })).toEqual({ status: 'inconclusive' });
    });

    it('NEVER releases an update by absence — even with the tx not found and the nonce consumed', async () => {
      // The ABA row, consciously against half the reviewer's suggested direction. An update has no
      // monotone register to prove absence against: "current root ≠ intended" also describes our
      // update landing and being superseded by a LATER third-party update — at which point a
      // release re-signs and re-applies our now-STALE root over the newer state. A create's
      // token-minted register can never un-happen, which is exactly why absence release is
      // create-only. This update job stays held for the operator.
      // The snapshot is scripted to a pair that WOULD release a create-shaped job — so a mutant
      // that routes updates through the absence path produces `not-found` here and dies on both
      // assertions, not just the call-count one.
      const adapter = triStateAdapter(
        { status: 'not-found' },
        proofSnapshot({ accountNonce: SIGNED_NONCE + 1, kaMinted: false }),
      );

      const resolution = await createChainProofResolver(publishersWith(adapter))(updateLookup);

      expect(resolution).toEqual({ status: 'inconclusive' });
      expect(resolution.status).not.toBe('not-found');
      // The absence machinery is not even consulted for an update: there is no absence question
      // it could answer safely.
      expect(adapter.readFinalizedChainProofSnapshot).not.toHaveBeenCalled();
    });
  });

  describe('never reports an absence it did not establish', () => {
    // The load-bearing row. A legacy two-state adapter cannot see the mempool, so its `null`
    // is "we do not know", not "it did not happen". Reading it as `not-found` would authorise
    // a resend of a transaction that is about to be mined.
    it('a legacy adapter can never contribute an ABSENCE either [r1, r17]', async () => {
      // The original property (a receipt-only adapter cannot tell a mempool transaction from an
      // unknown one, so its null must never become `not-found`) still holds — and since r17 such an
      // adapter is inconclusive in both directions, so its lookup is not even consulted.
      const legacy = {
        chainId: 'evm:31337',
        resolvePublishByTxHash: vi.fn(async () => null),
        getDKGKnowledgeAssetsAddress: vi.fn(async () => KA_CONTRACT),
      } as unknown as ChainAdapter;

      const resolution = await createChainProofResolver(publishersWith(legacy))(lookupWithNonce);

      expect(resolution.status).toBe('inconclusive');
      expect(resolution.status).not.toBe('not-found');
    });

    it('reports inconclusive when the lookup throws', async () => {
      const publishers = publishersWith({
        chainId: 'evm:31337',
        resolvePublishTransaction: vi.fn(async () => {
          throw new Error('ETIMEDOUT: rpc unreachable');
        }),
      });

      expect(await createChainProofResolver(publishers)(lookup)).toEqual({ status: 'inconclusive' });
    });

    it('reports inconclusive for an unknown wallet and for an adapter with no publish lookup', async () => {
      const unknownWallet = createChainProofResolver(new Map());
      const noLookup = createChainProofResolver(publishersWith({ chainId: 'evm:31337' }));
      const noAdapter = createChainProofResolver(publishersWith(undefined));

      expect(await unknownWallet(lookup)).toEqual({ status: 'inconclusive' });
      expect(await noLookup(lookup)).toEqual({ status: 'inconclusive' });
      expect(await noAdapter(lookup)).toEqual({ status: 'inconclusive' });
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

      const resolution = await createChainProofResolver(publishers)(lookup);

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
      expect(await createChainProofResolver(publishers)(lookup)).toEqual({ status: 'pending' });
      expect(resolvePublishByTxHash).not.toHaveBeenCalled();
    });

    it('a legacy-only adapter is inconclusive in BOTH directions [r17]', async () => {
      // 3814893074 — the receipt-only lookup can neither see a mempool (so it may never contribute
      // `not-found`) nor establish that its receipt block is final and canonical: its result has no
      // block hash, so there is nothing to hand the finality primitive. Confirming from it would
      // finalize a job from state a reorg can still rewrite. Such a node holds its jobs; adapters
      // implementing the tri-state lookup are unaffected.
      // The stub answers with a publish precisely so the status alone cannot discriminate: a
      // downstream that consumed it would still land on `inconclusive` for want of an update
      // verification. The load-bearing observable is that the legacy lookup is never CONSULTED.
      const resolvePublishByTxHash = vi.fn(async () => ({
        blockNumber: 9,
        merkleRoot: new Uint8Array(32),
      }));
      const legacy = {
        chainId: 'evm:31337',
        resolvePublishByTxHash,
        getDKGKnowledgeAssetsAddress: vi.fn(async () => KA_CONTRACT),
      } as unknown as ChainAdapter;

      const resolution = await createChainProofResolver(publishersWith(legacy))(lookupWithNonce);

      expect(resolution.status).toBe('inconclusive');
      expect(resolvePublishByTxHash).not.toHaveBeenCalled();
    });

    it('hasChainPublishLookup accepts either lookup and rejects an adapter with neither', () => {
      const asAdapter = (c: Record<string, unknown>) => c as unknown as ChainAdapter;

      expect(hasChainPublishLookup(asAdapter({ resolvePublishByTxHash: () => null }))).toBe(true);
      expect(hasChainPublishLookup(asAdapter({ resolvePublishTransaction: () => null }))).toBe(true);
      expect(hasChainPublishLookup(asAdapter({
        resolvePublishByTxHash: () => null, resolvePublishTransaction: () => null,
      }))).toBe(true);
      expect(hasChainPublishLookup(asAdapter({ chainId: 'evm:31337' }))).toBe(false);
      expect(hasChainPublishLookup(asAdapter({}))).toBe(false);
    });
  });

  // The two halves composed. Everything above tests this module in isolation and everything in
  // async-lift-chain-proof-dispatch-2270 tests the publisher's dispatch on a hand-written verdict;
  // neither can catch a rule that is right on one side of the boundary and wrong at the join.
  // These drive a REAL publisher whose resolver is the real `createChainProofResolver`.
  describe('composed with the publisher dispatcher', () => {
    async function heldJobOn(
      chain: Record<string, unknown>,
      nonce?: number,
      requestOverrides: Record<string, unknown> = {},
      publisherConfig: Record<string, unknown> = {},
    ): Promise<{
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
        chainProofResolver: createChainProofResolver(publishers),
        knowledgeAssetVmPublishRecoveryResolver: async () => null,
        ...publisherConfig,
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
        ...requestOverrides,
        seal: {
          merkleRoot: `0x${'12'.repeat(32)}`,
          authorAddress: WALLET as `0x${string}`,
          signature: { r: `0x${'34'.repeat(32)}`, vs: `0x${'56'.repeat(32)}` },
          schemeVersion: 1,
          // Pins the id a re-run would mint — without it there is no identity to check and the
          // dispatcher must hold, which is its own row below.
          reservedKaId: ((BigInt(WALLET) << 96n) | 7n).toString(),
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
      // The write-ahead stamps WHICH BRANCH signed; this fixture stands in for it, so it records
      // the branch the queued publish would have resolved for this request.
      const operationKind = (requestOverrides as { vmCurrentAssertion?: string }).vmCurrentAssertion !== undefined
        ? 'update' as const
        : 'create' as const;
      await publisher.update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId: WALLET, nonce, operationKind } });
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

    it('keeps a held job held when the tx is not found but its NONCE is unspent', async () => {
      // The reviewer's scenario end to end: the broadcast was accepted, the response timed out,
      // and this endpoint cannot find the transaction. The wallet's finalized nonce still sits ON
      // the signed slot, so that transaction can still mine — releasing here is the double publish.
      const { publisher, status } = await heldJobOn({
        chainId: 'evm:31337',
        resolvePublishTransaction: vi.fn(async () => ({ status: 'not-found' as const })),
        ...proofSnapshot({ accountNonce: SIGNED_NONCE, kaMinted: false }),
      }, SIGNED_NONCE);

      expect(await publisher.recover()).toBe(0);
      expect((await status())?.status).toBe('failed');
      expect((await status())?.status).not.toBe('accepted');
    });

    it('releases a held job once the tx is absent AND its nonce is spent at finality', async () => {
      // The other polarity, so the rows above cannot pass by the dispatcher simply never running.
      // Same job, same code path; the only difference is that the slot is now provably consumed.
      const { publisher, status } = await heldJobOn({
        chainId: 'evm:31337',
        resolvePublishTransaction: vi.fn(async () => ({ status: 'not-found' as const })),
        ...proofSnapshot({ accountNonce: SIGNED_NONCE + 1, kaMinted: false }),
      }, SIGNED_NONCE);

      expect((await status())?.status).toBe('failed');
      expect(await publisher.recover()).toBe(1);

      const after = await status();
      expect(after?.status).toBe('accepted');
      expect(after?.recovery?.txHashChecked).toBe(TX_HASH);
    });

    it('an UPDATE job is NEVER released by absence at the join — same facts that release a create', async () => {
      // GH#2270 PR-3 r4 — the composed ABA row: the real publisher derives the update kind from
      // the persisted request, the real resolver refuses to earn a not-found for it, and the job
      // stays exactly where it was. The adapter here answers with the precise pair that releases
      // the create-shaped sibling in the row above.
      const { publisher, status } = await heldJobOn(
        {
          chainId: 'evm:31337',
          resolvePublishTransaction: vi.fn(async () => ({ status: 'not-found' as const })),
          ...proofSnapshot({ accountNonce: SIGNED_NONCE + 1, kaMinted: false }),
        },
        SIGNED_NONCE,
        { vmCurrentAssertion: '12'.repeat(32), assertionVersion: '2' },
      );

      expect(await publisher.recover()).toBe(0);
      const after = await status();
      expect(after?.status).toBe('failed');
      expect(after?.status).not.toBe('accepted');
    });

    it('a mined UPDATE that proves the intended root reaches the named finalize lane', async () => {
      // Composed recognition: the real lookup carries kind + intended root, the real resolver
      // turns the update-verification answer into `recovered`, and the dispatcher takes the
      // FINALIZE path — observable here as the named lane holding for local repair (this harness
      // wires no repair resolver), rather than the job being reset or ignored.
      const verifyKAUpdate = vi.fn(async () => ({
        verified: true,
        onChainMerkleRoot: Buffer.from('12'.repeat(32), 'hex'),
        blockNumber: 91,
        blockHash: `0x${'ef'.repeat(32)}`,
        txIndex: 2,
      }));
      const { publisher, status } = await heldJobOn(
        {
          chainId: 'evm:31337',
          resolvePublishTransaction: vi.fn(async () => ({ status: 'unrecognized' as const })),
          verifyKAUpdate,
          getDKGKnowledgeAssetsAddress: vi.fn(async () => KA_CONTRACT),
          isReceiptBlockFinalAndCanonical: vi.fn(async () => true),
        },
        SIGNED_NONCE,
        { vmCurrentAssertion: '12'.repeat(32), assertionVersion: '2' },
      );

      expect(await publisher.recover()).toBe(0);

      // Asked about OUR tx, OUR pinned id, OUR wallet — the derivation composed end to end.
      expect(verifyKAUpdate).toHaveBeenCalledWith(TX_HASH, (BigInt(WALLET) << 96n) | 7n, WALLET);
      // Held for repair, not reset: the recognition reached the finalize lane.
      const after = await status();
      expect(after?.status).toBe('failed');
      expect(after?.recovery?.txHashAccounted).toBeUndefined();
    });

    it('verifies a recognized update ONCE for the whole recovery — the verdict CARRIES the evidence', async () => {
      // PR #2300 r2 (🟡 3809616683) — no shared verifier, no memo, no temporal coupling: the two
      // factories are constructed independently, and the once-only property holds by DESIGN
      // because the recovered verdict carries the canonical evidence to the finalizer. A
      // regression that drops the evidence from the verdict forces the finalizer to re-verify
      // and fails this call count.
      const verifyKAUpdate = vi.fn(async () => ({
        verified: true,
        onChainMerkleRoot: Buffer.from('12'.repeat(32), 'hex'),
        blockNumber: 91,
        blockHash: `0x${'ef'.repeat(32)}`,
        txIndex: 2,
      }));
      const chain = {
        chainId: 'evm:31337',
        resolvePublishTransaction: vi.fn(async () => ({ status: 'unrecognized' as const })),
        verifyKAUpdate,
        getDKGKnowledgeAssetsAddress: vi.fn(async () => KA_CONTRACT),
        isReceiptBlockFinalAndCanonical: vi.fn(async () => true),
      };
      const publishers = publishersWith(chain);
      const finalizeRecovered = vi.fn(async () => undefined);
      const { publisher, status } = await heldJobOn(
        chain,
        SIGNED_NONCE,
        { vmCurrentAssertion: '12'.repeat(32), assertionVersion: '2' },
        {
          chainProofResolver: createChainProofResolver(publishers),
          knowledgeAssetVmPublishRecoveryResolver:
            createKnowledgeAssetVmPublishRecoveryResolver(publishers),
          knowledgeAssetVmPublishHandler: {
            execute: async () => { throw new Error('the dispatcher must never cause a send'); },
            finalizeRecovered,
          },
        },
      );

      expect(await publisher.recover()).toBe(1);

      expect((await status())?.status).toBe('finalized');
      expect(finalizeRecovered).toHaveBeenCalledOnce();
      expect(verifyKAUpdate).toHaveBeenCalledTimes(1);
    });

    it('keeps a LIVE interrupted update tx-bearing while its receipt block is unfinalized', async () => {
      // PR #2300 r2 (🔴 3809616675) — the lane the round-1 class sweep missed: a daemon restart
      // finds the update job still in 'broadcast', the interrupted lane resolves it through the
      // SAME recovery resolver with no verdict having run, and a merely-mined receipt must NOT
      // finalize it. The verifier's own finality gate is what every consumer inherits.
      const verifyKAUpdate = vi.fn(async () => ({
        verified: true,
        onChainMerkleRoot: Buffer.from('12'.repeat(32), 'hex'),
        blockNumber: 91,
        blockHash: `0x${'ef'.repeat(32)}`,
        txIndex: 2,
      }));
      const gate = vi.fn(async () => false);
      const chain = {
        chainId: 'evm:31337',
        resolvePublishTransaction: vi.fn(async () => ({ status: 'pending' as const })),
        verifyKAUpdate,
        getDKGKnowledgeAssetsAddress: vi.fn(async () => KA_CONTRACT),
        isReceiptBlockFinalAndCanonical: gate,
      };
      const publishers = publishersWith(chain);
      const finalizeRecovered = vi.fn(async () => undefined);
      const store = new OxigraphStore();
      let now = 1_000;
      let ids = 0;
      const publisher = new TripleStoreAsyncLiftPublisher(store, {
        now: () => ++now,
        idGenerator: () => `job-${++ids}`,
        chainProofResolver: createChainProofResolver(publishers),
        knowledgeAssetVmPublishRecoveryResolver:
          createKnowledgeAssetVmPublishRecoveryResolver(publishers),
        knowledgeAssetVmPublishHandler: {
          execute: async () => { throw new Error('the recovery lane must never cause a send'); },
          finalizeRecovered,
        },
      });
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish({
        contextGraphId: 'music-social',
        name: 'albums',
        shareOperationId: 'share-op-live',
        roots: [],
        contentScopeVersion: 2,
        kaUal: 'did:dkg:31337/0x1111111111111111111111111111111111111111/7',
        assertionVersion: '2',
        vmCurrentAssertion: '12'.repeat(32),
        publicTripleCount: 2,
        privateTripleCount: 0,
        seal: {
          merkleRoot: `0x${'12'.repeat(32)}`,
          authorAddress: WALLET as `0x${string}`,
          signature: { r: `0x${'34'.repeat(32)}`, vs: `0x${'56'.repeat(32)}` },
          schemeVersion: 1,
          reservedKaId: ((BigInt(WALLET) << 96n) | 7n).toString(),
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
      // The daemon "dies" here: the job is live in 'broadcast' with its tx on the wire.
      await publisher.update(jobId, 'broadcast', {
        broadcast: { txHash: TX_HASH, walletId: WALLET, nonce: SIGNED_NONCE, operationKind: 'update' },
      });

      // Restart: the interrupted lane runs. The update is verified but NOT final — no fact, no
      // finalize, and the job keeps its transaction evidence.
      await publisher.recover();

      const after = await publisher.getStatus(jobId);
      expect(after?.status).not.toBe('finalized');
      expect(finalizeRecovered).not.toHaveBeenCalled();
      expect(verifyKAUpdate).toHaveBeenCalled();
      expect(gate).toHaveBeenCalled();
      // Tx-bearing, whatever state the lane parked it in: the evidence survives.
      expect(
        after?.broadcast?.txHash ?? after?.recovery?.txHashChecked,
      ).toBe(TX_HASH);

      // Finality arrives; the SAME lane now finalizes from a fresh verification.
      gate.mockResolvedValue(true);
      await publisher.recover();
      expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
    });
  });
});
