// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import { isPublicGraphSnapshotScope, type ChainAdapter } from '@origintrail-official/dkg-chain';

export const PUBLIC_SNAPSHOT_SOURCE_PROTOCOL = '/dkg/10.0.0/public-snapshot-source/1';
export const PUBLIC_SNAPSHOT_SOURCE_MAX_BYTES = 2048;
export const BASE_MAINNET_SOURCE_POLICY = 'base-mainnet-registered-cores' as const;

export interface SnapshotSourceChallenge {
  version: 1;
  nonce: string;
  requesterPeerId: string;
  responderPeerId: string;
  chainId: string;
  deploymentId: string;
  contextGraphId: string;
  onChainId: string;
}

export function sourceProofPayload(challenge: SnapshotSourceChallenge, identityId: string): Uint8Array {
  // Fixed ordering and domain separation: a signature cannot be reused as a
  // publish/ACK, for another graph, requester, peer, nonce, or deployment.
  return ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify([
    PUBLIC_SNAPSHOT_SOURCE_PROTOCOL, challenge.version, challenge.nonce,
    challenge.requesterPeerId, challenge.responderPeerId, challenge.chainId,
    challenge.deploymentId, challenge.contextGraphId, challenge.onChainId, identityId,
  ]))));
}

export function decodeSourceChallenge(bytes: Uint8Array): SnapshotSourceChallenge {
  if (bytes.length > PUBLIC_SNAPSHOT_SOURCE_MAX_BYTES) throw new Error('Invalid source challenge');
  const c = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!c || Array.isArray(c) || typeof c !== 'object'
    || Object.keys(c).sort().join(',') !== 'chainId,contextGraphId,deploymentId,nonce,onChainId,requesterPeerId,responderPeerId,version'
    || c.version !== 1 || !isPublicGraphSnapshotScope(c)
    || typeof c.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(c.nonce)
    || c.chainId !== 'base:8453'
    || typeof c.deploymentId !== 'string' || c.deploymentId.length > 128
    || !c.deploymentId.startsWith('base:8453:hub=')
    || [c.requesterPeerId, c.responderPeerId].some(p => typeof p !== 'string' || !p || p.length > 256))
    throw new Error('Invalid source challenge');
  return c;
}

export async function verifySourceProof(
  bytes: Uint8Array, challenge: SnapshotSourceChallenge,
  verify: NonNullable<ChainAdapter['verifyACKIdentity']>, signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  if (bytes.length > PUBLIC_SNAPSHOT_SOURCE_MAX_BYTES) return false;
  const proof = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)
    || Object.keys(proof).sort().join(',') !== 'identityId,signature'
    || typeof proof.identityId !== 'string' || !/^[1-9][0-9]{0,21}$/.test(proof.identityId)
    || BigInt(proof.identityId) >= 2n ** 72n
    || typeof proof.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(proof.signature)) return false;
  const signer = ethers.verifyMessage(sourceProofPayload(challenge, proof.identityId), proof.signature);
  // This checks the signing operational key AND active ShardingTable membership.
  // A wallet address copied into an unsigned phonebook profile proves neither.
  const valid = await verify(signer, BigInt(proof.identityId), { signal });
  signal.throwIfAborted();
  return valid;
}
