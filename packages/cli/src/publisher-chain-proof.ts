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
  FinalizedChainProofSnapshot,
  OnChainPublishResult,
} from '@origintrail-official/dkg-chain';
import type {
  AsyncLiftChainProofLookup,
  AsyncLiftUpdateChainProofLookup,
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
  // r20 (🔴 3815617109) — the capability must name the lookup this lane ACTUALLY calls, which
  // r17 narrowed to the tri-state one: a legacy receipt-only result carries no block hash, so its
  // canonicality cannot be established and it can never support a confirmation. Accepting
  // `resolvePublishByTxHash` here therefore advertised a recovery lane that was guaranteed to
  // answer `inconclusive` forever — the runtime installed both resolvers, admission told clients
  // the job was retryable, and nothing would ever move it. Reporting NO automatic exit is the
  // honest answer for such a node, and it leaves the operator's by-id clear as the stated one.
  return typeof chain.resolvePublishTransaction === 'function';
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
    // GH#2270 PR-3 r4 — a queued UPDATE's mined transaction carries `KnowledgeAssetUpdated`, not a
    // publish event, so the publish parser reports it `unrecognized` and the job could never
    // resolve. When the lookup says the queued operation WAS an update, ask the update-verification
    // machinery whether this exact transaction installed the exact intended root. PR #2300 r2 —
    // the recovered verdict CARRIES the canonical evidence, so the named finalizer consumes this
    // one verification instead of re-proving it (no shared verifier instance, no memo).
    if (resolution.status === 'unrecognized' && lookup.operationKind === 'update') {
      return resolveCanonicalUpdateRecognition(lookup, adapters);
    }
    if (resolution.status === 'not-found' && lookup.operationKind === 'update') {
      // Release-by-absence stays CREATE-ONLY, deliberately. A create's identity register is
      // MONOTONE — a token, once minted, never unmints — so "unminted at a finalized block with
      // the nonce consumed" is a proof no later event can invalidate. An update has no such
      // register: any absence statement about it reduces to "the current root is not the intended
      // root", and that observation cannot distinguish "our update never landed" from "it landed
      // and a LATER third-party update superseded it" (nor from "still in flight"). Releasing on
      // it re-signs and re-applies a STALE root over newer state — the ABA hazard. An update whose
      // transaction cannot be proven canonical therefore stays held, with the operator's by-id
      // clear as the exit.
      return { status: 'inconclusive' };
    }
    if (resolution.status === 'not-found') {
      // TWO independent proofs, and both must hold. Nonce consumption settles that the recorded
      // HASH can never mine; the identity check settles that no OTHER transaction performed this
      // publish. Either one alone is a resend waiting to happen.
      //
      // GH#2270 PR-3 r4 — both proofs are observed in ONE adapter snapshot, at ONE finalized
      // block on ONE provider. Read separately they could be served by different endpoints at
      // different heights, and "nonce consumed" (a fresh endpoint) plus "identity unminted" (a
      // lagging endpoint that has not seen the replacement's mint) composes into a release
      // verdict no single chain state ever contained. The DECISION still lives here — the
      // adapter reports atomically-observed facts; policy decides what they establish.
      return await isPublishProvenAbsent(lookup, adapters)
        ? { status: 'not-found' }
        : { status: 'inconclusive' };
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
 * PR #2300 r1 (🟡 3809054830) — the canonically verified facts of ONE queued update, established
 * ONCE and shared by every consumer.
 *
 * The verdict resolver and the named-KA evidence resolver used to each call
 * {@link ChainAdapter.verifyKAUpdate} for the same transaction — genuine policy duplication with
 * drift risk: two call sites deciding "is this mined update OURS" can disagree about the binding
 * rules. This function is the one place that asks, and the one place that binds the answer: the
 * receipt fetched BY our recorded txHash carries an update event for exactly our pinned kaId, the
 * chain-verified new root equals the root our seal intended to install, and the root history at
 * the receipt block attributes it to our signing wallet (all established inside `verifyKAUpdate`;
 * nothing is taken from the job's say-so except which transaction and which root to ask about).
 *
 * PR #2300 r2 (🔴 3809616675) — verified facts are FACTS only past finality: before anything is
 * returned, the receipt's block must be FINAL and CANONICAL, established through the SAME
 * {@link ChainAdapter.isReceiptBlockFinalAndCanonical} primitive the generic mined verdicts use
 * (shared, not duplicated). Every consumer inherits the gate here — the dispatcher's verdict AND
 * the LIVE interrupted lane, which reaches this without any verdict having run. A merely-mined
 * update answers `null`: a non-fact that keeps the job tx-bearing, because a reorg can land the
 * same signed transaction on a chain where it writes a different history. And because nothing
 * unfinalized ever becomes a fact, there is nothing to cache and no stale fact to survive — the
 * round-1 memo (and its shared-instance requirement and eviction policy) is deleted; the verdict
 * now CARRIES the evidence to the finalizer instead (see CanonicalUpdateEvidence).
 */
export interface CanonicalUpdateFacts {
  readonly kaId: bigint;
  readonly onChainRoot: LiftJobHex;
  readonly blockNumber: number;
  /** r5 — the verified position in the asset's update history; roots repeat, positions do not. */
  /**
   * r13 (3813797045) — carried as the STRING it is persisted and compared as, so the value crosses
   * every boundary in one representation instead of being re-encoded at each hop.
   */
  readonly merkleRootCount?: string;
  readonly blockHash?: string;
  readonly txIndex?: number;
}

export async function verifyCanonicalUpdateFacts(
  lookup: AsyncLiftUpdateChainProofLookup,
  adapters: PublisherChainAdapters,
): Promise<CanonicalUpdateFacts | null> {
  const chain = adapters.get(lookup.walletId);
  if (!chain?.verifyKAUpdate || !chain.isReceiptBlockFinalAndCanonical) return null;
  if (lookup.publishIdentityKaId === undefined || lookup.intendedUpdateRoot === undefined) {
    return null;
  }
  let kaId: bigint;
  try {
    kaId = BigInt(lookup.publishIdentityKaId);
  } catch {
    return null;
  }
  let verification;
  try {
    verification = await chain.verifyKAUpdate(lookup.txHash, kaId, lookup.walletId);
  } catch {
    return null;
  }
  if (!verification.verified || !verification.onChainMerkleRoot) return null;
  if (verification.blockNumber === undefined || verification.blockHash === undefined) return null;
  const onChainRoot = asLiftJobHex(ethers.hexlify(verification.onChainMerkleRoot));
  if (!onChainRoot || onChainRoot.toLowerCase() !== lookup.intendedUpdateRoot.toLowerCase()) {
    return null;
  }
  // The finality gate, LAST: only a verified update whose receipt block is final and still
  // canonical is a fact. A gate that answers false — or cannot answer — leaves the job
  // tx-bearing; the next pass asks the chain again from scratch.
  try {
    const finalAndCanonical = await chain.isReceiptBlockFinalAndCanonical({
      txHash: lookup.txHash,
      blockNumber: verification.blockNumber,
      blockHash: verification.blockHash,
    });
    if (!finalAndCanonical) return null;
  } catch {
    return null;
  }
  return {
    kaId,
    onChainRoot,
    blockNumber: verification.blockNumber,
    ...(verification.merkleRootCount !== undefined ? { merkleRootCount: verification.merkleRootCount.toString() } : {}),
    blockHash: verification.blockHash,
    ...(verification.txIndex !== undefined ? { txIndex: verification.txIndex } : {}),
  };
}

/**
 * GH#2270 PR-3 r4 — is this mined-but-unrecognized transaction OUR update, canonically? The
 * establishment (finality included) lives in {@link verifyCanonicalUpdateFacts}; this maps the
 * verified facts to the dispatcher's verdict, CARRYING the canonical evidence on it (PR #2300
 * r2) so the named finalizer consumes this one verification. Every gap collapses to
 * `inconclusive` and the job stays held.
 */
async function resolveCanonicalUpdateRecognition(
  lookup: AsyncLiftUpdateChainProofLookup,
  adapters: PublisherChainAdapters,
): Promise<AsyncLiftChainProofResolution> {
  const chain = adapters.get(lookup.walletId);
  if (!chain?.getDKGKnowledgeAssetsAddress) return { status: 'inconclusive' };
  const facts = await verifyCanonicalUpdateFacts(lookup, adapters);
  if (!facts) return { status: 'inconclusive' };
  let knowledgeAssetsContract: string;
  try {
    knowledgeAssetsContract = await chain.getDKGKnowledgeAssetsAddress();
  } catch {
    return { status: 'inconclusive' };
  }
  const publisherAddress = asLiftJobHex(lookup.walletId);
  if (!publisherAddress) return { status: 'inconclusive' };
  const blockHash = facts.blockHash ? asLiftJobHex(facts.blockHash) : null;
  return {
    status: 'recovered',
    recovery: {
      inclusion: { txHash: lookup.txHash, blockNumber: facts.blockNumber },
      finalization: {
        mode: 'published',
        txHash: lookup.txHash,
        ual: buildKnowledgeAssetUal(chain.chainId, knowledgeAssetsContract, facts.kaId),
        batchId: facts.kaId.toString() as `${bigint}`,
        startKAId: facts.kaId.toString() as `${bigint}`,
        endKAId: facts.kaId.toString() as `${bigint}`,
        publisherAddress,
      },
      canonicalUpdate: {
        onChainRoot: facts.onChainRoot,
        ...(facts.merkleRootCount !== undefined ? { merkleRootCount: facts.merkleRootCount } : {}),
        ...(blockHash ? { blockHash } : {}),
        ...(facts.txIndex !== undefined ? { txIndex: facts.txIndex } : {}),
      },
    },
  };
}

/**
 * GH#2270 PR-3 r4 — the release-by-absence decision, over ONE pinned snapshot.
 *
 * `true` requires every link at once: a recorded nonce slot (else there is no "can never mine"
 * statement to make), a pinned publish identity (else a re-run would mint a fresh asset with
 * nothing on chain to object), an adapter that can produce the pinned pair, a snapshot it
 * actually produced, a nonce strictly past the recorded slot AT the pinned finalized block
 * (`getTransactionCount` is the NEXT nonce, so equality means the slot is still unspent), and the
 * identity provably NOT minted at that SAME block. Every gap — no capability, a `null` snapshot
 * because no endpoint could serve the pinned pair, a `null` minted classification, a malformed
 * persisted id — answers `false`, and the job keeps its hold and its operator exit.
 */
async function isPublishProvenAbsent(
  lookup: AsyncLiftChainProofLookup,
  adapters: PublisherChainAdapters,
): Promise<boolean> {
  if (lookup.nonce === undefined) return false;
  if (lookup.publishIdentityKaId === undefined) return false;
  const chain = adapters.get(lookup.walletId);
  if (!chain?.readFinalizedChainProofSnapshot) return false;
  let kaId: bigint;
  try {
    kaId = BigInt(lookup.publishIdentityKaId);
  } catch {
    return false;
  }
  let snapshot: FinalizedChainProofSnapshot | null;
  try {
    snapshot = await chain.readFinalizedChainProofSnapshot({ address: lookup.walletId, kaId });
  } catch {
    return false;
  }
  if (!snapshot) return false;
  return snapshot.accountNonce > lookup.nonce && snapshot.kaMinted === false;
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
    // r17 (3814893074) — the legacy receipt-only lookup cannot support a confirmation here. Unlike
    // `resolvePublishTransaction` it never establishes that the receipt's block is final, and its
    // result carries no block HASH, so canonicality at that height cannot be checked either — there
    // is nothing to hand the finality primitive. Treating its answer as confirmation would finalize
    // a job from state a reorg can still rewrite, which is exactly what the tri-state path exists to
    // prevent, so a legacy-only adapter now contributes `inconclusive` in BOTH directions: it can
    // neither prove absence (it cannot see a mempool) nor prove a durable publish. Such a node holds
    // its jobs and the operator's by-id clear remains; adapters that implement the tri-state lookup
    // are unaffected.
    return { status: 'inconclusive' };
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
