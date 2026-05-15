// ── V10 Protocol Stream IDs ─────────────────────────────────────────────

export const PROTOCOL_PUBLISH = '/dkg/10.0.0/publish';
export const PROTOCOL_QUERY = '/dkg/10.0.0/query';
export const PROTOCOL_DISCOVER = '/dkg/10.0.0/discover';
export const PROTOCOL_SYNC = '/dkg/10.0.0/sync';
export const PROTOCOL_MESSAGE = '/dkg/10.0.0/message';
export const PROTOCOL_ACCESS = '/dkg/10.0.0/private-access';
export const PROTOCOL_QUERY_REMOTE = '/dkg/10.0.0/query-remote';
export const PROTOCOL_SWM_SENDER_KEY = '/dkg/10.0.0/swm-sender-key';

export const PROTOCOL_JOIN_REQUEST = '/dkg/10.0.0/join-request';

export const PROTOCOL_VERIFY_PROPOSAL = '/dkg/10.0.0/verify-proposal';
export const PROTOCOL_VERIFY_APPROVAL = '/dkg/10.0.0/verify-approval';
export const PROTOCOL_STORAGE_ACK = '/dkg/10.0.0/storage-ack';

export const DHT_PROTOCOL = '/dkg/kad/1.0.0';

/** Maximum application payload size allowed for one DKG GossipSub message (10 MB). */
export const DKG_GOSSIP_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/** Allows GossipSub RPC framing around one max-sized application payload. */
export const DKG_GOSSIP_MAX_RPC_BYTES = DKG_GOSSIP_MAX_MESSAGE_BYTES + 256 * 1024;

// ── V10 GossipSub Topics ───────────────────────────────────────────────

export function contextGraphSharedMemoryTopic(contextGraphId: string): string {
  return `dkg/context-graph/${contextGraphId}/shared-memory`;
}

/** @deprecated Use contextGraphSharedMemoryTopic */
export const contextGraphWorkspaceTopic = contextGraphSharedMemoryTopic;

export function contextGraphFinalizationTopic(contextGraphId: string): string {
  return `dkg/context-graph/${contextGraphId}/finalization`;
}

export function contextGraphUpdateTopic(contextGraphId: string): string {
  return `dkg/context-graph/${contextGraphId}/update`;
}

export function contextGraphAppTopic(contextGraphId: string): string {
  return `dkg/context-graph/${contextGraphId}/app`;
}

export function contextGraphSessionsTopic(contextGraphId: string): string {
  return `dkg/context-graph/${contextGraphId}/sessions`;
}

export function contextGraphSessionTopic(contextGraphId: string, sessionId: string): string {
  return `dkg/context-graph/${contextGraphId}/sessions/${sessionId}`;
}

export function networkPeersTopic(): string {
  return 'dkg/network/peers';
}

// ── V10 Named Graph URIs ───────────────────────────────────────────────

export function contextGraphDataUri(contextGraphId: string, subGraphId?: string): string {
  if (subGraphId !== undefined) {
    return `did:dkg:context-graph:${contextGraphId}/context/${subGraphId}`;
  }
  return `did:dkg:context-graph:${contextGraphId}`;
}

export function contextGraphMetaUri(contextGraphId: string, subGraphId?: string): string {
  if (subGraphId !== undefined) {
    return `did:dkg:context-graph:${contextGraphId}/context/${subGraphId}/_meta`;
  }
  return `did:dkg:context-graph:${contextGraphId}/_meta`;
}

export function contextGraphPrivateUri(contextGraphId: string): string {
  return `did:dkg:context-graph:${contextGraphId}/_private`;
}

export function contextGraphSharedMemoryUri(contextGraphId: string, subGraphName?: string): string {
  if (subGraphName) return `did:dkg:context-graph:${contextGraphId}/${subGraphName}/_shared_memory`;
  return `did:dkg:context-graph:${contextGraphId}/_shared_memory`;
}

export function contextGraphSharedMemoryMetaUri(contextGraphId: string, subGraphName?: string): string {
  if (subGraphName) return `did:dkg:context-graph:${contextGraphId}/${subGraphName}/_shared_memory_meta`;
  return `did:dkg:context-graph:${contextGraphId}/_shared_memory_meta`;
}

export function contextGraphVerifiedMemoryUri(contextGraphId: string, verifiedMemoryId: string): string {
  return `did:dkg:context-graph:${contextGraphId}/_verified_memory/${verifiedMemoryId}`;
}

export function contextGraphVerifiedMemoryMetaUri(contextGraphId: string, verifiedMemoryId: string): string {
  return `did:dkg:context-graph:${contextGraphId}/_verified_memory/${verifiedMemoryId}/_meta`;
}

export function contextGraphAssertionUri(contextGraphId: string, agentAddress: string, name: string, subGraphName?: string): string {
  if (subGraphName) return `did:dkg:context-graph:${contextGraphId}/${subGraphName}/assertion/${agentAddress}/${name}`;
  return `did:dkg:context-graph:${contextGraphId}/assertion/${agentAddress}/${name}`;
}

export function contextGraphRulesUri(contextGraphId: string): string {
  return `did:dkg:context-graph:${contextGraphId}/_rules`;
}

/**
 * Stable URI for an assertion's lifecycle record in `_meta`.
 * Persists across WM → SWM → VM transitions so assertions remain
 * queryable by identity after promotion.
 */
export function assertionLifecycleUri(contextGraphId: string, agentAddress: string, name: string, subGraphName?: string): string {
  if (subGraphName) return `urn:dkg:assertion:${contextGraphId}:${subGraphName}:${agentAddress}:${name}`;
  return `urn:dkg:assertion:${contextGraphId}:${agentAddress}:${name}`;
}

export function contextGraphSubGraphUri(contextGraphId: string, subGraphName: string): string {
  return `did:dkg:context-graph:${contextGraphId}/${subGraphName}`;
}

export function contextGraphSubGraphMetaUri(contextGraphId: string, subGraphName: string): string {
  return `did:dkg:context-graph:${contextGraphId}/${subGraphName}/_meta`;
}

export function contextGraphSubGraphPrivateUri(contextGraphId: string, subGraphName: string): string {
  return `did:dkg:context-graph:${contextGraphId}/${subGraphName}/_private`;
}

export function validateContextGraphId(id: string): { valid: boolean; reason?: string } {
  if (!id || id.length === 0) return { valid: false, reason: 'Context graph ID cannot be empty' };
  if (id.length > 256) return { valid: false, reason: 'Context graph ID exceeds 256 characters' };
  if (!/^[\w:/.@\-]+$/.test(id)) return { valid: false, reason: 'Context graph ID contains disallowed characters (allowed: alphanumeric, _, :, /, ., @, -)' };
  return { valid: true };
}

/**
 * V10 wallet-scoped context-graph IDs follow the convention
 * `<curatorAddress>/<name>` — e.g. `0xabc.../my-project`. For these
 * CGs the curator's identity is structural: it can be derived from the
 * cgId itself without consulting any local metadata store. This is the
 * authoritative fallback when the local RDF `_meta` graph is missing
 * the explicit curator triple — which happens for any CG whose
 * on-chain registration did not complete locally (e.g. node had no
 * funded identity at create time, RPC was down, or the create-flow
 * crashed between SQLite and triple-store writes). Without this
 * fallback the daemon silently rejects all join requests for those
 * CGs with `unknown CG`, and the joiner sees only "no reachable
 * curator" — a failure mode that consumed an entire two-laptop
 * debugging session before being root-caused.
 *
 * Returns null for non-wallet-prefixed cgIds (system CGs like
 * `agents`/`ontology`, legacy V9-style globals like `hbad-5`) — these
 * genuinely have no derivable curator and the caller must fall
 * through to "unknown CG".
 *
 * Case is preserved from the cgId. Comparisons against local agent
 * keys should be case-insensitive on the address portion (Ethereum
 * addresses are case-insensitive; the EIP-55 checksum is advisory).
 */
export function deriveCuratorDidFromCgId(contextGraphId: string): string | null {
  const match = /^(0x[0-9a-fA-F]{40})\/.+$/.exec(contextGraphId);
  if (!match) return null;
  return `did:dkg:agent:${match[1]}`;
}

/**
 * Validates a sub-graph name: must be non-empty, no leading underscore
 * (reserved for protocol graphs), no slashes (flat namespace), and safe for IRIs.
 */
export function validateSubGraphName(name: string): { valid: boolean; reason?: string } {
  if (!name || name.length === 0) return { valid: false, reason: 'Sub-graph name cannot be empty' };
  if (name.startsWith('_')) return { valid: false, reason: 'Sub-graph names starting with "_" are reserved for protocol graphs' };
  if (name.includes('/')) return { valid: false, reason: 'Sub-graph names cannot contain "/"' };
  if (/[<>"{}|^`\\\s]/.test(name)) return { valid: false, reason: 'Sub-graph name contains characters unsafe for IRIs' };
  if (name === 'context' || name === 'assertion' || name === 'draft') return { valid: false, reason: `"${name}" is a reserved path segment` };
  return { valid: true };
}

/**
 * Validates an assertion name for safe interpolation into graph URIs.
 * Same character restrictions as sub-graph names.
 */
export function validateAssertionName(name: string): { valid: boolean; reason?: string } {
  if (!name || name.length === 0) return { valid: false, reason: 'Assertion name cannot be empty' };
  if (name.includes('/')) return { valid: false, reason: 'Assertion name cannot contain "/"' };
  if (/[<>"{}|^`\\\s]/.test(name)) return { valid: false, reason: 'Assertion name contains characters unsafe for IRIs' };
  if (name.length > 256) return { valid: false, reason: 'Assertion name exceeds 256 characters' };
  return { valid: true };
}

export function contextGraphPublishTopic(contextGraphId: string): string {
  return contextGraphFinalizationTopic(contextGraphId);
}

export function contextGraphDataGraphUri(contextGraphId: string): string {
  return contextGraphDataUri(contextGraphId);
}

export function contextGraphMetaGraphUri(contextGraphId: string): string {
  return contextGraphMetaUri(contextGraphId);
}

export function contextGraphPrivateGraphUri(contextGraphId: string): string {
  return contextGraphPrivateUri(contextGraphId);
}

export function contextGraphWorkspaceGraphUri(contextGraphId: string): string {
  return contextGraphSharedMemoryUri(contextGraphId);
}

export function contextGraphWorkspaceMetaGraphUri(contextGraphId: string): string {
  return contextGraphSharedMemoryMetaUri(contextGraphId);
}
