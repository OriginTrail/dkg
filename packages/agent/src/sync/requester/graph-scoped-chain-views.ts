// SPDX-License-Identifier: Apache-2.0
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { parseDeterministicKnowledgeAssetUal } from '@origintrail-official/dkg-core';
import { packKnowledgeAssetIdFromIdentity } from '../../ka-identity.js';

/** Validate identity now, then acquire one shared set of raw views when the caller
 * is ready. Fetched authentication starts provenance in parallel with read().
 */
export function prepareGraphScopedChainViewRead(chain: ChainAdapter, ual: string, errors: {
  readonly unsupported: string;
  wrongChain(identityChainId: string): string;
}, signal?: AbortSignal) {
  if (chain.chainId === 'none' || !chain.getLatestMerkleRoot || !chain.getMerkleRootCount || !chain.getKAContextGraphId) {
    throw Object.assign(new Error(errors.unsupported), { code: 'VM_CHAIN_VERIFICATION_UNSUPPORTED' });
  }
  const identity = parseDeterministicKnowledgeAssetUal(ual);
  if (identity.chainId !== chain.chainId) throw new Error(errors.wrongChain(identity.chainId));
  const kaId = packKnowledgeAssetIdFromIdentity(identity);
  const latestRoot = chain.getLatestMerkleRoot.bind(chain);
  const rootCount = chain.getMerkleRootCount.bind(chain);
  const contextGraphId = chain.getKAContextGraphId.bind(chain);
  return { kaId, read: async () => {
    const [latestRootValue, rootCountValue, boundContextGraphId] = await Promise.all([
      latestRoot(kaId, { signal }), rootCount(kaId, { signal }), contextGraphId(kaId, { signal }),
    ]);
    return { latestRoot: latestRootValue, rootCount: rootCountValue, boundContextGraphId };
  } };
}

export type VerifyContextGraphBinding = (
  localContextGraphId: string,
  onChainContextGraphId: bigint,
  signal?: AbortSignal,
) => Promise<boolean>;

export type GraphScopedChainEvidence =
  | { readonly kind: 'match' }
  | { readonly kind: 'mismatch'; readonly code: 'VM_CHAIN_ROOT_MISMATCH' | 'VM_CHAIN_ASSERTION_VERSION_MISMATCH' | 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH'; readonly message: string };

/** Expected evidence mismatches are values; unavailable evidence and cancellation reject. */
export async function validateGraphScopedChainEvidence(
  copy: { ual: string; contextGraphId: string; merkleRootHex: string; assertionVersion: bigint },
  evidence: { latestRoot: Uint8Array; rootCount: bigint; boundContextGraphId: bigint },
  verifyContextGraphBinding: VerifyContextGraphBinding | undefined,
  signal?: AbortSignal, requiredBinding?: string,
): Promise<GraphScopedChainEvidence> {
  signal?.throwIfAborted();
  const { latestRoot, rootCount, boundContextGraphId } = evidence;
  if (latestRoot.length !== 32 || Buffer.from(latestRoot).toString('hex') !== copy.merkleRootHex) {
    return { kind: 'mismatch', code: 'VM_CHAIN_ROOT_MISMATCH',
      message: `Graph-scoped durable sync ${copy.ual} does not match the latest on-chain Merkle root` };
  }
  if (rootCount !== copy.assertionVersion) {
    return { kind: 'mismatch', code: 'VM_CHAIN_ASSERTION_VERSION_MISMATCH',
      message: `Graph-scoped durable sync ${copy.ual} assertionVersion ${copy.assertionVersion} does not match on-chain root count ${rootCount}` };
  }
  if (boundContextGraphId <= 0n || (requiredBinding !== undefined && requiredBinding !== boundContextGraphId.toString())) {
    return { kind: 'mismatch', code: 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH',
      message: `Graph-scoped durable sync ${copy.ual} is bound to invalid context graph ${boundContextGraphId}` };
  }
  if (!verifyContextGraphBinding) {
    throw Object.assign(new Error('Graph-scoped durable sync requires local-to-chain context-graph verification'),
      { code: 'VM_CHAIN_VERIFICATION_UNSUPPORTED' });
  }
  const bound = await verifyContextGraphBinding(copy.contextGraphId, boundContextGraphId, signal);
  signal?.throwIfAborted();
  return bound ? { kind: 'match' } : { kind: 'mismatch', code: 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH',
    message: `Graph-scoped durable sync ${copy.ual} is bound to context graph ${boundContextGraphId}, which does not match local context graph ${copy.contextGraphId}` };
}
