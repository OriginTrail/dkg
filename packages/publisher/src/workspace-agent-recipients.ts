import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  SYSTEM_CONTEXT_GRAPHS,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  computeWorkspaceAgentEncryptionKeyRevocationPayload,
  contextGraphDataUri,
  contextGraphMetaUri,
  contextGraphSharedMemoryUri,
  decodeWorkspaceEncryptionKey,
  encodeWorkspaceEncryptionKey,
  AGENT_DID_PREFIX,
  toAgentDid,
  workspaceAgentEncryptionKeyId,
  sparqlIri,
  sparqlString,
  tryCanonicalPeerIdString,
  type WorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import { WORKSPACE_RECIPIENT_DEPENDENCIES } from './workspace-recipient-dependencies.js';

const { keyRoute: KEY_ROUTE, access: ACCESS } = WORKSPACE_RECIPIENT_DEPENDENCIES;
const STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT = 64;
const RECIPIENT_KEY_HISTORY_PAGE_SIZE = 64;

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

function nonEmptyAgentAddresses(agentAddresses: readonly string[]): readonly string[] {
  if (agentAddresses.length === 0) {
    throw new TypeError('WorkspaceAgentEncryptionKeyMissingError needs at least one agent address');
  }
  return [...agentAddresses];
}

/**
 * No authenticated workspace encryption key is known on this node for one or
 * more recipient agents: it has neither their signed join requests nor their
 * profiles (#2849). For one agent the message stays the historical one;
 * callers that can fetch the keys read `agentAddresses`.
 */
export class WorkspaceAgentEncryptionKeyMissingError extends Error {
  /** The first agent without a key. */
  readonly agentAddress: string;
  /** Every agent without a key, in recipient order. */
  readonly agentAddresses: readonly string[];

  constructor(agentAddresses: readonly string[], message?: string) {
    const [first, ...rest] = nonEmptyAgentAddresses(agentAddresses);
    super(message ?? (
      `Missing public encryption key for DKG agent ${first}`
      + (rest.length > 0 ? ` (also missing for ${rest.join(', ')})` : '')
    ));
    this.name = 'WorkspaceAgentEncryptionKeyMissingError';
    this.agentAddresses = nonEmptyAgentAddresses(agentAddresses);
    this.agentAddress = this.agentAddresses[0]!;
  }
}

/** Also recognises the error across duplicate module instances. */
export function isWorkspaceAgentEncryptionKeyMissingError(
  error: unknown,
): error is WorkspaceAgentEncryptionKeyMissingError {
  if (error instanceof WorkspaceAgentEncryptionKeyMissingError) return true;
  if (!(error instanceof Error) || error.name !== 'WorkspaceAgentEncryptionKeyMissingError') return false;
  const { agentAddress, agentAddresses } = error as { agentAddress?: unknown; agentAddresses?: unknown };
  return typeof agentAddress === 'string'
    && Array.isArray(agentAddresses)
    && agentAddresses.length > 0
    && agentAddresses.every((address) => typeof address === 'string');
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
export async function resolveWorkspaceAgentRecipientKeys(
  store: TripleStore,
  agentAddress: string,
  options: Readonly<{
    excludeGraphUris?: readonly string[];
    requiredPeerId?: string;
  }> = {},
): Promise<WorkspaceAgentRecipient[]> {
  const checksum = ethers.getAddress(agentAddress);
  // Read the historical checksum-cased subject alongside the canonical shared-core form.
  const agentUri = `${AGENT_DID_PREFIX}${checksum}`;
  const lowerAgentUri = toAgentDid(checksum);
  const agentUriValues = agentUri === lowerAgentUri ? `<${agentUri}>` : `<${agentUri}> <${lowerAgentUri}>`;
  const excludedGraphs = [...new Set(options.excludeGraphUris ?? [])].map(sparqlIri);
  const graphFilter = excludedGraphs.length === 0
    ? ''
    : `FILTER (?g NOT IN (${excludedGraphs.join(', ')}))`;
  // The legacy flat RDF shape keeps every rotated key and proof on the agent
  // subject forever. Scan distinct keys before joining route metadata so an
  // authenticated retired history does not consume the live fanout cap. Each
  // page is fixed-size and keyset-paged (OFFSET would become quadratic and can
  // tear under concurrent appends). Only a wallet-verified revocation earns a
  // history exemption; a bare `revokedAt` marker remains an active/untrusted
  // candidate and therefore consumes the strict 64-key budget.
  const activeKeyCandidates = new Map<string, {
    encodedPublicKey: string;
    publicKeyBytes: Uint8Array;
    recipientKeyId: string;
  }>();
  let sawAnyKeyCandidate = false;
  let sawMalformedKey = false;
  let unretiredKeyCandidateCount = 0;
  const verifiedRetiredKeyIds = new Set<string>();
  let keyCursor: string | undefined;

  while (true) {
    const cursorFilter = keyCursor === undefined
      ? ''
      : `FILTER (?key > ${sparqlString(keyCursor)})`;
    const page = await store.query(
      `SELECT DISTINCT ?key WHERE {
        VALUES ?agentSubject { ${agentUriValues} }
        GRAPH ?g {
          ?agentSubject <${KEY_ROUTE.publicKey}> ?rawKey .
        }
        BIND (STR(?rawKey) AS ?key)
        ${graphFilter}
        ${cursorFilter}
      }
      ORDER BY ?key
      LIMIT ${RECIPIENT_KEY_HISTORY_PAGE_SIZE}`,
    );
    if (page.type !== 'bindings' || page.bindings.length === 0) break;
    sawAnyKeyCandidate = true;

    const decodedPage: Array<{
      encodedPublicKey: string;
      publicKeyBytes?: Uint8Array;
      recipientKeyId?: string;
    }> = [];
    const revocationCandidates = new Map<string, WorkspaceAgentRecipient>();
    for (const row of page.bindings) {
      const publicKey = stringBinding(row['key']);
      const encodedPublicKey = publicKey ? stripRdfLiteral(publicKey) : '';
      let publicKeyBytes: Uint8Array | undefined;
      let recipientKeyId: string | undefined;
      if (encodedPublicKey) {
        try {
          publicKeyBytes = decodeWorkspaceEncryptionKey(encodedPublicKey);
          if (encodeWorkspaceEncryptionKey(publicKeyBytes) !== encodedPublicKey) {
            throw new Error('Non-canonical workspace encryption key');
          }
          recipientKeyId = workspaceAgentEncryptionKeyId(checksum, publicKeyBytes);
          revocationCandidates.set(recipientKeyId, {
            purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
            recipientId: agentUri,
            recipientKeyId,
            encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
            publicKeyBytes,
            agentAddress: checksum,
          });
        } catch {
          // Malformed candidates cannot earn a retirement exemption because a
          // valid revocation proof commits to canonical 32-byte key material.
        }
      }
      decodedPage.push({ encodedPublicKey, publicKeyBytes, recipientKeyId });
    }

    const revokedKeyIds = await loadVerifiedRevokedKeyIds(
      store,
      checksum,
      [...revocationCandidates.values()],
      graphFilter,
    );
    for (const candidate of decodedPage) {
      if (candidate.recipientKeyId && revokedKeyIds.has(candidate.recipientKeyId)) {
        // Count unique cryptographic key ids rather than lexical RDF aliases:
        // one authenticated retirement grants exactly one proof-history credit.
        verifiedRetiredKeyIds.add(candidate.recipientKeyId);
        continue;
      }

      unretiredKeyCandidateCount += 1;
      if (unretiredKeyCandidateCount > STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT) {
        throw new Error(
          `Too many public encryption-key candidates for DKG agent ${checksum}`,
        );
      }
      if (!candidate.publicKeyBytes || !candidate.recipientKeyId) {
        sawMalformedKey = true;
        continue;
      }
      activeKeyCandidates.set(candidate.recipientKeyId, {
        encodedPublicKey: candidate.encodedPublicKey,
        publicKeyBytes: candidate.publicKeyBytes,
        recipientKeyId: candidate.recipientKeyId,
      });
    }

    const lastKey = stringBinding(page.bindings.at(-1)?.['key']);
    const nextCursor = lastKey ? stripRdfLiteral(lastKey) : undefined;
    if (!nextCursor || (keyCursor !== undefined && nextCursor <= keyCursor)) {
      throw new Error(`Non-monotonic public encryption-key history for DKG agent ${checksum}`);
    }
    keyCursor = nextCursor;
    if (page.bindings.length < RECIPIENT_KEY_HISTORY_PAGE_SIZE) break;
  }

  if (!sawAnyKeyCandidate) {
    throw new WorkspaceAgentEncryptionKeyMissingError([checksum]);
  }
  if (activeKeyCandidates.size === 0) {
    if (unretiredKeyCandidateCount === 0 && verifiedRetiredKeyIds.size > 0) {
      throw new Error(`All registered public encryption keys for DKG agent ${checksum} have been revoked`);
    }
    if (sawMalformedKey) {
      throw new Error(`Unverifiable public encryption key for DKG agent ${checksum}`);
    }
    throw new Error(`Missing public encryption key for DKG agent ${checksum}`);
  }

  // Proofs use the same legacy flat shape and therefore have no RDF-level
  // key association. Scan them in bounded keyset pages. Each independently
  // authenticated retired key grants one historical-proof slot; everything
  // else shares the original 64-row active/junk budget. This lets arbitrary
  // valid retire-old history pass while the 65th surplus proof still fails.
  const verifiedProofKeyIds = new Set<string>();
  let proofCandidateCount = 0;
  let proofCursor: string | undefined;
  const proofCandidateLimit = verifiedRetiredKeyIds.size + STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT;
  while (true) {
    const cursorFilter = proofCursor === undefined
      ? ''
      : `FILTER (?proof > ${sparqlString(proofCursor)})`;
    const page = await store.query(
      `SELECT DISTINCT ?proof WHERE {
        VALUES ?agentSubject { ${agentUriValues} }
        GRAPH ?g {
          ?agentSubject <${KEY_ROUTE.proof}> ?rawProof .
        }
        BIND (STR(?rawProof) AS ?proof)
        ${graphFilter}
        ${cursorFilter}
      }
      ORDER BY ?proof
      LIMIT ${RECIPIENT_KEY_HISTORY_PAGE_SIZE}`,
    );
    if (page.type !== 'bindings' || page.bindings.length === 0) break;

    for (const row of page.bindings) {
      const proof = stringBinding(row['proof']);
      if (!proof) continue;
      proofCandidateCount += 1;
      if (proofCandidateCount > proofCandidateLimit) {
        throw new Error(
          `Too many public encryption-key proof candidates for DKG agent ${checksum}`,
        );
      }
      const cleanProof = stripRdfLiteral(proof);
      for (const candidate of activeKeyCandidates.values()) {
        if (verifiedProofKeyIds.has(candidate.recipientKeyId)) continue;
        if (verifyAgentEncryptionKeyProof(checksum, candidate.publicKeyBytes, cleanProof)) {
          verifiedProofKeyIds.add(candidate.recipientKeyId);
          break;
        }
      }
    }

    const lastProof = stringBinding(page.bindings.at(-1)?.['proof']);
    const nextCursor = lastProof ? stripRdfLiteral(lastProof) : undefined;
    if (!nextCursor || (proofCursor !== undefined && nextCursor <= proofCursor)) {
      throw new Error(`Non-monotonic public encryption-key proof history for DKG agent ${checksum}`);
    }
    proofCursor = nextCursor;
    if (page.bindings.length < RECIPIENT_KEY_HISTORY_PAGE_SIZE) break;
  }

  let sawUntrustedOnly = false;
  let sawInvalidProof = false;
  for (const candidate of activeKeyCandidates.values()) {
    if (verifiedProofKeyIds.has(candidate.recipientKeyId)) continue;
    if (proofCandidateCount === 0) sawUntrustedOnly = true;
    else sawInvalidProof = true;
  }

  const proofVerifiedKeys = [...activeKeyCandidates.values()].filter((candidate) => (
    verifiedProofKeyIds.has(candidate.recipientKeyId)
  ));
  if (proofVerifiedKeys.length === 0) {
    if (sawUntrustedOnly) {
      throw new Error(`Untrusted RDF-only public encryption key for DKG agent ${checksum}`);
    }
    if (sawInvalidProof) {
      throw new Error(`Spoofed or unverifiable public encryption key for DKG agent ${checksum}`);
    }
    throw new Error(`Missing public encryption key for DKG agent ${checksum}`);
  }

  // Only proof-verified, unrevoked keys participate in the route join. A key
  // can have one peerless row in addition to its peer-bound rows, so admit that
  // bounded suppression overhead before enforcing the global 64-route fanout.
  const activeKeyValues = proofVerifiedKeys
    .map((candidate) => sparqlString(candidate.encodedPublicKey))
    .join(' ');
  const routeRowLimit = STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT + proofVerifiedKeys.length + 1;
  const result = await store.query(
    `SELECT DISTINCT ?key ?peerId WHERE {
      VALUES ?agentSubject { ${agentUriValues} }
      VALUES ?key { ${activeKeyValues} }
      GRAPH ?g {
        ?agentSubject <${KEY_ROUTE.publicKey}> ?rawKey ;
          <${KEY_ROUTE.algorithm}> ${sparqlString(WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519)} .
        OPTIONAL { ?agentSubject <${KEY_ROUTE.peerId}> ?peerId }
      }
      ${graphFilter}
      FILTER (STR(?rawKey) = ?key)
    }
    LIMIT ${routeRowLimit}`,
  );

  // One wallet-verified key can be replicated in several profile graphs. Keep
  // distinct peer bindings for that key so a later Context Graph allowlist can
  // select the reachable variant. A peer-bound copy supersedes a peerless copy:
  // retaining both would incorrectly make the transport projection incomplete.
  const verifiedKeys = new Map<
    string,
    Map<string | undefined, WorkspaceAgentRecipient>
  >();
  const activeKeyByEncodedValue = new Map(
    proofVerifiedKeys.map((candidate) => [candidate.encodedPublicKey, candidate]),
  );

  if (result.type === 'bindings') for (const row of result.bindings) {
    const publicKey = stringBinding(row['key']);
    const peerId = stringBinding(row['peerId']);
    if (!publicKey) continue;
    const candidate = activeKeyByEncodedValue.get(stripRdfLiteral(publicKey));
    if (!candidate) continue;

    const cleanPeerId = peerId ? stripRdfLiteral(peerId) : undefined;
    if (
      options.requiredPeerId !== undefined
      && cleanPeerId !== options.requiredPeerId
    ) {
      throw new Error(
        `Public encryption key for DKG agent ${checksum} is not bound to the required peer`,
      );
    }

    const { recipientKeyId, publicKeyBytes } = candidate;
    let variants = verifiedKeys.get(recipientKeyId);
    if (variants === undefined) {
      variants = new Map();
      verifiedKeys.set(recipientKeyId, variants);
    }
    const recipient = {
      purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
      recipientId: agentUri,
      recipientKeyId,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
      agentAddress: checksum,
      peerId: cleanPeerId,
    } satisfies WorkspaceAgentRecipient;
    if (cleanPeerId === undefined) {
      // Do not let query ordering replace a usable peer-bound copy with the
      // same key discovered in a graph that omitted peer provenance.
      if (variants.size === 0) variants.set(undefined, recipient);
      continue;
    }
    variants.delete(undefined);
    variants.set(cleanPeerId, recipient);
  }

  const routeCount = [...verifiedKeys.values()].reduce((count, variants) => count + variants.size, 0);
  if (
    routeCount > STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT
    || (result.type === 'bindings' && result.bindings.length >= routeRowLimit)
  ) {
    throw new Error(
      `Too many public encryption-key candidates for DKG agent ${checksum}`,
    );
  }

  if (verifiedKeys.size === 0) {
    const wrongAlgorithm = await store.query(
      `ASK {
        VALUES ?agentSubject { ${agentUriValues} }
        VALUES ?key { ${activeKeyValues} }
        GRAPH ?g {
          ?agentSubject <${KEY_ROUTE.publicKey}> ?rawKey ;
            <${KEY_ROUTE.algorithm}> ?algorithm .
        }
        ${graphFilter}
        FILTER (
          STR(?rawKey) = ?key
          && STR(?algorithm) != ${sparqlString(WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519)}
        )
      }`,
    );
    if (wrongAlgorithm.type === 'boolean' && wrongAlgorithm.value) {
      throw new Error(`Unsupported public encryption key algorithm for DKG agent ${checksum}; expected X25519`);
    }
    throw new Error(`Untrusted RDF-only public encryption key for DKG agent ${checksum}`);
  }

  const verifiedRecipients = [...verifiedKeys.values()].flatMap((variants) => (
    [...variants.values()]
  ));
  const revokedKeyIds = await loadVerifiedRevokedKeyIds(
    store,
    checksum,
    verifiedRecipients,
    graphFilter,
  );
  for (const id of revokedKeyIds) {
    // Revocation is keyed by recipientKeyId, not by transport provenance, so
    // retiring a key removes every peer-bound variant at once.
    verifiedKeys.delete(id);
  }

  if (verifiedKeys.size === 0) {
    throw new Error(`All registered public encryption keys for DKG agent ${checksum} have been revoked`);
  }

  return [...verifiedKeys.values()].flatMap((variants) => [...variants.values()]);
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
  graphFilter = '',
): Promise<Set<string>> {
  const revoked = new Set<string>();
  if (candidates.length === 0) return revoked;
  const candidatesByKey = new Map<string, WorkspaceAgentRecipient>();
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
