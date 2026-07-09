import { ethers } from 'ethers';
import { buildKnowledgeAssetUal, type ChainAdapter } from '@origintrail-official/dkg-chain';

export interface KnowledgeAssetIdentity {
  agentAddress: string;
  kaNumber: string | number | bigint;
}

type AssetUalChain = Pick<ChainAdapter, 'chainId' | 'getKnowledgeAssetsLifecycleAddress' | 'getDKGKnowledgeAssetsAddress'>;

export function packKnowledgeAssetIdFromIdentity(identity: KnowledgeAssetIdentity): bigint {
  return (BigInt(ethers.getAddress(identity.agentAddress.toLowerCase())) << 96n) | BigInt(identity.kaNumber);
}

export async function resolveAssetUalFromKaIdentity(
  chain: AssetUalChain,
  identity: KnowledgeAssetIdentity,
): Promise<string> {
  const storageAddress = chain.getDKGKnowledgeAssetsAddress
    ? await chain.getDKGKnowledgeAssetsAddress()
    : await chain.getKnowledgeAssetsLifecycleAddress();
  return buildKnowledgeAssetUal(
    chain.chainId,
    storageAddress,
    packKnowledgeAssetIdFromIdentity(identity),
  );
}
