import { MemoryLayer, memoryLayerSlug } from './memory-model.js';
import { assertSafeIri } from './sparql-safe.js';

// ── V10 Protocol Stream IDs ─────────────────────────────────────────────

export const PROTOCOL_PUBLISH = '/dkg/10.0.0/publish';
export const PROTOCOL_QUERY = '/dkg/10.0.0/query';
export const PROTOCOL_DISCOVER = '/dkg/10.0.0/discover';
// Bumped /dkg/10.0.1/sync -> /dkg/10.0.2/sync: sync is taken BACK OFF
// the Universal Messenger substrate (raw ProtocolRouter register/send,
// no ReliableEnvelope, no idempotency, no outbox). rc.9 PR-E had routed
// sync through the substrate "for receiver-side dedup", but the sync
// requester mints a fresh messageId per attempt, so the dedup key never
// repeats — the cache hit rate is structurally zero while every large,
// never-reused page response was cached on both sides of
// message_idempotency (the ~2.9 GB node-ui.db bloat). Sync already has
// its own retry (withRetry), 90s auth-freshness TTL, and per-requestId
// replay protection, so it needs none of the substrate's machinery.
// Going raw changes the wire bytes (bare auth-envelope vs
// ReliableEnvelope), so the protocol ID MUST bump or mixed-version peers
// mis-decode. Hard cutover, consistent with the rc.9 migration model:
// mixed-version peers cleanly skip each other via waitForSyncProtocol
// (sync is a self-healing catch-up net, so the brief mixed-version
// window during auto-update is no-data-loss).
export const PROTOCOL_SYNC = '/dkg/10.0.2/sync';
// OT-RFC-59 changelog read-lane — a SEPARATE protocol id, not a field on
// PROTOCOL_SYNC: the legacy sync response is bare N-Quads with no envelope, so a
// structured (era, headSeq, nextSeq, records) head cannot ride the existing
// wire. Same 10.0.2 family; the distinct suffix means legacy peers never dial it
// and identify simply omits it. Advertised ONLY when config.changelog is on
// (the responder registers it iff asChangelogReader(store) is non-null), so it
// is default-off and mixed-version-safe: a changelog-capable requester falls
// back to PROTOCOL_SYNC when a peer does not advertise this id.
export const PROTOCOL_SYNC_CHANGELOG = '/dkg/10.0.2/sync-changelog';
export const PROTOCOL_GET_ASSERTION_ARTIFACT = '/dkg/10.0.2/get-assertion-artifact';
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
// 10.0.2 binds decisions to the signed request generation. Keep this distinct
// from 10.0.1 so mixed-version peers fail negotiation instead of ACK-dropping
// generation-less approval/rejection messages and stranding the requester.
export const PROTOCOL_JOIN_REQUEST = '/dkg/10.0.2/join-request';

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
/**
 * OT-RFC-38 LU-11 / OT-RFC-39 and folded-private ACKs — storage-ack protocol
 * version for PublishIntent fields that require capability gating beyond
 * `/dkg/10.0.1/storage-ack`, including chunked ciphertext fields and field 20
 * `privateMerkleRoots`. Pre-V2 nodes do not register this handler, so
 * mixed-version clusters fail at protocol selection instead of silently
 * ignoring new fields.
 */
export const PROTOCOL_STORAGE_ACK_V2 = '/dkg/10.0.2/storage-ack';

/**
 * V10 UPDATE StorageACK protocol. Mirrors {@link PROTOCOL_STORAGE_ACK}
 * but carries an `UpdateIntent` (not a `PublishIntent`) and binds the
 * 13-field UPDATE ACK digest (see `computeUpdateACKDigest`) that
 * `KnowledgeAssetsLifecycle._executeUpdateCore` verifies on-chain.
 *
 * The publish StorageACK protocol is publish-only (no op-type
 * discriminator on the wire), so updates need a distinct protocol id
 * rather than overloading the publish one. Pre-update cores simply
 * never register this handler, so an UPDATE-aware publisher dialing a
 * legacy core gets a libp2p "could not negotiate" error there (counted
 * as a peer-unreachable failure against the quorum), exactly like the
 * V2-vs-V1 graceful-fallback pattern.
 */
export const PROTOCOL_STORAGE_UPDATE_ACK = '/dkg/10.0.1/storage-update-ack';

/**
 * Graph-scoped UPDATE StorageACK protocol. V1 update responders interpret
 * `subGraphName` using the legacy entity-root layout and do not validate the
 * graph-scoped content envelope. Keep V2 on a distinct capability so a
 * rootless update can never be acknowledged by a peer that silently ignores
 * its scope/version fields.
 */
export const PROTOCOL_STORAGE_UPDATE_ACK_V2 = '/dkg/10.0.2/storage-update-ack';

/**
 * OT-RFC-38 LU-11 / OT-RFC-39 — point-to-point sync verb for one
 * curated-CG ciphertext chunk identified by (cgId, batchId,
 * chunkIndex). Used by late-joining hosting cores (and any
 * sharding-table member that missed the original chunked SWM
 * gossip) to backfill the per-chunk store before the V2 ACK
 * verifier needs the bytes. See
 * `packages/agent/src/swm/ciphertext-chunk-catchup.ts` for the
 * signed JSON wire format and per-pull authorization gate.
 */
export const PROTOCOL_GET_CIPHERTEXT_CHUNK = '/dkg/10.0.2/get-ciphertext-chunk';
export const PROTOCOL_NETWORK_IDENTITY = '/dkg/10.0.1/network-identity';

export const DHT_PROTOCOL = '/dkg/kad/1.0.0';

const NETWORK_TOPIC_PREFIX = 'dkg/network';
const NON_DKG_TOPIC_PREFIX = 'topic';

export function networkNamespaceSegment(networkId: string, chainId?: string): string {
  const parts = [networkId, chainId]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  for (const part of parts) {
    if (!/^[A-Za-z0-9._:-]+$/.test(part)) {
      throw new Error(`Invalid DKG network namespace: ${part}`);
    }
  }
  return parts.join('.');
}

export function dhtProtocolForNetwork(networkId?: string, chainId?: string): string {
  if (!networkId) return DHT_PROTOCOL;
  return `/dkg/${networkNamespaceSegment(networkId, chainId)}/kad/1.0.0`;
}

export function wireTopicForNetwork(networkId: string | undefined, logicalTopic: string, chainId?: string): string {
  if (!networkId) return logicalTopic;
  const segment = networkNamespaceSegment(networkId, chainId);
  const suffix = logicalTopic.startsWith('dkg/')
    ? logicalTopic.slice('dkg/'.length)
    : `${NON_DKG_TOPIC_PREFIX}/${logicalTopic}`;
  return `${NETWORK_TOPIC_PREFIX}/${segment}/${suffix}`;
}

export function logicalTopicFromWireTopic(networkId: string | undefined, wireTopic: string, chainId?: string): string | null {
  if (!networkId) return wireTopic;
  const prefix = `${NETWORK_TOPIC_PREFIX}/${networkNamespaceSegment(networkId, chainId)}/`;
  if (!wireTopic.startsWith(prefix)) return null;
  const suffix = wireTopic.slice(prefix.length);
  if (suffix.startsWith(`${NON_DKG_TOPIC_PREFIX}/`)) {
    return suffix.slice(NON_DKG_TOPIC_PREFIX.length + 1);
  }
  return `dkg/${suffix}`;
}

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

/**
 * SPARQL `FILTER` scoping a `GRAPH ?g` pattern to a shared-working-memory
 * bucket's OT-RFC-46 read-both layout: the bare bucket `<swmGraph>` AND its
 * per-KA layer graphs (`<swmGraph>/<addr>/<number>`), excluding the
 * `<swmGraph>/staging/` sub-tree.
 *
 * Single source of truth for this predicate. It was previously copy-pasted
 * across the publisher, agent, storage-ACK and daemon SWM read paths, and the
 * publish-from-SWM selection bug came from those copies drifting apart. Reuse
 * this anywhere a SWM read must see promoted (per-KA) data so the paths stay in
 * lockstep.
 *
 * @param swmGraph bucket URI from `contextGraphSharedMemoryUri(...)`
 * @param graphVar SPARQL variable bound to the named graph (default `?g`)
 */
export function sharedMemoryReadBothFilter(swmGraph: string, graphVar: string = "?g"): string {
  const safeSwmGraph = assertSafeIri(swmGraph);
  if (!/^\?[A-Za-z_][A-Za-z0-9_]*$/.test(graphVar)) {
    throw new Error(`Unsafe SPARQL graph variable: ${graphVar}`);
  }
  return `FILTER(((STRSTARTS(STR(${graphVar}), "${safeSwmGraph}/") && !STRSTARTS(STR(${graphVar}), "${safeSwmGraph}/staging/")) || STR(${graphVar}) = "${safeSwmGraph}"))`;
}

export function contextGraphSharedMemoryMetaUri(contextGraphId: string, subGraphName?: string): string {
  if (subGraphName) return `did:dkg:context-graph:${contextGraphId}/${subGraphName}/_shared_memory_meta`;
  return `did:dkg:context-graph:${contextGraphId}/_shared_memory_meta`;
}

export function contextGraphVerifiableMemoryUri(contextGraphId: string, verifiableMemoryId: string): string {
  return `did:dkg:context-graph:${contextGraphId}/_verifiable_memory/${verifiableMemoryId}`;
}

export function contextGraphVerifiableMemoryMetaUri(contextGraphId: string, verifiableMemoryId: string): string {
  return `did:dkg:context-graph:${contextGraphId}/_verifiable_memory/${verifiableMemoryId}/_meta`;
}

export function contextGraphAssertionUri(contextGraphId: string, agentAddress: string, name: string, subGraphName?: string): string {
  if (subGraphName) return `did:dkg:context-graph:${contextGraphId}/${subGraphName}/assertion/${agentAddress}/${name}`;
  return `did:dkg:context-graph:${contextGraphId}/assertion/${agentAddress}/${name}`;
}

/** Canonical identity segment used by all new per-KA memory-layer writes. */
export function canonicalKnowledgeAssetAgentAddress(agentAddress: string): string {
  // Non-EVM legacy identities (notably peer IDs) remain byte-for-byte stable.
  return /^0x[0-9a-fA-F]{40}$/.test(agentAddress)
    ? agentAddress.toLowerCase()
    : agentAddress;
}

/** Compare graph identity addresses using EVM case-folding and legacy exactness. */
export function knowledgeAssetAgentAddressesEqual(left: string, right: string): boolean {
  return canonicalKnowledgeAssetAgentAddress(left) === canonicalKnowledgeAssetAgentAddress(right);
}

/** Build the layer-independent canonical `{address}/{number}` suffix. */
export function canonicalKnowledgeAssetGraphIdentitySuffix(
  agentAddress: string,
  kaNumber: string | number | bigint,
): string {
  const canonicalAgentAddress = canonicalKnowledgeAssetAgentAddress(agentAddress);
  return `${canonicalAgentAddress}/${kaNumber}`;
}

function contextGraphLayerBaseUri(
  contextGraphId: string,
  layer: MemoryLayer,
  subGraphName?: string,
): string {
  const base = subGraphName
    ? `did:dkg:context-graph:${contextGraphId}/${subGraphName}`
    : `did:dkg:context-graph:${contextGraphId}`;
  return `${base}/${memoryLayerSlug(layer)}`;
}

/**
 * Uniform per-KA graph URI for ANY memory layer (OT-RFC-46 Chorus).
 *
 *   did:dkg:context-graph:{cg}[/{sub}]/{_layer}/{addr}/{number}
 *
 * The layer is just a parameter — WM, SWM, and VM share ONE structure, ONE
 * builder, and (downstream) ONE read path. `kaNumber` is the per-author KA
 * number (the identifying half of the UAL `did:dkg:{chain}/{addr}/{number}`),
 * minted at create. A KA moves between layers by swapping only the `{_layer}`
 * segment; the canonical `{addr}/{number}` suffix is stable for its whole
 * lifecycle.
 */
export function contextGraphLayerUri(
  contextGraphId: string,
  layer: MemoryLayer,
  agentAddress: string,
  kaNumber: string | number | bigint,
  subGraphName?: string,
): string {
  const layerBase = contextGraphLayerBaseUri(contextGraphId, layer, subGraphName);
  return `${layerBase}/${canonicalKnowledgeAssetGraphIdentitySuffix(agentAddress, kaNumber)}`;
}

/**
 * Canonical per-KA graph first, followed by the caller-known historical casing
 * when it differs. Store-backed readers can discover additional aliases and
 * compare them with `knowledgeAssetAgentAddressesEqual`.
 */
export function contextGraphLayerUriCandidates(
  contextGraphId: string,
  layer: MemoryLayer,
  agentAddress: string,
  kaNumber: string | number | bigint,
  subGraphName?: string,
): string[] {
  const layerBase = contextGraphLayerBaseUri(contextGraphId, layer, subGraphName);
  const canonical = `${layerBase}/${canonicalKnowledgeAssetGraphIdentitySuffix(agentAddress, kaNumber)}`;
  const legacy = `${layerBase}/${agentAddress}/${kaNumber}`;
  return canonical === legacy ? [canonical] : [canonical, legacy];
}

/** Canonical and caller-known legacy prefixes for an unscoped layer read. */
export function contextGraphLayerPrefixCandidates(
  contextGraphId: string,
  layer: MemoryLayer,
  agentAddress: string,
  subGraphName?: string,
): string[] {
  const layerBase = contextGraphLayerBaseUri(contextGraphId, layer, subGraphName);
  const canonical = `${layerBase}/${canonicalKnowledgeAssetAgentAddress(agentAddress)}/`;
  const legacy = `${layerBase}/${agentAddress}/`;
  return canonical === legacy ? [canonical] : [canonical, legacy];
}

export interface ContextGraphLayerIdentity {
  contextGraphId: string;
  subGraphName?: string;
  layer: MemoryLayer;
  agentAddress: string;
  kaNumber: bigint;
}

const MEMORY_LAYER_BY_SLUG: ReadonlyMap<string, MemoryLayer> = new Map([
  [memoryLayerSlug(MemoryLayer.WorkingMemory), MemoryLayer.WorkingMemory],
  [memoryLayerSlug(MemoryLayer.SharedWorkingMemory), MemoryLayer.SharedWorkingMemory],
  [memoryLayerSlug(MemoryLayer.VerifiableMemory), MemoryLayer.VerifiableMemory],
]);

export function parseContextGraphLayerUri(graphUri: string): ContextGraphLayerIdentity | undefined {
  const prefix = 'did:dkg:context-graph:';
  if (!graphUri.startsWith(prefix)) return undefined;
  const segments = graphUri.slice(prefix.length).split('/');
  if (segments.length !== 4 && segments.length !== 5) return undefined;

  const layerIndex = segments.length - 3;
  const layer = MEMORY_LAYER_BY_SLUG.get(segments[layerIndex]);
  if (!layer) return undefined;
  const contextGraphId = segments[0];
  const subGraphName = layerIndex === 2 ? segments[1] : undefined;
  const agentAddress = segments[layerIndex + 1];
  const kaNumberRaw = segments[layerIndex + 2];
  if (
    !contextGraphId ||
    !/^0x[0-9a-fA-F]{40}$/.test(agentAddress) ||
    !/^\d+$/.test(kaNumberRaw)
  ) return undefined;
  return {
    contextGraphId,
    subGraphName,
    layer,
    agentAddress,
    kaNumber: BigInt(kaNumberRaw),
  };
}

export function contextGraphRulesUri(contextGraphId: string): string {
  return `did:dkg:context-graph:${contextGraphId}/_rules`;
}

/**
 * Stable URI for an assertion's lifecycle record in `_meta`.
 * Persists across WM → SWM → VM transitions so assertions remain
 * queryable by identity after promotion.
 *
 * TODO(rfc-ka-trim) P3.2 (deferred): merge the lifecycle URN into the seal
 * subject — return `contextGraphAssertionUri(...)` here (keep this URN shape
 * as `assertionLifecycleUriLegacy` for read-both) so state/memoryLayer/
 * assertionGraph/assertionName/kaId/reservedUal/per-layer pointers/
 * wasAttributedTo land on the one `{cg}/assertion/{addr}/{name}` node
 * (−5 quads/KA). Deferred from the Phase-3 stage because the audit during
 * implementation surfaced two hazards that need their own pass:
 *   1. Subject collision with AUTHOR-SIGNED material: the seal +
 *      publish-receipt rows live on the seal subject; subject-scoped wipes
 *      (`assertionCreate` clean-slate, `deleteByPattern({subject})` sites)
 *      would delete them unless the preserve set is extended to
 *      ASSERTION_SEAL_PREDICATES + ASSERTION_PUBLISH_RECEIPT_PREDICATES.
 *   2. Identity double-allocation: the finalize `hasExistingKaId` guard,
 *      the re-finalize reservedUal reuse and the A2 preserve step read
 *      kaId/reservedUal by EXACT subject — each needs read-both
 *      (new-subject ‖ this legacy URN) with new-first precedence, or
 *      upgraded nodes re-allocate KA numbers and fork UALs.
 * Read-both is also required in: history + resolveByKaId (dkg-agent.ts —
 * the URN-prefix author parse), sync replication scope, promote guards,
 * PROV event targets, node-ui receipt/lifecycle-feed hooks (the receipt
 * hook already reads both shapes — see useEntityOnChainReceipt P3.4).
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

/**
 * the public `_catalog` subgraph of a (private) CG: the
 * bounded, plaintext, core-servable named graph holding the CG's DCAT catalog
 * entry. `_`-prefixed, so it cannot collide with a user sub-graph name
 * (`validateSubGraphName` reserves the prefix). This is the serving / open-serve
 * boundary; the catalog quads are committed inside the CG's own VM merkle root
 * (combined model), and the partition routing them here happens at publish time.
 */
export function contextGraphCatalogUri(contextGraphId: string): string {
  return `did:dkg:context-graph:${contextGraphId}/_catalog`;
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
