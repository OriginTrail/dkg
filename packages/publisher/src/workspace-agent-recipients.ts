import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  SYSTEM_CONTEXT_GRAPHS,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  contextGraphDataUri,
  contextGraphMetaUri,
  contextGraphSharedMemoryUri,
  tryCanonicalPeerIdString,
  type WorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import { resolveWorkspaceAgentRecipientKeys } from './workspace-agent-recipient-keys.js';
export { resolveWorkspaceAgentRecipientKeys } from './workspace-agent-recipient-keys.js';

import { WorkspaceAgentEncryptionKeyMissingError, isWorkspaceAgentEncryptionKeyMissingError } from './workspace-recipient-key-errors.js';
export { WorkspaceAgentEncryptionKeyMissingError, isWorkspaceAgentEncryptionKeyMissingError } from './workspace-recipient-key-errors.js';

import { WORKSPACE_RECIPIENT_DEPENDENCIES } from './workspace-recipient-dependencies.js';

const { access: ACCESS } = WORKSPACE_RECIPIENT_DEPENDENCIES;

export interface WorkspaceAgentRecipient {
  readonly purpose: WorkspaceRecipientEncryptionKey['purpose'];
  readonly recipientId: string;
  readonly recipientKeyId: string;
  readonly encryptionKeyAlgorithm: WorkspaceRecipientEncryptionKey['encryptionKeyAlgorithm'];
  readonly publicKeyBytes?: Uint8Array;
  readonly privateKeyBytes?: Uint8Array;
  readonly agentAddress: string;
  readonly peerId?: string;
}

export type WorkspaceAgentRecipientResolution =
  | {
    readonly requiresEncryption: false;
    readonly recipients: readonly [];
  }
  | {
    readonly requiresEncryption: true;
    readonly recipients: readonly [
      WorkspaceAgentRecipient,
      ...WorkspaceAgentRecipient[],
    ];
  };

function isWorkspaceAgentRecipient(value: unknown): value is WorkspaceAgentRecipient {
  if (typeof value !== 'object' || value === null) return false;
  const recipient = value as Record<string, unknown>;
  return recipient['purpose'] === WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE
    && typeof recipient['recipientId'] === 'string'
    && typeof recipient['recipientKeyId'] === 'string'
    && recipient['encryptionKeyAlgorithm'] === WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519
    && (recipient['publicKeyBytes'] === undefined || recipient['publicKeyBytes'] instanceof Uint8Array)
    && (recipient['privateKeyBytes'] === undefined || recipient['privateKeyBytes'] instanceof Uint8Array)
    && typeof recipient['agentAddress'] === 'string'
    && (recipient['peerId'] === undefined || typeof recipient['peerId'] === 'string');
}

function ownWorkspaceAgentRecipient(
  recipient: WorkspaceAgentRecipient,
): WorkspaceAgentRecipient {
  return Object.freeze({
    purpose: recipient.purpose,
    recipientId: recipient.recipientId,
    recipientKeyId: recipient.recipientKeyId,
    encryptionKeyAlgorithm: recipient.encryptionKeyAlgorithm,
    publicKeyBytes: recipient.publicKeyBytes === undefined
      ? undefined
      : Uint8Array.from(recipient.publicKeyBytes),
    privateKeyBytes: recipient.privateKeyBytes === undefined
      ? undefined
      : Uint8Array.from(recipient.privateKeyBytes),
    agentAddress: recipient.agentAddress,
    peerId: recipient.peerId,
  });
}

/**
 * Validate resolver output at the publisher injection boundary. Runtime callers
 * can bypass the TypeScript contract, so normalize the two valid arms here and
 * keep the rest of the encrypted path impossible to enter with an empty roster.
 * This intentionally remains an internal module export rather than a second
 * public refinement API.
 */
export function parseWorkspaceAgentRecipientResolution(
  value: unknown,
  contextGraphId: string,
): WorkspaceAgentRecipientResolution {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`Context graph "${contextGraphId}" recipient resolver returned an invalid result`);
  }
  const resolution = value as Record<string, unknown>;
  if (typeof resolution['requiresEncryption'] !== 'boolean' || !Array.isArray(resolution['recipients'])) {
    throw new TypeError(`Context graph "${contextGraphId}" recipient resolver returned an invalid result`);
  }
  const recipients = resolution['recipients'];
  if (!resolution['requiresEncryption']) {
    if (recipients.length !== 0) {
      throw new TypeError(
        `Context graph "${contextGraphId}" recipient resolver returned recipients while encryption is disabled`,
      );
    }
    const noRecipients: [] = [];
    return Object.freeze({
      requiresEncryption: false,
      recipients: Object.freeze(noRecipients),
    });
  }
  if (recipients.length === 0) {
    throw new Error(`Context graph "${contextGraphId}" requires encrypted SWM gossip but has no valid DKG agent recipients`);
  }
  if (!recipients.every(isWorkspaceAgentRecipient)) {
    throw new TypeError(`Context graph "${contextGraphId}" recipient resolver returned an invalid DKG agent recipient`);
  }
  const [firstRecipient, ...remainingRecipients] = recipients.map(ownWorkspaceAgentRecipient);
  const ownedRecipients: [WorkspaceAgentRecipient, ...WorkspaceAgentRecipient[]] = [
    firstRecipient,
    ...remainingRecipients,
  ];
  return Object.freeze({
    requiresEncryption: true,
    recipients: Object.freeze(ownedRecipients),
  });
}

export interface WorkspaceAgentRecipientFanoutSnapshot {
  readonly source: 'agent-roster';
  /** Remote transport peers from the validated encryption recipient snapshot. */
  readonly members: readonly string[];
  /**
   * True only when every authorized agent has at least one advertised peer
   * (including this node). An incomplete projection must keep GossipSub as a
   * compatibility fallback; the reliable leg alone cannot reach the agents
   * whose profile has no usable peer id.
   */
  readonly complete: boolean;
}

/**
 * Project a validated encryption snapshot to its reliable transport roster
 * while retaining whether the projection covers every authorized agent.
 */
export function projectWorkspaceAgentRecipientFanout(
  resolution: Extract<WorkspaceAgentRecipientResolution, { readonly requiresEncryption: true }>,
  selfPeerId?: string,
): WorkspaceAgentRecipientFanoutSnapshot {
  const peers = new Set<string>();
  const agentsWithPeer = new Set<string>();
  const authorizedAgents = new Set<string>();
  const canonicalSelfPeerId = tryCanonicalPeerIdString(selfPeerId ?? '');
  for (const recipient of resolution.recipients) {
    const agentAddress = recipient.agentAddress?.trim().toLowerCase() ?? '';
    if (agentAddress) authorizedAgents.add(agentAddress);

    const peerId = tryCanonicalPeerIdString(recipient.peerId ?? '');
    if (!peerId) continue;
    if (agentAddress) agentsWithPeer.add(agentAddress);
    if (peerId !== canonicalSelfPeerId) peers.add(peerId);
  }

  return {
    source: 'agent-roster',
    members: [...peers],
    complete: authorizedAgents.size > 0 && agentsWithPeer.size === authorizedAgents.size,
  };
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
    return parseWorkspaceAgentRecipientResolution(
      { requiresEncryption: false, recipients: [] },
      input.contextGraphId,
    );
  }

  if (access.agentAddresses.length === 0) {
    throw new Error(
      `Context graph "${input.contextGraphId}" requires encrypted SWM gossip but declares no ` +
      'DKG_ALLOWED_AGENT or DKG_PARTICIPANT_AGENT recipients',
    );
  }

  const recipients: WorkspaceAgentRecipient[] = [];
  // Name every recipient without a key at once, so a caller can fetch them
  // together (#2849). Any other key failure still stops here.
  const missingKeys: string[] = [];
  for (const agentAddress of access.agentAddresses) {
    try {
      recipients.push(...await resolveWorkspaceAgentRecipientKeys(store, agentAddress));
    } catch (error) {
      if (!isWorkspaceAgentEncryptionKeyMissingError(error)) throw error;
      missingKeys.push(...error.agentAddresses);
    }
  }
  if (missingKeys.length > 0) throw new WorkspaceAgentEncryptionKeyMissingError(missingKeys);
  const [firstRecipient, ...remainingRecipients] = recipients;
  if (!firstRecipient) {
    throw new Error(`Context graph "${input.contextGraphId}" requires encrypted SWM gossip but has no valid DKG agent recipients`);
  }
  return parseWorkspaceAgentRecipientResolution(
    {
      requiresEncryption: true,
      recipients: [firstRecipient, ...remainingRecipients],
    },
    input.contextGraphId,
  );
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
  const agentsGraph = contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
  const swmGraph = contextGraphSharedMemoryUri(contextGraphId);
  // Flattened UNION: Blazegraph rejects nested UnionNode inside a
  // GRAPH block that is itself a UNION branch. Semantically identical
  // rewrite with one GRAPH-per-branch instead of UNION-inside-GRAPH.
  const result = await store.query(
    `SELECT ?agent ?policy ?revoked WHERE {
      {
        GRAPH <${cgMeta}> { <${cgData}> <${ACCESS.allowedAgent}> ?agent }
      } UNION {
        GRAPH <${cgMeta}> { <${cgData}> <${ACCESS.participantAgent}> ?agent }
      } UNION {
        GRAPH <${cgMeta}> { <${cgData}> <${ACCESS.revokedAgent}> ?revoked }
      } UNION {
        GRAPH <${cgMeta}> { <${cgData}> <${ACCESS.policy}> ?policy }
      } UNION {
        GRAPH <${ontologyGraph}> { <${cgData}> <${ACCESS.policy}> ?policy }
      } UNION {
        GRAPH <${agentsGraph}> { <${cgData}> <${ACCESS.allowedAgent}> ?agent }
      } UNION {
        GRAPH <${agentsGraph}> { <${cgData}> <${ACCESS.participantAgent}> ?agent }
      } UNION {
        GRAPH <${agentsGraph}> { <${cgData}> <${ACCESS.revokedAgent}> ?revoked }
      } UNION {
        GRAPH <${agentsGraph}> { <${cgData}> <${ACCESS.policy}> ?policy }
      } UNION {
        GRAPH <${swmGraph}> { <${cgData}> <${ACCESS.policy}> ?policy }
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

function stringBinding(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stripRdfLiteral(value: string): string {
  return value
    .replace(/^"/, '')
    .replace(/"(@[a-zA-Z-]+|\^\^<[^>]+>)?$/, '');
}
