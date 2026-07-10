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

export interface UnpackedKnowledgeAssetId {
  agentAddress: string;
  kaNumber: bigint;
}

// Exact inverse of packKnowledgeAssetIdFromIdentity: high-160 bits are the agent
// address, low-96 bits are the per-author KA number. The address is returned
// lowercase (not checksummed), so callers MUST compare it case-insensitively.
export function unpackKnowledgeAssetId(packed: bigint): UnpackedKnowledgeAssetId {
  return {
    agentAddress: `0x${(packed >> 96n).toString(16).padStart(40, '0')}`,
    kaNumber: packed & ((1n << 96n) - 1n),
  };
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
