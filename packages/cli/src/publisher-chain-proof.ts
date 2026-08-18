/**
 * GH#2270 PR-3 — the runner's implementation of the publisher's chain-proof contract.
 *
 * The publisher OWNS the vocabulary (`AsyncLiftChainProofResolution`, `AsyncLiftChainProofLookup`)
 * because it is what dispatches on a verdict. What lives here is the half the union cannot state:
 * the rules that decide when this node is allowed to say a publish is ABSENT, and the chain reads
 * that establish it.
 *
 * It is a module rather than a section of `publisher-runner.ts` because it is policy, not wiring.
 * The runner is the composition root — it builds wallets, stores and handlers and hands them to
 * each other; this is a body of reasoning about proof, with its own invariants, that happens to be
 * consumed there. Keeping it in the runner meant the file that answers "how is the daemon
 * assembled" also had to answer "when may a held job be resent", and the second question is the
 * one with the double-publish at the end of it.
 *
 * THE RULE, in one place: an absence must be ESTABLISHED, never inferred. Every unknown this
 * module can produce collapses to `inconclusive` and never to `not-found` — an RPC error, a wallet
 * with no adapter, an adapter with no publish lookup, a contract address that would not resolve, a
 * chain result the lift mapper rejected, a `null` from a two-state adapter that cannot see the
 * mempool, a nonce that is not provably consumed, and an identity that is not provably absent. The
 * publisher holds forever on `inconclusive`, so anything that leaks in here as `not-found` becomes
 * a resend of a transaction that may be in flight.
 */
import { ethers } from 'ethers';
import { buildKnowledgeAssetUal } from '@origintrail-official/dkg-chain';
import type {
  ChainAdapter,
  OnChainPublishResult,
} from '@origintrail-official/dkg-chain';
import type {
  AsyncLiftChainProofLookup,
  AsyncLiftChainProofResolution,
  AsyncLiftPublisherRecoveryResult,
  LiftJobHex,
} from '@origintrail-official/dkg-publisher';
/**
 * Can this publisher's chain adapter be asked whether a broadcast tx published?
 *
 * GH#2270 — EITHER lookup qualifies. `resolvePublishTransaction` is the surface
 * {@link createChainProofResolver} prefers, so an adapter offering only that one
 * must not silently lose chain recovery; an adapter offering only the legacy
 * `resolvePublishByTxHash` keeps the recovery it has always had.
 */
export function hasChainPublishLookup(chain: ChainAdapter): boolean {
  return typeof chain.resolvePublishByTxHash === 'function'
    || typeof chain.resolvePublishTransaction === 'function';
}

/**
 * GH#2270 PR-3 r2 — wallet id to the chain adapter that signs for it.
 *
 * The recovery factories used to take the publisher map and reach through each `DKGPublisher` for
 * its `chain` with an `as unknown as { chain?: ChainAdapter }` cast — a private field, read through
 * an assertion the compiler cannot check, in six places. Rename that field and every cast keeps
 * compiling while silently answering `undefined`, which reads as "no chain recovery available" and
 * holds every job forever.
 *
 * The map is built once at the wiring site from `ConfiguredPublisherWallet[]`, where the adapter is
 * a real public field, and capability detection lives beside it.
 */
export type PublisherChainAdapters = ReadonlyMap<string, ChainAdapter>;

/** The wallet→adapter map for the recovery factories, from the wallets the runtime configured. */
export function chainAdaptersForWallets(
  wallets: readonly { readonly address: string; readonly chain: ChainAdapter }[],
): PublisherChainAdapters {
  return new Map(wallets.map((wallet) => [wallet.address, wallet.chain]));
}

/**
 * GH#2270 — the runner's implementation of the publisher's chain-proof contract.
 *
 * The VERDICT VOCABULARY is not defined here: `AsyncLiftChainProofResolution` belongs to the
 * publisher, which is what dispatches on it. This module's job is the one rule that union cannot
 * state — that an absence must be ESTABLISHED. Every unknown this side can produce collapses into
 * `inconclusive` and never into `not-found`: an RPC error, a wallet with no publisher, an adapter
 * with no publish lookup, a contract address that would not resolve, a chain result the lift mapper
 * rejected, and — deliberately — a `null` from an adapter offering only the two-state
 * {@link ChainAdapter.resolvePublishByTxHash}, which cannot tell a mempool transaction from an
 * unknown one.
 *
 * The publisher holds forever on `inconclusive`, so an unknown that leaked in here as `not-found`
 * would become a resend of a transaction that may be in flight.
 *
 * PR-3 r1 — and the adapter's own `not-found` is NOT one of those establishings. A transaction
 * lookup is point-in-time and backend-local: a broadcast whose response timed out can be sitting
 * in a mempool this endpoint cannot see, and be mined a minute later. `not-found` is therefore
 * EARNED here, from nonce consumption at finality, or it is downgraded.
 */
export function createChainProofResolver(
  adapters: PublisherChainAdapters,
): (lookup: AsyncLiftChainProofLookup) => Promise<AsyncLiftChainProofResolution> {
  return async (lookup) => {
    const resolution = await resolvePublishTransactionState(lookup, adapters);
    if (resolution.status === 'not-found') {
      // TWO independent proofs, and both must hold. Nonce consumption settles that the recorded
      // HASH can never mine; the identity check settles that no OTHER transaction performed this
      // publish. Either one alone is a resend waiting to happen.
      const cannotMine = await isNonceProvenConsumed(lookup, adapters);
      if (!cannotMine) return { status: 'inconclusive' };
      const alreadyPublished = await isPublishIdentityOnChain(lookup, adapters);
      return alreadyPublished === false ? { status: 'not-found' } : { status: 'inconclusive' };
    }
    if (resolution.status !== 'confirmed') return resolution;
    const recovery = await mapConfirmedPublishToLiftRecovery(resolution.publish, resolution.chain);
    // The chain confirmed a publish this node cannot turn into recovery evidence
    // (no knowledge-assets contract, or fields the mapper rejects). That is a
    // gap in what we can USE, not a fact about the chain: it must not read as
    // absence.
    return recovery ? { status: 'recovered', recovery } : { status: 'inconclusive' };
  };
}

/**
 * GH#2270 PR-3 r1 — is this transaction PROVABLY unable to mine?
 *
 * The adapter has just told us it cannot find the transaction. On its own that means nothing: the
 * lookup is a point-in-time answer from one backend, and the classic loss case is a broadcast
 * whose HTTP response timed out while the node accepted it anyway. Treating that as absence is how
 * a job gets resent while its first transaction is still perfectly capable of mining.
 *
 * What settles it is the nonce. Every signed transaction reserves one slot on its wallet, and the
 * pre-send write-ahead records which. If the wallet's account nonce at a FINALIZED block is
 * strictly greater than that slot, then the slot has been spent — and since the transaction is not
 * on chain, it was spent by something ELSE. It can never mine now, and a resend is safe.
 *
 * Every gap is fail-closed: no recorded nonce (records written before the field existed, and
 * inherited hashes, which name a transaction some earlier attempt signed), no adapter support for
 * the read, an endpoint that cannot serve `finalized`, or a read that throws — all answer `false`,
 * and the job keeps its hold and its operator exit.
 */
/**
 * GH#2270 PR-3 r2 — did SOMETHING already publish this job's identity? `true` / `false` / `null`
 * when it could not be established.
 *
 * This is the half nonce consumption cannot cover. A consumed slot proves the recorded transaction
 * can never mine; it says nothing about whether a DIFFERENT transaction on that same slot — a
 * fee-bumped replacement carrying the same calldata — already did the publish. Releasing on the
 * nonce alone would re-run on top of it.
 *
 * A job whose request pins its knowledge asset id can simply be asked. One `eth_call` on `ownerOf`,
 * against an id the job already persists, answers whoever sent the transaction. A job with no
 * pinned id would allocate a fresh one on re-run, so there is nothing to ask and nothing that would
 * stop a duplicate: it answers `null` here and the caller holds. That is the release path narrowing
 * rather than the guard weakening.
 */
async function isPublishIdentityOnChain(
  lookup: AsyncLiftChainProofLookup,
  adapters: PublisherChainAdapters,
): Promise<boolean | null> {
  if (lookup.publishIdentityKaId === undefined) return null;
  const chain = adapters.get(lookup.walletId);
  if (!chain?.isKnowledgeAssetMinted) return null;
  try {
    return await chain.isKnowledgeAssetMinted(BigInt(lookup.publishIdentityKaId));
  } catch {
    return null;
  }
}

async function isNonceProvenConsumed(
  lookup: AsyncLiftChainProofLookup,
  adapters: PublisherChainAdapters,
): Promise<boolean> {
  if (lookup.nonce === undefined) return false;
  const chain = adapters.get(lookup.walletId);
  if (!chain?.getFinalizedAccountNonce) return false;
  try {
    const finalizedNonce = await chain.getFinalizedAccountNonce(lookup.walletId);
    // `getTransactionCount` is the NEXT nonce, so `> lookup.nonce` means this slot is behind the
    // finalized frontier. Equality is not enough: the slot is still the next one to be used.
    return finalizedNonce !== null && finalizedNonce > lookup.nonce;
  } catch {
    return false;
  }
}

/**
 * The chain lookup for one broadcast job, reported as the chain fact.
 *
 * GH#2270 — the adapter's tri-state {@link ChainAdapter.resolvePublishTransaction}
 * is used when it exists, because it is the only surface that asks the node for
 * the TRANSACTION and can therefore return a `not-found` that means something.
 * An adapter offering only `resolvePublishByTxHash` is not downgraded to a
 * guess: its `null` becomes `inconclusive`, never `not-found`, so an adapter
 * that cannot see the mempool can never authorise a resend.
 */
async function resolvePublishTransactionState(
  lookup: AsyncLiftChainProofLookup,
  adapters: PublisherChainAdapters,
): Promise<
  | { status: 'confirmed'; publish: OnChainPublishResult; chain: ChainAdapter }
  | Exclude<AsyncLiftChainProofResolution, { status: 'recovered' }>
> {
  const chain = adapters.get(lookup.walletId);
  if (!chain) return { status: 'inconclusive' };

  try {
    if (chain.resolvePublishTransaction) {
      const resolution = await chain.resolvePublishTransaction(lookup.txHash);
      return resolution.status === 'confirmed'
        ? { status: 'confirmed', publish: resolution.publish, chain }
        : resolution;
    }
    if (!chain.resolvePublishByTxHash) return { status: 'inconclusive' };
    const publish = await chain.resolvePublishByTxHash(lookup.txHash);
    return publish ? { status: 'confirmed', publish, chain } : { status: 'inconclusive' };
  } catch {
    // Transient RPC/provider errors establish nothing — report that rather than
    // crashing the daemon, so the recovery timeout mechanism handles it.
    return { status: 'inconclusive' };
  }
}

/** The confirmed publish, mapped to lift recovery evidence, or `null` if this node cannot. */
async function mapConfirmedPublishToLiftRecovery(
  publish: OnChainPublishResult,
  chain: ChainAdapter,
): Promise<AsyncLiftPublisherRecoveryResult | null> {
  let knowledgeAssetsContract = publish.knowledgeAssetsContract;
  if (!knowledgeAssetsContract && chain.getDKGKnowledgeAssetsAddress) {
    try {
      knowledgeAssetsContract = await chain.getDKGKnowledgeAssetsAddress();
    } catch {
      return null;
    }
  }
  if (!knowledgeAssetsContract) return null;
  return mapOnChainPublishResultToLiftRecovery(publish, chain.chainId, knowledgeAssetsContract);
}

/** Shared with the runner's canonical-receipt mapper; both narrow the same persisted hex shape. */
export function asLiftJobHex(value: string): LiftJobHex | null {
  return ethers.isHexString(value) ? value as LiftJobHex : null;
}

export function asLiftJobBigInt(value: bigint | undefined): `${bigint}` | undefined {
  return value?.toString() as `${bigint}` | undefined;
}

export function mapOnChainPublishResultToLiftRecovery(
  result: OnChainPublishResult,
  chainId: string,
  knowledgeAssetsContract: string,
): AsyncLiftPublisherRecoveryResult | null {
  const txHash = asLiftJobHex(result.txHash);
  const publisherAddress = asLiftJobHex(result.publisherAddress);
  if (!txHash || !publisherAddress) return null;

  const recoveredKaId = result.kaId ?? result.startKAId ?? result.batchId;
  return {
    inclusion: {
      txHash,
      blockNumber: result.blockNumber,
      blockTimestamp: result.blockTimestamp,
    },
    finalization: {
      mode: 'published',
      txHash,
      ual: buildKnowledgeAssetUal(chainId, knowledgeAssetsContract, recoveredKaId),
      batchId: result.batchId.toString() as `${bigint}`,
      startKAId: asLiftJobBigInt(result.startKAId),
      endKAId: asLiftJobBigInt(result.endKAId),
      publisherAddress,
    },
  };
}
