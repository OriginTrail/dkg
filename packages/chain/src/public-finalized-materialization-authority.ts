import { ethers } from 'ethers';
import type { ChainAdapter } from './chain-adapter.js';

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

export interface PublicFinalizedMaterializationAuthorityRequest {
  chain?: ChainAdapter;
  onChainContextGraphId?: string;
  kaId: bigint;
  assertionVersion: string;
  merkleRoot: Uint8Array;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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
    const [active, accessPolicy, rootCountBefore] = await Promise.all([
      chain.isContextGraphActiveOnChain(onChainContextGraphId),
      chain.getContextGraphAccessPolicy(onChainContextGraphId),
      chain.getMerkleRootCount(request.kaId),
    ]);
    const latestRoot = await chain.getLatestMerkleRoot(request.kaId);
    let authorAddress: string | undefined;
    let authorUnavailableReason: string | undefined;
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
    // root-count reads. Until an adapter supplies a block-tagged snapshot,
    // this is the conservative coherence fence, including same-root updates.
    const rootCountAfter = await chain.getMerkleRootCount(request.kaId);
    if (!active) return { kind: 'unavailable', reason: 'inactive-context-graph' };
    if (accessPolicy !== 0) {
      return { kind: 'unavailable', reason: 'non-public-context-graph' };
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
    return {
      kind: 'unavailable',
      reason: 'chain-read-failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
