/**
 * GH#2270 — the runner's chain lookup must be able to say WHICH chain fact it found.
 *
 * `createChainRecoveryResolver` answers `AsyncLiftPublisherRecoveryResult | null`, and that
 * `null` covers a reverted tx, a mined non-publish tx, a tx still in the mempool, a tx the
 * node has never heard of, and an RPC that simply failed. The publisher's retry decision
 * turns on telling the fourth apart from the rest: only there is a resend safe. These pin
 * that `createChainProofResolver` reports the distinction, and — just as importantly — that
 * the two-state resolver derived from it still collapses every one of those states to `null`,
 * so wiring the primitive in changes nothing until the dispatcher consumes it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PublishTransactionResolution } from '@origintrail-official/dkg-chain';
import type { DKGPublisher, LiftJobBroadcast } from '@origintrail-official/dkg-publisher';
import {
  createChainProofResolver,
  createChainRecoveryResolver,
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
      // ...and the derived two-state resolver still answers null for it, unchanged.
      expect(await createChainRecoveryResolver(publishers)(job)).toBeNull();
    });

    it('maps a confirmed publish to recovery evidence, which the derived resolver returns', async () => {
      const publishers = publishersWith(
        triStateAdapter({ status: 'confirmed', publish: onChainPublish() as never }),
      );

      const resolution = await createChainProofResolver(publishers)(job);
      const derived = await createChainRecoveryResolver(publishers)(job);

      expect(resolution.status).toBe('recovered');
      expect(resolution.status === 'recovered' ? resolution.recovery : null).toEqual(derived);
      expect(derived).toMatchObject({
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
});
