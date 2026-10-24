import { ethers } from 'ethers';
import { buildKnowledgeAssetUalFromOnChainIdV1 } from '@origintrail-official/dkg-core';
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

/**
 * Resolve the local KA UAL represented by an on-chain registration id.
 *
 * Rootless V10 KAs pack the author address into the high 160 bits and the
 * per-author KA number into the low 96 bits. Their canonical local identity is
 * therefore author/number, not the legacy storage-contract/packed-id receipt
 * identity. Legacy sequential ids have no author bits and deliberately keep
 * the old contract/id form so existing read-only KAs remain addressable.
 */
export function buildReconciledKnowledgeAssetUal(
  chainId: string,
  legacyStorageAddress: string,
  kaId: bigint,
): string {
  // Delegates to the single owner of this rule in `core`. It used to branch
  // here and in `packages/core/src/vm-update-convergence.ts`, guarded by a
  // cross-package parity test — two production implementations of one identity
  // rule, with a test that catches drift only after it happens. The dependency
  // direction never required that: `agent → chain → core`, so `core` can own it
  // and this can delegate downward.
  //
  // Behaviour is unchanged: the owner lowercases the storage address exactly as
  // `buildKnowledgeAssetUal` did, which the sole caller relies on — it passes
  // the checksummed address returned by `getDKGKnowledgeAssetsAddress()`.
  return buildKnowledgeAssetUalFromOnChainIdV1(chainId, legacyStorageAddress, kaId);
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
