// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';

export const PUBLIC_SNAPSHOT_SOURCE_PROTOCOL = '/dkg/10.0.0/public-snapshot-source/1';
export { SNAPSHOT_PROOF_MAX_BYTES as PUBLIC_SNAPSHOT_SOURCE_MAX_BYTES } from './public-snapshot-proof-wire.js';
export const BASE_MAINNET_SOURCE_POLICY = 'base-mainnet-registered-cores' as const;

import { decodeSnapshotChallenge, decodeSnapshotProof, encodeSnapshotProof,
  type SnapshotSourceChallenge, type SnapshotProofCodec, type UnsignedSnapshotProof } from './public-snapshot-proof-wire.js';
export type { SnapshotSourceChallenge } from './public-snapshot-proof-wire.js';

export function sourceProofPayload(challenge: SnapshotSourceChallenge, identityId: string): Uint8Array {
  // Fixed ordering and domain separation: a signature cannot be reused as a
  // publish/ACK, for another graph, requester, peer, nonce, or deployment.
  return ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify([
    PUBLIC_SNAPSHOT_SOURCE_PROTOCOL, challenge.version, challenge.nonce,
    challenge.requesterPeerId, challenge.responderPeerId, challenge.chainId,
    challenge.deploymentId, challenge.contextGraphId, challenge.onChainId, identityId,
  ]))));
}

export function sourceProofCodec(challenge: SnapshotSourceChallenge): SnapshotProofCodec<UnsignedSnapshotProof> {
  return { payload: proof => sourceProofPayload(challenge, proof.identityId),
    encode: (proof, signature) => encodeSnapshotProof({ ...proof, signature }) };
}

export function decodeSourceChallenge(bytes: Uint8Array): SnapshotSourceChallenge {
  const c = decodeSnapshotChallenge(bytes);
  if (c.chainId !== 'base:8453' || c.deploymentId.length > 128 || !c.deploymentId.startsWith('base:8453:hub='))
    throw new Error('Invalid source challenge');
  return c;
}

export async function verifySourceProof(
  bytes: Uint8Array, challenge: SnapshotSourceChallenge,
  verify: NonNullable<ChainAdapter['verifyACKIdentity']>, signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const proof = decodeSnapshotProof(bytes);
  if (!proof) return false;
  const signer = ethers.verifyMessage(sourceProofPayload(challenge, proof.identityId), proof.signature);
  // This checks the signing operational key AND active ShardingTable membership.
  // A wallet address copied into an unsigned phonebook profile proves neither.
  const valid = await verify(signer, BigInt(proof.identityId), { signal });
  signal.throwIfAborted();
  return valid;
}
