import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  computeWorkspaceAgentEncryptionKeyProofPayload,
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
    recipients.push(await resolveAgentRecipientKey(store, agentAddress));
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
    `SELECT ?agent ?policy WHERE {
      {
        GRAPH <${cgMeta}> {
          { <${cgData}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent }
          UNION
          { <${cgData}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?agent }
        }
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

    const rawPolicy = stringBinding(row['policy']);
    if (rawPolicy && stripRdfLiteral(rawPolicy) === 'private') {
      hasPrivateAccessPolicy = true;
    }
  }

  return { hasPrivateAccessPolicy, agentAddresses };
}

async function resolveAgentRecipientKey(
  store: TripleStore,
  agentAddress: string,
): Promise<WorkspaceAgentRecipient> {
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

  const validKeys = new Map<string, WorkspaceAgentRecipient>();
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
    validKeys.set(recipientKeyId, {
      purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
      recipientId: agentUri,
      recipientKeyId,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
      agentAddress: checksum,
      peerId: peerId ? stripRdfLiteral(peerId) : undefined,
    });
  }

  if (validKeys.size > 1) {
    throw new Error(`Ambiguous public encryption keys for DKG agent ${checksum}`);
  }
  const [recipient] = validKeys.values();
  if (recipient) {
    return recipient;
  }
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

function stringBinding(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stripRdfLiteral(value: string): string {
  return value
    .replace(/^"/, '')
    .replace(/"(@[a-zA-Z-]+|\^\^<[^>]+>)?$/, '');
}
