import type { TripleStore } from '@origintrail-official/dkg-storage';
import { WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519, computeWorkspaceAgentEncryptionKeyProofPayload, computeWorkspaceAgentEncryptionKeyRevocationPayload } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { WORKSPACE_RECIPIENT_DEPENDENCIES } from './workspace-recipient-dependencies.js';

const { keyRoute: KEY_ROUTE } = WORKSPACE_RECIPIENT_DEPENDENCIES;
const STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT = 64;

export interface EncryptionKeyMaterial {
  readonly recipientKeyId: string;
  readonly publicKeyBytes: Uint8Array;
}

/**
 * Fetch revocation triples for the candidate keys and return the subset whose
 * `encryptionKeyRevocationProof` ecrecovers to the agent's wallet. Bogus
 * revocations (missing proof, wrong signer, malformed payload) are dropped so
 * an attacker cannot brick an honest key by writing junk into shared memory.
 */
export async function loadVerifiedRevokedKeyIds(
  store: TripleStore,
  agentAddress: string,
  candidates: readonly EncryptionKeyMaterial[],
  graphFilter = '',
): Promise<Set<string>> {
  const revoked = new Set<string>();
  if (candidates.length === 0) return revoked;
  const candidatesByKey = new Map<string, EncryptionKeyMaterial>();
  for (const candidate of candidates) candidatesByKey.set(candidate.recipientKeyId, candidate);
  const valuesList = [...candidatesByKey.keys()].map((keyId) => `<${keyId}>`).join(' ');
  const revocationRowLimit = candidatesByKey.size + STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT + 1;
  const result = await store.query(
    `SELECT DISTINCT ?keyId ?revokedAt ?revocationProof WHERE {
      VALUES ?keyId { ${valuesList} }
      GRAPH ?g {
        ?keyId <${KEY_ROUTE.revokedAt}> ?revokedAt .
        OPTIONAL { ?keyId <${KEY_ROUTE.revocationProof}> ?revocationProof }
      }
      ${graphFilter}
    }
    LIMIT ${revocationRowLimit}`,
  );
  if (result.type !== 'bindings') return revoked;
  if (result.bindings.length >= revocationRowLimit) {
    throw new Error(`Too many encryption-key revocation candidates for DKG agent ${agentAddress}`);
  }

  for (const row of result.bindings) {
    const keyId = stringBinding(row['keyId']);
    const revokedAt = stringBinding(row['revokedAt']);
    const revocationProof = stringBinding(row['revocationProof']);
    if (!keyId || !revokedAt || !revocationProof) continue;
    const candidate = candidatesByKey.get(keyId);
    if (!candidate) continue;
    const verified = verifyAgentEncryptionKeyRevocation(
      agentAddress,
      candidate.publicKeyBytes,
      stripRdfLiteral(revokedAt),
      stripRdfLiteral(revocationProof),
    );
    if (verified) revoked.add(keyId);
  }
  return revoked;
}

export function verifyAgentEncryptionKeyProof(
  agentAddress: string,
  publicKeyBytes: Uint8Array,
  proof: string,
): boolean {
  try {
    const payload = computeWorkspaceAgentEncryptionKeyProofPayload({
      agentAddress,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
    });
    const recovered = ethers.verifyMessage(payload, proof);
    return recovered.toLowerCase() === agentAddress.toLowerCase();
  } catch {
    return false;
  }
}

function verifyAgentEncryptionKeyRevocation(
  agentAddress: string,
  publicKeyBytes: Uint8Array,
  revokedAt: string,
  revocationProof: string,
): boolean {
  try {
    const payload = computeWorkspaceAgentEncryptionKeyRevocationPayload({
      agentAddress,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
      revokedAt,
    });
    const recovered = ethers.verifyMessage(payload, revocationProof);
    return recovered.toLowerCase() === agentAddress.toLowerCase();
  } catch {
    return false;
  }
}

export function stringBinding(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function stripRdfLiteral(value: string): string {
  return value
    .replace(/^"/, '')
    .replace(/"(@[a-zA-Z-]+|\^\^<[^>]+>)?$/, '');
}
