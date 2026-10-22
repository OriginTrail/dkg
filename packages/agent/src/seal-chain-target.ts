// SPDX-License-Identifier: Apache-2.0
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { AssertionSeal } from '@origintrail-official/dkg-core';

/**
 * Why a seal's EIP-712 domain does not name the chain and KAv10 deployment
 * this daemon points at, or `undefined` when it does (or the adapter cannot
 * say). This is the cross-deployment safety the domain buys: a signature, and
 * any chain evidence read for it, only means something on the chain it names.
 */
export async function sealChainTargetMismatch(
  chain: ChainAdapter,
  seal: Pick<AssertionSeal, 'chainId' | 'kav10Address'>,
): Promise<string | undefined> {
  if (typeof chain.getEvmChainId !== 'function' || typeof chain.getKnowledgeAssetsLifecycleAddress !== 'function') {
    return undefined;
  }
  const liveChainId = await chain.getEvmChainId();
  const liveKav10 = await chain.getKnowledgeAssetsLifecycleAddress();
  if (liveChainId !== seal.chainId) {
    return `seal binds chainId=${seal.chainId.toString()} but daemon is configured for chainId=${liveChainId.toString()}. ` +
      'The author signature is not valid against this chain. Re-finalize the assertion against the target chain.';
  }
  if (liveKav10.toLowerCase() !== seal.kav10Address.toLowerCase()) {
    return `seal binds KAv10=${seal.kav10Address} but daemon is configured for KAv10=${liveKav10}. ` +
      'The signature is not valid against this deployment.';
  }
  return undefined;
}
