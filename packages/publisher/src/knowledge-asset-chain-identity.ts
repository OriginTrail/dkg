import type { ChainAdapter } from '@origintrail-official/dkg-chain';

export async function resolveKaUal(chain: Pick<ChainAdapter, 'chainId' | 'getDKGKnowledgeAssetsAddress'>, kaId: bigint): Promise<string> {
  const storageAddr = chain.getDKGKnowledgeAssetsAddress
    ? await chain.getDKGKnowledgeAssetsAddress()
    : undefined;
  if (!storageAddr) {
    throw new Error('Cannot resolve KA UAL: DKGKnowledgeAssets address unavailable');
  }
  return `did:dkg:${chain.chainId}/${storageAddr.toLowerCase()}/${kaId.toString()}`;
}

