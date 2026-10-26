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
