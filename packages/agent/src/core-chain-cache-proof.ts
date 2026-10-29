// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import { decodeSnapshotChallenge, decodeCoreChainCacheProof, encodeCoreChainCacheProof,
  type UnsignedCoreChainCacheProof, type SnapshotProofCodec, type SnapshotSourceChallenge } from './public-snapshot-proof-wire.js';
import type { CoreChainCacheNetwork } from './core-chain-cache-config.js';
import { CORE_CHAIN_CACHE_SOURCE_PROTOCOL } from './core-chain-cache-config.js';

export type CoreChainCacheChallenge = SnapshotSourceChallenge;
export type { CoreChainCacheProof } from './public-snapshot-proof-wire.js';
export { SNAPSHOT_PROOF_MAX_BYTES as CACHE_PROOF_MAX_BYTES } from './public-snapshot-proof-wire.js';
export function decodeCacheChallenge(bytes: Uint8Array): CoreChainCacheChallenge {
  try { return decodeSnapshotChallenge(bytes); }
  catch { throw new Error('Invalid cache challenge'); }
}
export function cacheProofPayload(c: CoreChainCacheChallenge, p: UnsignedCoreChainCacheProof): Uint8Array {
  // Registration deployment and requested data deployment are separate, signed scopes.
  return ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify([
    CORE_CHAIN_CACHE_SOURCE_PROTOCOL, c.version, c.nonce, c.requesterPeerId, c.responderPeerId,
    c.chainId, c.deploymentId, c.contextGraphId, c.onChainId, p.chainId, p.deploymentId, p.identityId,
  ]))));
}
export function cacheProofCodec(challenge: CoreChainCacheChallenge): SnapshotProofCodec<UnsignedCoreChainCacheProof> {
  return { payload: proof => cacheProofPayload(challenge, proof),
    encode: (proof, signature) => encodeCoreChainCacheProof({ ...proof, signature }) };
}
export async function verifyCacheProof(bytes: Uint8Array, c: CoreChainCacheChallenge,
  networks: readonly CoreChainCacheNetwork[], signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const p = decodeCoreChainCacheProof(bytes);
  if (!p) return false;
  const registry = networks.find(n => n.registry.chainId === p.chainId && n.registry.deploymentId === p.deploymentId)?.registry;
  if (!registry) return false;
  const signer = ethers.verifyMessage(cacheProofPayload(c, p), p.signature);
  const valid = await registry.verifyACKIdentity(signer, BigInt(p.identityId), { signal });
  signal.throwIfAborted();
  return valid;
}
