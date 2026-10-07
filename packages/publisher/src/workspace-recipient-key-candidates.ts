import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519, WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  decodeWorkspaceEncryptionKey, encodeWorkspaceEncryptionKey, workspaceAgentEncryptionKeyId,
} from '@origintrail-official/dkg-core';
import type { WorkspaceAgentRecipient } from './workspace-agent-recipients.js';
import { verifyAgentEncryptionKeyProof } from './workspace-recipient-key-verification.js';

export const RECIPIENT_KEY_CANDIDATE_LIMIT = 64;
export const RECIPIENT_KEY_HISTORY_PAGE_SIZE = 64;
export const COMPLETE_KEY_ROW_LIMIT = RECIPIENT_KEY_CANDIDATE_LIMIT + 1;
export const COMPLETE_ROUTE_ROW_LIMIT = RECIPIENT_KEY_CANDIDATE_LIMIT * 2 + 1;

export interface PublicKeyCandidate {
  readonly encodedPublicKey: string;
  readonly publicKeyBytes: Uint8Array;
  readonly recipientKeyId: string;
}
export interface PublicKeyRoute { readonly key: string; readonly peerId?: string }

export function decodePublicKeyCandidate(checksum: string, key: string): PublicKeyCandidate | undefined {
  try {
    const publicKeyBytes = decodeWorkspaceEncryptionKey(key);
    if (encodeWorkspaceEncryptionKey(publicKeyBytes) !== key) return undefined;
    return { encodedPublicKey: key, publicKeyBytes, recipientKeyId: workspaceAgentEncryptionKeyId(checksum, publicKeyBytes) };
  } catch { return undefined; }
}

export function candidateRecipient(candidate: PublicKeyCandidate, checksum: string, agentUri: string): WorkspaceAgentRecipient {
  return {
    purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE, recipientId: agentUri,
    recipientKeyId: candidate.recipientKeyId, encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes: candidate.publicKeyBytes, agentAddress: checksum,
  };
}

export function candidateHasProof(candidate: PublicKeyCandidate, checksum: string, proof: string): boolean {
  return verifyAgentEncryptionKeyProof(checksum, candidate.publicKeyBytes, proof);
}

/** Shared peer provenance, peerless suppression and live-route budget for both retrieval strategies. */
export function projectPublicKeyRoutes(
  checksum: string, agentUri: string, candidates: readonly PublicKeyCandidate[],
  routes: readonly PublicKeyRoute[], requiredPeerId?: string,
): Map<string, Map<string | undefined, WorkspaceAgentRecipient>> {
  const byKey = new Map(candidates.map((candidate) => [candidate.encodedPublicKey, candidate]));
  const variants = new Map<string, Map<string | undefined, WorkspaceAgentRecipient>>();
  for (const route of routes) {
    const candidate = byKey.get(route.key);
    if (!candidate) continue;
    if (requiredPeerId !== undefined && route.peerId !== requiredPeerId) {
      throw new Error(`Public encryption key for DKG agent ${checksum} is not bound to the required peer`);
    }
    let peers = variants.get(candidate.recipientKeyId);
    if (!peers) { peers = new Map(); variants.set(candidate.recipientKeyId, peers); }
    const recipient = { ...candidateRecipient(candidate, checksum, agentUri), peerId: route.peerId };
    if (route.peerId === undefined) {
      if (peers.size === 0) peers.set(undefined, recipient);
    } else {
      peers.delete(undefined);
      peers.set(route.peerId, recipient);
    }
  }
  if ([...variants.values()].reduce((count, peers) => count + peers.size, 0) > RECIPIENT_KEY_CANDIDATE_LIMIT) {
    throw new Error(`Too many public encryption-key candidates for DKG agent ${checksum}`);
  }
  return variants;
}
