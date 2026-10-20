// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import { isPublicGraphSnapshotScope } from '@origintrail-official/dkg-chain';
import type { CoreChainCacheNetwork } from './core-chain-cache-config.js';
import { CORE_CHAIN_CACHE_SOURCE_PROTOCOL } from './core-chain-cache-config.js';

export interface CoreChainCacheChallenge {
  version: 1; nonce: string; requesterPeerId: string; responderPeerId: string;
  chainId: string; deploymentId: string; contextGraphId: string; onChainId: string;
}
export interface CoreChainCacheProof {
  chainId: string; deploymentId: string; identityId: string; signature: string;
}
export const CACHE_PROOF_MAX_BYTES = 2048;
export function decodeCacheChallenge(bytes: Uint8Array): CoreChainCacheChallenge {
  if (bytes.length > CACHE_PROOF_MAX_BYTES) throw new Error('Invalid cache challenge');
  const c = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!c || typeof c !== 'object' || Array.isArray(c)
    || Object.keys(c).sort().join(',') !== 'chainId,contextGraphId,deploymentId,nonce,onChainId,requesterPeerId,responderPeerId,version'
    || c.version !== 1 || !isPublicGraphSnapshotScope(c)
    || typeof c.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(c.nonce)
    || ![c.chainId, c.deploymentId, c.requesterPeerId, c.responderPeerId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256))
    throw new Error('Invalid cache challenge');
  return c;
}
export function cacheProofPayload(c: CoreChainCacheChallenge, p: Omit<CoreChainCacheProof, 'signature'>): Uint8Array {
  // Registration deployment and requested data deployment are separate, signed scopes.
  return ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify([
    CORE_CHAIN_CACHE_SOURCE_PROTOCOL, c.version, c.nonce, c.requesterPeerId, c.responderPeerId,
    c.chainId, c.deploymentId, c.contextGraphId, c.onChainId, p.chainId, p.deploymentId, p.identityId,
  ]))));
}
export async function verifyCacheProof(bytes: Uint8Array, c: CoreChainCacheChallenge,
  networks: readonly CoreChainCacheNetwork[], signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  if (bytes.length > CACHE_PROOF_MAX_BYTES) return false;
  const p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!p || typeof p !== 'object' || Array.isArray(p)
    || Object.keys(p).sort().join(',') !== 'chainId,deploymentId,identityId,signature'
    || typeof p.identityId !== 'string' || !/^[1-9][0-9]{0,21}$/.test(p.identityId) || BigInt(p.identityId) >= 2n ** 72n
    || typeof p.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(p.signature)) return false;
  const registry = networks.find(n => n.registry.chainId === p.chainId && n.registry.deploymentId === p.deploymentId)?.registry;
  if (!registry) return false;
  const signer = ethers.verifyMessage(cacheProofPayload(c, p), p.signature);
  const valid = await registry.verifyACKIdentity(signer, BigInt(p.identityId), { signal });
  signal.throwIfAborted();
  return valid;
}
