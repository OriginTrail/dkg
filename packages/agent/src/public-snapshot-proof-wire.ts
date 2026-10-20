// SPDX-License-Identifier: Apache-2.0
import { isPublicGraphSnapshotScope } from '@origintrail-official/dkg-chain';

export const SNAPSHOT_PROOF_MAX_BYTES = 2048;
export interface SnapshotSourceChallenge {
  version: 1; nonce: string; requesterPeerId: string; responderPeerId: string;
  chainId: string; deploymentId: string; contextGraphId: string; onChainId: string;
}
export interface SnapshotProofFields { identityId: string; signature: string }
const boundedString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;

function decodeObject(bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes.length > SNAPSHOT_PROOF_MAX_BYTES) return null;
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function decodeSnapshotChallenge(bytes: Uint8Array): SnapshotSourceChallenge {
  const c = decodeObject(bytes);
  if (!c || Object.keys(c).sort().join(',') !== 'chainId,contextGraphId,deploymentId,nonce,onChainId,requesterPeerId,responderPeerId,version'
    || c.version !== 1 || !isPublicGraphSnapshotScope(c)
    || typeof c.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(c.nonce)
    || !boundedString(c.chainId) || !boundedString(c.deploymentId)
    || !boundedString(c.requesterPeerId) || !boundedString(c.responderPeerId)) throw new Error('Invalid source challenge');
  return { version: 1, nonce: c.nonce, requesterPeerId: c.requesterPeerId,
    responderPeerId: c.responderPeerId, chainId: c.chainId, deploymentId: c.deploymentId,
    contextGraphId: c.contextGraphId, onChainId: c.onChainId };
}
export function decodeSnapshotProof(bytes: Uint8Array, keys: string): (SnapshotProofFields & Record<string, unknown>) | null {
  const p = decodeObject(bytes);
  if (!p || Object.keys(p).sort().join(',') !== keys
    || typeof p.identityId !== 'string' || !/^[1-9][0-9]{0,21}$/.test(p.identityId) || BigInt(p.identityId) >= 2n ** 72n
    || typeof p.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(p.signature)) return null;
  return { ...p, identityId: p.identityId, signature: p.signature };
}
