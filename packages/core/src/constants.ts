// ── V10 Protocol Stream IDs ─────────────────────────────────────────────

export const PROTOCOL_PUBLISH = '/dkg/10.0.0/publish';
export const PROTOCOL_QUERY = '/dkg/10.0.0/query';
export const PROTOCOL_DISCOVER = '/dkg/10.0.0/discover';
export const PROTOCOL_SYNC = '/dkg/10.0.0/sync';
export const PROTOCOL_MESSAGE = '/dkg/10.0.0/message';
export const PROTOCOL_ACCESS = '/dkg/10.0.0/private-access';
export const PROTOCOL_QUERY_REMOTE = '/dkg/10.0.0/query-remote';

export const PROTOCOL_VERIFY_PROPOSAL = '/dkg/10.0.0/verify-proposal';
export const PROTOCOL_VERIFY_APPROVAL = '/dkg/10.0.0/verify-approval';
export const PROTOCOL_STORAGE_ACK = '/dkg/10.0.0/storage-ack';

export const DHT_PROTOCOL = '/dkg/kad/1.0.0';

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

export function contextGraphDraftUri(contextGraphId: string, agentAddress: string, name: string, subGraphName?: string): string {
  if (subGraphName) return `did:dkg:context-graph:${contextGraphId}/${subGraphName}/draft/${agentAddress}/${name}`;
  return `did:dkg:context-graph:${contextGraphId}/draft/${agentAddress}/${name}`;
}

export function contextGraphRulesUri(contextGraphId: string): string {
  return `did:dkg:context-graph:${contextGraphId}/_rules`;
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

/**
 * Validates a sub-graph name: must be non-empty, no leading underscore
 * (reserved for protocol graphs), no slashes (flat namespace), and safe for IRIs.
 */
export function validateSubGraphName(name: string): { valid: boolean; reason?: string } {
  if (!name || name.length === 0) return { valid: false, reason: 'Sub-graph name cannot be empty' };
  if (name.startsWith('_')) return { valid: false, reason: 'Sub-graph names starting with "_" are reserved for protocol graphs' };
  if (name.includes('/')) return { valid: false, reason: 'Sub-graph names cannot contain "/"' };
  if (/[<>"{}|^`\\\s]/.test(name)) return { valid: false, reason: 'Sub-graph name contains characters unsafe for IRIs' };
  if (name === 'context' || name === 'draft') return { valid: false, reason: `"${name}" is a reserved path segment` };
  return { valid: true };
}

// ── Deprecated V9 aliases ──────────────────────────────────────────────
// These map V9 function signatures to V10 implementations.
// The URI patterns now use V10 format (did:dkg:context-graph:).

/** @deprecated Use contextGraphWorkspaceTopic */
export function paranetPublishTopic(paranetId: string): string {
  return contextGraphFinalizationTopic(paranetId);
}

/** @deprecated Use contextGraphAppTopic */
export function paranetAgentsTopic(paranetId: string): string {
  return contextGraphAppTopic(paranetId);
}

/** @deprecated Use contextGraphDataUri */
export function paranetDataGraphUri(paranetId: string): string {
  return contextGraphDataUri(paranetId);
}

/** @deprecated Use contextGraphMetaUri */
export function paranetMetaGraphUri(paranetId: string): string {
  return contextGraphMetaUri(paranetId);
}

/** @deprecated Use contextGraphPrivateUri */
export function paranetPrivateGraphUri(paranetId: string): string {
  return contextGraphPrivateUri(paranetId);
}

/** @deprecated Use contextGraphSharedMemoryUri */
export function paranetWorkspaceGraphUri(paranetId: string): string {
  return contextGraphSharedMemoryUri(paranetId);
}

/** @deprecated Use contextGraphSharedMemoryMetaUri */
export function paranetWorkspaceMetaGraphUri(paranetId: string): string {
  return contextGraphSharedMemoryMetaUri(paranetId);
}

/** @deprecated Use contextGraphAppTopic */
export function paranetAppTopic(paranetId: string): string {
  return contextGraphAppTopic(paranetId);
}

/** @deprecated Use contextGraphSharedMemoryTopic */
export function paranetWorkspaceTopic(paranetId: string): string {
  return contextGraphSharedMemoryTopic(paranetId);
}

/** @deprecated Use contextGraphUpdateTopic */
export function paranetUpdateTopic(paranetId: string): string {
  return contextGraphUpdateTopic(paranetId);
}

/** @deprecated Use contextGraphFinalizationTopic */
export function paranetFinalizationTopic(paranetId: string): string {
  return contextGraphFinalizationTopic(paranetId);
}

/** @deprecated Use contextGraphSessionsTopic */
export function paranetSessionsTopic(paranetId: string): string {
  return contextGraphSessionsTopic(paranetId);
}

/** @deprecated Use contextGraphSessionTopic */
export function paranetSessionTopic(paranetId: string, sessionId: string): string {
  return contextGraphSessionTopic(paranetId, sessionId);
}
