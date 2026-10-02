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
  AGENT_DID_PREFIX,
  toAgentDid,
  workspaceAgentEncryptionKeyId,
  sparqlIri,
  tryCanonicalPeerIdString,
  type WorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

const DKG = 'https://dkg.network/ontology#';
const DKG_PUBLIC_ENCRYPTION_KEY = `${DKG}publicEncryptionKey`;
const DKG_ENCRYPTION_KEY_ALGORITHM = `${DKG}encryptionKeyAlgorithm`;
const DKG_ENCRYPTION_KEY_PROOF = `${DKG}encryptionKeyProof`;
const DKG_PEER_ID = `${DKG}peerId`;
const STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT = 64;

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
        GRAPH <${cgMeta}> { <${cgData}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent }
      } UNION {
        GRAPH <${cgMeta}> { <${cgData}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?agent }
      } UNION {
        GRAPH <${cgMeta}> { <${cgData}> <${DKG_ONTOLOGY.DKG_REVOKED_AGENT}> ?revoked }
      } UNION {
        GRAPH <${cgMeta}> { <${cgData}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy }
      } UNION {
        GRAPH <${ontologyGraph}> { <${cgData}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy }
      } UNION {
        GRAPH <${agentsGraph}> { <${cgData}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent }
      } UNION {
        GRAPH <${agentsGraph}> { <${cgData}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?agent }
      } UNION {
        GRAPH <${agentsGraph}> { <${cgData}> <${DKG_ONTOLOGY.DKG_REVOKED_AGENT}> ?revoked }
      } UNION {
        GRAPH <${agentsGraph}> { <${cgData}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy }
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
  // Peer ids are routing metadata, not part of the wallet-signed encryption
  // key proof. Bound key/route candidates independently from proof history:
  // the RDF schema stores both keys and proofs on the agent subject, so joining
  // them in SPARQL produces an N x N product during ordinary key rotation.
  // Separate 64-row bounds keep both reliable fanout and proof verification
  // work finite without treating that product as 64 distinct recipients.
  const candidateLimit = `LIMIT ${STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT + 1}`;
  const result = await store.query(
    `SELECT DISTINCT ?key ?algorithm ?peerId WHERE {
      VALUES ?agentSubject { ${agentUriValues} }
      GRAPH ?g {
        ?agentSubject <${DKG_PUBLIC_ENCRYPTION_KEY}> ?key .
        OPTIONAL { ?agentSubject <${DKG_ENCRYPTION_KEY_ALGORITHM}> ?algorithm }
        OPTIONAL { ?agentSubject <${DKG_PEER_ID}> ?peerId }
      }
      ${graphFilter}
    }
    ${candidateLimit}`,
  );

  if (result.type !== 'bindings' || result.bindings.length === 0) {
    throw new WorkspaceAgentEncryptionKeyMissingError([checksum]);
  }
  if (result.bindings.length > STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT) {
    throw new Error(
      `Too many public encryption-key candidates for DKG agent ${checksum}`,
    );
  }
  const proofResult = await store.query(
    `SELECT DISTINCT ?proof WHERE {
      VALUES ?agentSubject { ${agentUriValues} }
      GRAPH ?g {
        ?agentSubject <${DKG_ENCRYPTION_KEY_PROOF}> ?proof .
      }
      ${graphFilter}
    }
    ${candidateLimit}`,
  );
  if (
    proofResult.type === 'bindings'
    && proofResult.bindings.length > STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT
  ) {
    throw new Error(
      `Too many public encryption-key proof candidates for DKG agent ${checksum}`,
    );
  }
  const proofCandidates = proofResult.type === 'bindings'
    ? proofResult.bindings
      .map((row) => stringBinding(row['proof']))
      .filter((proof): proof is string => proof !== undefined)
    : [];

  // One wallet-verified key can be replicated in several profile graphs. Keep
  // distinct peer bindings for that key so a later Context Graph allowlist can
  // select the reachable variant. A peer-bound copy supersedes a peerless copy:
  // retaining both would incorrectly make the transport projection incomplete.
  const verifiedKeys = new Map<
    string,
    Map<string | undefined, WorkspaceAgentRecipient>
  >();
  let sawWrongAlgorithm = false;
  let sawUntrustedOnly = false;
  let sawInvalidProof = false;
  let sawMalformedKey = false;

  for (const row of result.bindings) {
    const publicKey = stringBinding(row['key']);
    const algorithm = stringBinding(row['algorithm']);
    const peerId = stringBinding(row['peerId']);
    if (!publicKey || !algorithm || proofCandidates.length === 0) {
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
    } catch {
      // Candidate rows can coexist across replicated/profile graphs. A junk
      // row must not poison a separately wallet-verified active key for the
      // same agent; ignore it exactly as we ignore an invalid proof, then fail
      // closed below only if no authenticated candidate survives.
      sawMalformedKey = true;
      continue;
    }

    const verified = proofCandidates.some((proof) => (
      verifyAgentEncryptionKeyProof(checksum, publicKeyBytes, stripRdfLiteral(proof))
    ));
    if (!verified) {
      sawInvalidProof = true;
      continue;
    }

    const cleanPeerId = peerId ? stripRdfLiteral(peerId) : undefined;
    if (
      options.requiredPeerId !== undefined
      && cleanPeerId !== options.requiredPeerId
    ) {
      throw new Error(
        `Public encryption key for DKG agent ${checksum} is not bound to the required peer`,
      );
    }

    const recipientKeyId = workspaceAgentEncryptionKeyId(checksum, publicKeyBytes);
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

  if (verifiedKeys.size === 0) {
    if (sawMalformedKey) {
      throw new Error(`Unverifiable public encryption key for DKG agent ${checksum}`);
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
    // Fail-closed fallback: every skipped candidate above sets a flag, so
    // this is unreachable and not a missing key a phonebook fetch could fix.
    throw new Error(`Missing public encryption key for DKG agent ${checksum}`);
  }

  const verifiedRecipients = [...verifiedKeys.values()].flatMap((variants) => (
    [...variants.values()]
  ));
  const revokedKeyIds = await loadVerifiedRevokedKeyIds(store, checksum, verifiedRecipients);
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
