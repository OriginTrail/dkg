// ── V10 Protocol Stream IDs ─────────────────────────────────────────────

export const PROTOCOL_PUBLISH = '/dkg/10.0.0/publish';
export const PROTOCOL_QUERY = '/dkg/10.0.0/query';
export const PROTOCOL_DISCOVER = '/dkg/10.0.0/discover';
// rc.9 PR-E (SWM reliable fan-out plan, Step 2): bumped from
// /dkg/10.0.0/sync to /dkg/10.0.1/sync. The sync RPC is the eventual-
// consistency safety net for SWM share delivery (runSyncOnConnect →
// syncSharedMemoryFromPeer when peers reconnect). Pre-rc.9 the
// safety net itself ran over an un-migrated transport: no envelope
// versioning, no idempotency, no durable outbox — a stream reset
// mid-sync was unrecoverable except by the next reconnect. Bumping
// onto the /dkg/10.0.1/ prefix gives the safety net the same
// reliability primitives as chat / access / query-remote / etc.
// Hard cutover, consistent with the rc.9 protocol migration model:
// rc.8 nodes cannot sync from rc.9 nodes and vice versa.
export const PROTOCOL_SYNC = '/dkg/10.0.1/sync';
// Universal Messenger pilot protocol (rc.9 PR-3). Bumped from
// /dkg/10.0.0/message to /dkg/10.0.1/message to opt into the
// reliability substrate (ReliableEnvelope wrapper, sender +
// receiver idempotency, durable SQLite outbox). Hard cutover —
// nodes on rc.8 cannot chat with nodes on rc.9; both daemons MUST
// be on the same prefix (see docs/messenger.md "Versioning" + the
// rc.9 plan note "Safe by /dkg/10.0.1/* prefix-version invariant").
// PR-8+ migrate the remaining short-message protocols onto the
// same 10.0.1 minor.
export const PROTOCOL_MESSAGE = '/dkg/10.0.1/message';
// rc.9 PR-8: bumped from /dkg/10.0.0/private-access to opt into the
// Universal Messenger substrate (envelope wrapper, sender-side
// idempotency cache, receiver-side dedup, durable SQLite outbox).
// Hard cutover — rc.8 nodes can no longer request private access
// from rc.9 nodes and vice versa. The handler registers via
// messenger.register and the only production-shaped sender (the
// publisher AccessClient — currently exercised only by integration
// tests) routes through messenger.sendReliable.
export const PROTOCOL_ACCESS = '/dkg/10.0.1/private-access';
// rc.9 PR-9: bumped from /dkg/10.0.0/query-remote to opt into the
// Universal Messenger substrate. Query responses can be large
// (SPARQL result sets), so a duplicate receive (multi-path race or
// idempotency-retry) that hits the 256 KiB mark-only response cache
// returns RESPONSE_GONE. queryRemote() handles RESPONSE_GONE by
// re-issuing the query with a fresh messageId — SPARQL is idempotent
// at the app layer so this is semantically safe (see
// docs/messenger.md "Response caching policy").
export const PROTOCOL_QUERY_REMOTE = '/dkg/10.0.1/query-remote';
// rc.9 PR-8: bumped from /dkg/10.0.0/swm-sender-key to opt into the
// Universal Messenger substrate (same rationale as PROTOCOL_ACCESS).
// SWM sender-key send sites in dkg-agent.ts route through
// messenger.sendReliable; handler registers via messenger.register.
export const PROTOCOL_SWM_SENDER_KEY = '/dkg/10.0.1/swm-sender-key';
// rc.9 PR-C (SWM reliable fan-out plan, Step 3): NEW protocol — no
// rc.8 predecessor. Carries the same workspace-gossip wire bytes
// (produced by `encodeWorkspaceGossipMessage`) point-to-point over
// the reliable messenger substrate, as a deterministic alternative
// to GossipSub's best-effort mesh. The receiver handler hands the
// bytes directly to `SharedMemoryHandler.handle()` — same in-process
// apply path that the gossip subscription drives, so dedup and
// metrics behave identically. Activated by the tier-switch in
// `publishWorkspaceGossip` for any CG whose `CGMemberEnumerator`
// returns `source: 'allowlist'`, and as a top-up for public CGs at
// or below `DKG_SWM_SUBSTRATE_MAX_MEMBERS`. See RFC-003 §6 for the
// full transport policy.
export const PROTOCOL_SWM_UPDATE = '/dkg/10.0.1/swm-update';
// rc.9 PR-D (SWM reliable fan-out plan, Step 1b): NEW protocol — no
// rc.8 predecessor. Per-recipient acknowledgement that the receiver
// successfully applied a SWM share via the GOSSIP path. Receivers
// emit this on every gossip-applied share to the share's author peer
// (extracted from the gossip envelope signature); senders track ack
// arrivals against the enumerated `expectedMembers` set in
// `SwmAckQuorum` to compute per-share delivery quorum. Substrate-
// delivered shares (PROTOCOL_SWM_UPDATE) ACK via the substrate
// response itself and DO NOT emit a separate SwmShareAck to avoid
// double counting. The watchdog runs substrate top-up over the
// long-tail non-acked peers (`expectedMembers \ acked`) and gives
// up at the deadline, falling back to runSyncOnConnect for offline
// peers. See RFC-003 §4.2 + §5.2 for the full ack-quorum policy.
export const PROTOCOL_SWM_SHARE_ACK = '/dkg/10.0.1/swm-share-ack';

// OT-RFC-38 LU-6 (cores host curated SWM substrate): NEW protocol.
// Members fetch opaque ciphertext envelopes from a core that has
// stored them on behalf of a CG (because the sharding-table — all-
// cores in Phase A — assigned the CG to it). Request is a small JSON
// envelope { contextGraphId, sinceSeqno }; response is a JSON envelope
// carrying base64'd gossip envelopes that the requester re-feeds
// through its local `SharedMemoryHandler.handle()` so the existing
// Sender-Key decrypt-and-apply path runs verbatim. The wire format
// is documented in `packages/agent/src/swm/host-catchup-wire.ts`.
//
// This protocol closes the late-joiner gap when every CG member is
// offline simultaneously — without it, members are the sole authority
// for SWM and a member-quorum outage leaves new joiners with no
// substrate to read from. With it, cores act as ciphertext-only
// custodians whose decryption authority is bounded by the chain key
// (which they never see).
export const PROTOCOL_SWM_HOST_CATCHUP = '/dkg/10.0.1/swm-host-catchup';

// rc.9 PR-10: bumped from /dkg/10.0.0/join-request to opt into the
// Universal Messenger substrate. The in-memory JoinApprovalRetryQueue
// (rc.9 PR #510) is replaced by the substrate's durable SQLite outbox
// — same backoff ladder semantics, persists across daemon restart.
export const PROTOCOL_JOIN_REQUEST = '/dkg/10.0.1/join-request';

// rc.9 PR-11: bumped from /dkg/10.0.0/* to opt into the Universal
// Messenger substrate. ACKCollector + VerifyCollector keep their
// existing app-level fan-out + quorum semantics; substrate gives
// them envelope-versioned wire + receiver-side dedup + sender
// idempotency under the hood. Default `parallelPaths` for these two
// is intentionally **1** (the app already fans out; parallelPaths>1
// would 9x amplify the wire load with no SLO win — see plan PR-4
// runtime guard + PR-11 rationale).
export const PROTOCOL_VERIFY_PROPOSAL = '/dkg/10.0.1/verify-proposal';
export const PROTOCOL_VERIFY_APPROVAL = '/dkg/10.0.0/verify-approval';
export const PROTOCOL_STORAGE_ACK = '/dkg/10.0.1/storage-ack';

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
