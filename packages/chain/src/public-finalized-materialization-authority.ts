import { ethers } from 'ethers';
import {
  ContextGraphLiveAuthorityUnsupportedError,
  type ChainAdapter,
  type KnowledgeAssetVersionSnapshot,
} from './chain-adapter.js';

export type PublicFinalizedMaterializationAuthorityUnavailableReason =
  | 'capability-unavailable'
  | 'invalid-input'
  | 'inactive-context-graph'
  | 'non-public-context-graph'
  | 'root-count-drift'
  | 'assertion-version-mismatch'
  | 'latest-root-mismatch'
  | 'chain-read-failed';

export type PublicFinalizedMaterializationAuthorityResult =
  | {
    kind: 'resolved';
    authorAddress?: string;
    authorUnavailableReason?: string;
  }
  | {
    kind: 'unavailable';
    reason: PublicFinalizedMaterializationAuthorityUnavailableReason;
    detail?: string;
  };

/**
 * One coherent, finalized Knowledge Asset version observation. Callers may
 * carry this only within the operation which obtained it from
 * `readKnowledgeAssetVersionSnapshot`; it is not a cache entry.
 */
export interface PublicFinalizedMaterializationVersionSnapshot
  extends Omit<KnowledgeAssetVersionSnapshot, 'latestRoot'> {
  latestRoot: Uint8Array;
}

export interface PublicFinalizedMaterializationAuthorityRequest {
  chain?: ChainAdapter;
  onChainContextGraphId?: string;
  kaId: bigint;
  assertionVersion: string;
  merkleRoot: Uint8Array;
  versionBlock?: number;
  versionSnapshot?: PublicFinalizedMaterializationVersionSnapshot;
  signal?: AbortSignal;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * The public-CG gate: `active` AND `accessPolicy === 0`, from ONE read.
 *
 * The two point reads this replaces are correct — the caller pairs them, so
 * the default-zero hazard on `getAccessPolicy` (no `_requireExists`, a
 * nonexistent id reads back as PUBLIC) is already covered by checking `active`
 * first. What they are not is COHERENT: issued as two `latest` calls they can
 * land either side of a block, so a graph deactivated between them is read as
 * active with a policy from after it stopped being one. `getContextGraph`
 * answers both from a single tuple at a single block, so the pair cannot
 * straddle, and it costs one billed request instead of two.
 *
 * A `null` resolution means the chain PROVED the id nonexistent. The adapter
 * contract says callers must treat that exactly as a liveness probe returning
 * `false` — terminal, never retried — so it is reported here as an inactive
 * graph, which is the same verdict the point reads reach.
 *
 * Only a DETERMINISTIC failure of the single read falls back. A transient one
 * rejects with the transport's own error and is not silently retried as two
 * more requests, which would turn provider trouble into extra load.
 *
 * Every read carries the caller's signal. The one-read is shared in flight, and
 * a waiter's own signal is the only way it can leave that flight: without it an
 * aborted materialization holds the shared read open until it settles, and the
 * physical RPC cannot be cancelled when the last waiter goes.
 */
async function resolvePublicContextGraphGateV1(
  chain: ChainAdapter,
  onChainContextGraphId: bigint,
  signal: AbortSignal | undefined,
): Promise<Readonly<{ active: boolean; accessPolicy: number }>> {
  const readOptions = { signal };
  const oneRead = chain.getContextGraphLiveAuthority;
  if (oneRead !== undefined) {
    try {
      const authority = await oneRead.call(chain, onChainContextGraphId, readOptions);
      return authority === null
        ? Object.freeze({ active: false, accessPolicy: 0 })
        : Object.freeze({
          active: authority.active,
          accessPolicy: authority.accessPolicy,
        });
    } catch (error) {
      // Name check as well as `instanceof`: the adapter's own definitive-error
      // predicate does the same, because a rebuilt module realm can carry a
      // structurally identical class that fails the prototype test.
      const deterministic = error instanceof ContextGraphLiveAuthorityUnsupportedError
        || (error instanceof Error
          && error.name === 'ContextGraphLiveAuthorityUnsupportedError');
      if (!deterministic) throw error;
    }
  }
  const [active, accessPolicy] = await Promise.all([
    chain.isContextGraphActiveOnChain!(onChainContextGraphId, readOptions),
    chain.getContextGraphAccessPolicy!(onChainContextGraphId, readOptions),
  ]);
  return Object.freeze({ active, accessPolicy });
}

/**
 * Resolve the chain-owned authority required for receiptless public VM
 * materialization. The adapter capability choreography stays here so graph
 * materializers consume one typed decision and never reproduce Solidity
 * default-value, root-version, or temporal-coherence rules.
 */
export async function resolvePublicFinalizedMaterializationAuthority(
  request: PublicFinalizedMaterializationAuthorityRequest,
): Promise<PublicFinalizedMaterializationAuthorityResult> {
  const chain = request.chain;
  if (
    !chain
    || chain.chainId === 'none'
    || !chain.isContextGraphActiveOnChain
    || !chain.getContextGraphAccessPolicy
    || !chain.getMerkleRootCount
    || !chain.getLatestMerkleRoot
    || !request.onChainContextGraphId
  ) {
    return { kind: 'unavailable', reason: 'capability-unavailable' };
  }

  let onChainContextGraphId: bigint;
  let assertionVersion: bigint;
  try {
    onChainContextGraphId = BigInt(request.onChainContextGraphId);
    assertionVersion = BigInt(request.assertionVersion);
    if (onChainContextGraphId <= 0n || assertionVersion <= 0n) {
      return { kind: 'unavailable', reason: 'invalid-input' };
    }
  } catch {
    return { kind: 'unavailable', reason: 'invalid-input' };
  }

  try {
    // Keep the legacy root-count read concurrent with the live CG gates. A
    // supplied coherent snapshot owns that value already and starts no extra
    // version RPC here.
    const rootCountBeforeRead = request.versionSnapshot
      ? Promise.resolve<bigint | undefined>(undefined)
      : chain.getMerkleRootCount!(request.kaId);
    const [gate, legacyRootCountBefore] = await Promise.all([
      resolvePublicContextGraphGateV1(chain, onChainContextGraphId, request.signal),
      rootCountBeforeRead,
    ]);
    if (!gate.active) return { kind: 'unavailable', reason: 'inactive-context-graph' };
    if (gate.accessPolicy !== 0) {
      return { kind: 'unavailable', reason: 'non-public-context-graph' };
    }

    const suppliedSnapshot = request.versionSnapshot;
    let reuseSuppliedSnapshot = false;
    if (suppliedSnapshot && chain.knowledgeAssetVersionSnapshotIsCurrent) {
      try {
        reuseSuppliedSnapshot = await chain.knowledgeAssetVersionSnapshotIsCurrent(
          request.kaId,
          {
            ...suppliedSnapshot,
            latestRoot: ethers.hexlify(suppliedSnapshot.latestRoot),
          },
          { signal: request.signal },
        );
      } catch {
        // Abort is an operation fence, not an optimization miss. Every other
        // validation failure preserves the unchanged live-read path below.
        request.signal?.throwIfAborted();
      }
    }
    request.signal?.throwIfAborted();
    let rootCountBefore: bigint;
    let rootCountAfter: bigint;
    let latestRoot: Uint8Array;
    let authorAddress: string | undefined;
    let authorUnavailableReason: string | undefined;

    if (suppliedSnapshot && reuseSuppliedSnapshot) {
      if (
        suppliedSnapshot.rootCount <= 0n
        || suppliedSnapshot.latestRoot.length !== 32
        || !Number.isSafeInteger(suppliedSnapshot.blockNumber)
        || suppliedSnapshot.blockNumber < 0
        || request.versionBlock !== suppliedSnapshot.blockNumber
        || !ethers.isAddress(suppliedSnapshot.latestPublisher)
        || suppliedSnapshot.latestPublisher === ethers.ZeroAddress
      ) {
        return { kind: 'unavailable', reason: 'invalid-input' };
      }
      rootCountBefore = suppliedSnapshot.rootCount;
      rootCountAfter = suppliedSnapshot.rootCount;
      latestRoot = suppliedSnapshot.latestRoot;
      if (
        ethers.isAddress(suppliedSnapshot.latestAuthor)
        && suppliedSnapshot.latestAuthor !== ethers.ZeroAddress
      ) {
        authorAddress = ethers.getAddress(suppliedSnapshot.latestAuthor);
      } else {
        authorUnavailableReason = 'invalid author in coherent version snapshot';
      }
    } else {
      // A missing, stale, rotating, or inconclusive lease is optimization-only.
      // Preserve the unchanged live tuple/root materialization authority path.
      rootCountBefore = legacyRootCountBefore
        ?? await chain.getMerkleRootCount(request.kaId);
      latestRoot = await chain.getLatestMerkleRoot!(request.kaId);
      if (chain.getLatestMerkleRootAuthor) {
        try {
          const candidate = await chain.getLatestMerkleRootAuthor(request.kaId);
          if (ethers.isAddress(candidate) && candidate !== ethers.ZeroAddress) {
            authorAddress = ethers.getAddress(candidate);
          }
        } catch (error) {
          authorUnavailableReason = error instanceof Error ? error.message : String(error);
        }
      }
      // Sandwich the latest-root and optional author reads between monotonic
      // root-count reads. Callers without a block-pinned snapshot retain this
      // conservative coherence fence, including same-root updates.
      rootCountAfter = await chain.getMerkleRootCount!(request.kaId);
    }

    if (rootCountBefore !== rootCountAfter) {
      return { kind: 'unavailable', reason: 'root-count-drift' };
    }
    if (rootCountAfter !== assertionVersion) {
      return { kind: 'unavailable', reason: 'assertion-version-mismatch' };
    }
    if (!equalBytes(latestRoot, request.merkleRoot)) {
      return { kind: 'unavailable', reason: 'latest-root-mismatch' };
    }
    return {
      kind: 'resolved',
      ...(authorAddress ? { authorAddress } : {}),
      ...(authorUnavailableReason ? { authorUnavailableReason } : {}),
    };
  } catch (error) {
    request.signal?.throwIfAborted();
    return {
      kind: 'unavailable',
      reason: 'chain-read-failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
