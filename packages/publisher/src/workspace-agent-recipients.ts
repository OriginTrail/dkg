import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  computeWorkspaceAgentEncryptionKeyRevocationPayload,
  contextGraphDataUri,
  contextGraphMetaUri,
  contextGraphSharedMemoryUri,
  decodeWorkspaceEncryptionKey,
  workspaceAgentEncryptionKeyId,
  type WorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

const DKG = 'https://dkg.network/ontology#';
const DKG_PUBLIC_ENCRYPTION_KEY = `${DKG}publicEncryptionKey`;
const DKG_ENCRYPTION_KEY_ALGORITHM = `${DKG}encryptionKeyAlgorithm`;
const DKG_ENCRYPTION_KEY_PROOF = `${DKG}encryptionKeyProof`;
const DKG_PEER_ID = `${DKG}peerId`;

export interface WorkspaceAgentRecipient extends WorkspaceRecipientEncryptionKey {
  agentAddress: string;
  peerId?: string;
}

export interface WorkspaceAgentRecipientResolution {
  requiresEncryption: boolean;
  recipients: WorkspaceAgentRecipient[];
}

export interface WorkspaceAgentRecipientResolverInput {
  contextGraphId: string;
}

export type WorkspaceAgentRecipientResolver = (
  input: WorkspaceAgentRecipientResolverInput,
) => Promise<WorkspaceAgentRecipientResolution>;

export async function resolveWorkspaceAgentRecipients(
  store: TripleStore,
  input: WorkspaceAgentRecipientResolverInput,
): Promise<WorkspaceAgentRecipientResolution> {
  const access = await getWorkspaceAccessMetadata(store, input.contextGraphId);
  const requiresEncryption = access.hasPrivateAccessPolicy || access.agentAddresses.length > 0;
  if (!requiresEncryption) {
    return { requiresEncryption: false, recipients: [] };
  }

  if (access.agentAddresses.length === 0) {
    throw new Error(
      `Context graph "${input.contextGraphId}" requires encrypted SWM gossip but declares no ` +
      'DKG_ALLOWED_AGENT or DKG_PARTICIPANT_AGENT recipients',
    );
  }

  const recipients: WorkspaceAgentRecipient[] = [];
  for (const agentAddress of access.agentAddresses) {
    const agentRecipients = await resolveAgentRecipientKeys(store, agentAddress);
    recipients.push(...agentRecipients);
  }
  return { requiresEncryption: true, recipients };
}

async function getWorkspaceAccessMetadata(
  store: TripleStore,
  contextGraphId: string,
): Promise<{
  hasPrivateAccessPolicy: boolean;
  agentAddresses: string[];
}> {
  const cgData = contextGraphDataUri(contextGraphId);
  const cgMeta = contextGraphMetaUri(contextGraphId);
  const ontologyGraph = contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
  const swmGraph = contextGraphSharedMemoryUri(contextGraphId);
  const result = await store.query(
    `SELECT ?agent ?policy ?revoked WHERE {
      {
        GRAPH <${cgMeta}> {
          { <${cgData}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent }
          UNION
          { <${cgData}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?agent }
        }
      } UNION {
        GRAPH <${cgMeta}> { <${cgData}> <${DKG_ONTOLOGY.DKG_REVOKED_AGENT}> ?revoked }
      } UNION {
        GRAPH <${cgMeta}> { <${cgData}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy }
      } UNION {
        GRAPH <${ontologyGraph}> { <${cgData}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy }
      } UNION {
        GRAPH <${swmGraph}> { <${cgData}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy }
      }
    }`,
  );
  if (result.type !== 'bindings') {
    return { hasPrivateAccessPolicy: false, agentAddresses: [] };
  }

  const seen = new Set<string>();
  const agentAddresses: string[] = [];
  // Local tombstones for agents revoked from this CG. The recipient
  // resolver MUST subtract these from the union of allowed/participant
  // agents — otherwise a peer-sync round that re-replicates a removed
  // agent's `dkg:allowedAgent` triple would silently re-include them
  // in the next sender-key wrap, leaking post-revoke writes back to a
  // kicked member. See `removeAgentFromContextGraph` for the write
  // side and OT-RFC-38 LU-4 (sender-key rotation on membership change).
  const revokedAddresses = new Set<string>();
  let hasPrivateAccessPolicy = false;
  for (const row of result.bindings) {
    const rawAgent = stringBinding(row['agent']);
    if (rawAgent) {
      const value = stripRdfLiteral(rawAgent);
      if (!ethers.isAddress(value)) {
        throw new Error(`Invalid DKG agent recipient "${value}" in context graph "${contextGraphId}"`);
      }
      const checksum = ethers.getAddress(value);
      const key = checksum.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        agentAddresses.push(checksum);
      }
    }

    const rawRevoked = stringBinding(row['revoked']);
    if (rawRevoked) {
      const value = stripRdfLiteral(rawRevoked);
      if (ethers.isAddress(value)) {
        revokedAddresses.add(value.toLowerCase());
      }
    }

    const rawPolicy = stringBinding(row['policy']);
    if (rawPolicy && stripRdfLiteral(rawPolicy) === 'private') {
      hasPrivateAccessPolicy = true;
    }
  }

  if (revokedAddresses.size > 0) {
    const filtered = agentAddresses.filter((addr) => !revokedAddresses.has(addr.toLowerCase()));
    return { hasPrivateAccessPolicy, agentAddresses: filtered };
  }

  return { hasPrivateAccessPolicy, agentAddresses };
}

/**
 * Resolve every valid (non-revoked) workspace encryption key registered for a DKG
 * agent.
 *
 * Each agent MAY hold multiple X25519 public encryption keys at once (e.g. mid-
 * rotation, after a custodial daemon re-mint on a node that had never run before,
 * or while different daemons converge on a freshly published key). Each key is
 * authenticated by an EIP-191 signature from the agent's wallet against
 * `computeWorkspaceAgentEncryptionKeyProofPayload`; we MUST encrypt the SWM
 * payload to every authenticated key, otherwise some legitimate recipient daemon
 * will hold a private half that doesn't match any wrapped slot and decryption
 * will fail there.
 *
 * Keys can be explicitly retired by emitting wallet-signed revocation triples on
 * the key URI (`dkg:revokedAt`, `dkg:revokedBy`, `dkg:encryptionKeyRevocationProof`
 * over `computeWorkspaceAgentEncryptionKeyRevocationPayload`). A revocation is
 * honoured only when the proof ecrecovers to the agent's wallet; bogus revocation
 * triples are ignored so they can't be used to brick an honest peer's key.
 */
async function resolveAgentRecipientKeys(
  store: TripleStore,
  agentAddress: string,
): Promise<WorkspaceAgentRecipient[]> {
  const checksum = ethers.getAddress(agentAddress);
  const agentUri = `did:dkg:agent:${checksum}`;
  const lowerAgentUri = `did:dkg:agent:${checksum.toLowerCase()}`;
  const agentUriValues = agentUri === lowerAgentUri ? `<${agentUri}>` : `<${agentUri}> <${lowerAgentUri}>`;
  const result = await store.query(
    `SELECT ?key ?algorithm ?proof ?peerId WHERE {
      VALUES ?agentSubject { ${agentUriValues} }
      GRAPH ?g {
        ?agentSubject <${DKG_PUBLIC_ENCRYPTION_KEY}> ?key .
        OPTIONAL { ?agentSubject <${DKG_ENCRYPTION_KEY_ALGORITHM}> ?algorithm }
        OPTIONAL { ?agentSubject <${DKG_ENCRYPTION_KEY_PROOF}> ?proof }
        OPTIONAL { ?agentSubject <${DKG_PEER_ID}> ?peerId }
      }
    }`,
  );

  if (result.type !== 'bindings' || result.bindings.length === 0) {
    throw new Error(`Missing public encryption key for DKG agent ${checksum}`);
  }

  const verifiedKeys = new Map<string, WorkspaceAgentRecipient>();
  let sawWrongAlgorithm = false;
  let sawUntrustedOnly = false;
  let sawInvalidProof = false;

  for (const row of result.bindings) {
    const publicKey = stringBinding(row['key']);
    const algorithm = stringBinding(row['algorithm']);
    const proof = stringBinding(row['proof']);
    const peerId = stringBinding(row['peerId']);
    if (!publicKey || !algorithm || !proof) {
      sawUntrustedOnly = true;
      continue;
    }

    const cleanAlgorithm = stripRdfLiteral(algorithm);
    if (cleanAlgorithm !== WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519) {
      sawWrongAlgorithm = true;
      continue;
    }

    let publicKeyBytes: Uint8Array;
    try {
      publicKeyBytes = decodeWorkspaceEncryptionKey(stripRdfLiteral(publicKey));
    } catch (err) {
      throw new Error(
        `Unverifiable public encryption key for DKG agent ${checksum}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const cleanProof = stripRdfLiteral(proof);
    const verified = verifyAgentEncryptionKeyProof(checksum, publicKeyBytes, cleanProof);
    if (!verified) {
      sawInvalidProof = true;
      continue;
    }

    const recipientKeyId = workspaceAgentEncryptionKeyId(checksum, publicKeyBytes);
    if (verifiedKeys.has(recipientKeyId)) continue;
    verifiedKeys.set(recipientKeyId, {
      purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
      recipientId: agentUri,
      recipientKeyId,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
      agentAddress: checksum,
      peerId: peerId ? stripRdfLiteral(peerId) : undefined,
    });
  }

  if (verifiedKeys.size === 0) {
    if (sawUntrustedOnly) {
      throw new Error(`Untrusted RDF-only public encryption key for DKG agent ${checksum}`);
    }
    if (sawWrongAlgorithm) {
      throw new Error(`Unsupported public encryption key algorithm for DKG agent ${checksum}; expected X25519`);
    }
    if (sawInvalidProof) {
      throw new Error(`Spoofed or unverifiable public encryption key for DKG agent ${checksum}`);
    }
    throw new Error(`Missing public encryption key for DKG agent ${checksum}`);
  }

  const revokedKeyIds = await loadVerifiedRevokedKeyIds(store, checksum, [...verifiedKeys.values()]);
  for (const id of revokedKeyIds) {
    verifiedKeys.delete(id);
  }

  if (verifiedKeys.size === 0) {
    throw new Error(`All registered public encryption keys for DKG agent ${checksum} have been revoked`);
  }

  return [...verifiedKeys.values()];
}

/**
 * Fetch revocation triples for the candidate keys and return the subset whose
 * `encryptionKeyRevocationProof` ecrecovers to the agent's wallet. Bogus
 * revocations (missing proof, wrong signer, malformed payload) are dropped so
 * an attacker cannot brick an honest key by writing junk into shared memory.
 */
async function loadVerifiedRevokedKeyIds(
  store: TripleStore,
  agentAddress: string,
  candidates: readonly WorkspaceAgentRecipient[],
): Promise<Set<string>> {
  const revoked = new Set<string>();
  if (candidates.length === 0) return revoked;
  const valuesList = candidates.map((c) => `<${c.recipientKeyId}>`).join(' ');
  const result = await store.query(
    `SELECT ?keyId ?revokedAt ?revocationProof WHERE {
      VALUES ?keyId { ${valuesList} }
      GRAPH ?g {
        ?keyId <${DKG_ONTOLOGY.DKG_REVOKED_AT}> ?revokedAt .
        OPTIONAL { ?keyId <${DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_REVOCATION_PROOF}> ?revocationProof }
      }
    }`,
  );
  if (result.type !== 'bindings') return revoked;

  const byKey = new Map<string, WorkspaceAgentRecipient>();
  for (const c of candidates) byKey.set(c.recipientKeyId, c);

  for (const row of result.bindings) {
    const keyId = stringBinding(row['keyId']);
    const revokedAt = stringBinding(row['revokedAt']);
    const revocationProof = stringBinding(row['revocationProof']);
    if (!keyId || !revokedAt || !revocationProof) continue;
    const candidate = byKey.get(keyId);
    if (!candidate) continue;
    const verified = verifyAgentEncryptionKeyRevocation(
      agentAddress,
      candidate.publicKeyBytes!,
      stripRdfLiteral(revokedAt),
      stripRdfLiteral(revocationProof),
    );
    if (verified) revoked.add(keyId);
  }
  return revoked;
}

function verifyAgentEncryptionKeyProof(
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

function stringBinding(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stripRdfLiteral(value: string): string {
  return value
    .replace(/^"/, '')
    .replace(/"(@[a-zA-Z-]+|\^\^<[^>]+>)?$/, '');
}
