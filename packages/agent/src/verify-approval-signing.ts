// SPDX-License-Identifier: Apache-2.0

import { computeVerifyApprovalDigest } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';

/**
 * What a verify proposer signs: approvals, its own included, are bound to the chain and the
 * deployment (the signing domain), and to the context graph, batch and Merkle root. Kept out of
 * `dkg-agent-endorse.ts`, which is at its file-size budget.
 */
export async function verifyApprovalSigningInput(
  chain: Pick<ChainAdapter, 'getEvmChainId' | 'getKnowledgeAssetsLifecycleAddress'>,
  contextGraphIdOnChain: bigint,
  batchId: bigint,
  merkleRoot: Uint8Array,
): Promise<{ signingDomain: { chainId: bigint; contractAddress: string }; digest: Uint8Array }> {
  const [chainId, contractAddress] = await Promise.all([
    chain.getEvmChainId(),
    chain.getKnowledgeAssetsLifecycleAddress(),
  ]);
  const digest = computeVerifyApprovalDigest(chainId, contractAddress, contextGraphIdOnChain, batchId, merkleRoot);
  return { signingDomain: { chainId, contractAddress }, digest };
}
