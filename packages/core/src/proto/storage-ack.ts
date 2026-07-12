/**
 * Protobuf wire schemas used by this module for encode/decode helpers.
 *
 * The `*Schema` consts below are exported strictly for backwards
 * compatibility with external consumers that deep-imported them
 * before `@origintrail-official/dkg-core` had an `exports` map.
 * They are implementation detail — prefer the `*Msg` types and
 * `encode*` / `decode*` functions re-exported from
 * `packages/core/src/proto/index.ts`.
 *
 * @internal
 */
import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

/**
 * Storage ACK message (spec §9.0.3).
 *
 * Sent by core nodes to attest that they have stored the data and
 * computed a matching merkle root. The ACK signature scheme is:
 *   ACK = EIP-191(computePublishACKDigest(chainId, kav10Address, cgId,
 *     merkleRoot, kaCount, byteSize, epochs, tokenAmount))
 * — the H5-prefixed 8-field digest. See `packages/core/src/crypto/ack.ts`
 * for the packed layout; matches `KnowledgeAssetsV10.sol:362-373`
 * byte-for-byte.
 */

/**
 * Declinable reasons a core node can return on `/dkg/10.0.1/storage-ack`
 * instead of a signed ACK. These are situations where the core
 * legitimately cannot produce an ACK for THIS PEER right now — a
 * well-formed publish request that this specific core just can't
 * satisfy.
 *
 * Codes split into two classes that the publisher treats differently:
 *
 * - **Transient** ({@link TRANSIENT_STORAGE_ACK_DECLINE_CODES}):
 *   the local condition is expected to clear on its own (e.g. SWM is
 *   catching up via gossip). The publisher retries the same peer with
 *   the existing transport backoff before giving up — keeps quorum
 *   reachable when replication is just slightly behind the publish.
 *
 * - **Permanent** (every other code):
 *   the condition will not change on a fast retry (e.g. the operational
 *   signer was rotated off-chain). The publisher deselects this peer
 *   for THIS request and moves on to others; the reason is surfaced
 *   in the final error if quorum still fails.
 *
 * Malformed-request errors are NOT declines and do NOT belong here.
 * The handler keeps `throw`ing on those so the publisher sees them as
 * stream errors with the original message and surfaces them to the
 * caller immediately rather than fanning out to every core looking
 * for a different answer.
 *
 * String values are part of the wire format: they are populated into
 * `StorageACK.declineCode` and surfaced in publisher logs / error
 * messages. Keep them stable across releases. Adding a new code is a
 * non-breaking change (older publishers see it as the catch-all
 * "unknown decline" path); renaming or removing one IS breaking.
 */
export const STORAGE_ACK_DECLINE_CODES = {
  /** SWM CONSTRUCT returned no quads for the request. */
  NO_DATA_IN_SWM: 'NO_DATA_IN_SWM',
  /** SWM has data but its merkle root does not match the publisher's. */
  MERKLE_MISMATCH_IN_SWM: 'MERKLE_MISMATCH_IN_SWM',
  /** Operational signer was just removed / rotated off-chain. */
  SIGNER_NOT_REGISTERED: 'SIGNER_NOT_REGISTERED',
  /**
   * OT-RFC-38 LU-11 / OT-RFC-39 — V2 chunked ACK: one or more of the
   * `ciphertextChunkCount` ciphertext chunks the publisher claims are
   * staged for this batch were not found locally under
   * `urn:dkg:swm:v10-publish-ciphertext-chunk/<batchId>/<i>`. Typical
   * causes: a chunk-emitting SWM gossip was lost in flight; the core
   * just subscribed and hasn't backfilled yet; an attacker is bluffing.
   * Transient — the publisher should retry against this peer once the
   * late-join sync verb has a chance to backfill.
   */
  MISSING_CIPHERTEXT_CHUNKS: 'MISSING_CIPHERTEXT_CHUNKS',
  /**
   * OT-RFC-38 LU-11 / OT-RFC-39 — V2 chunked ACK: all chunks were
   * present locally but the recomputed `ciphertextChunksRoot` does
   * not match the publisher's claim. Permanent (a content-integrity
   * lie); the publisher MUST republish with a corrected commitment.
   *
   * @deprecated OT-RFC-49 stripped the ciphertext-chunk ACK path; the
   * curated ACK now uses {@link CATALOG_ROOT_MISMATCH}. Kept for wire
   * stability so a mixed-version publisher still decodes the string.
   */
  CIPHERTEXT_ROOT_MISMATCH: 'CIPHERTEXT_ROOT_MISMATCH',
  /**
   * OT-RFC-49 / WS-D — curated ACK: the core rebuilt the catalog root
   * over the publisher's inline catalog `stagingQuads` (via
   * `computeCatalogRoot(catalogCommittedLeaves(...))`) and it does NOT
   * match the publisher's claimed `catalogRoot`/`catalogLeafCount`.
   * Permanent (a content-integrity lie); the publisher MUST republish
   * with a corrected commitment.
   */
  CATALOG_ROOT_MISMATCH: 'CATALOG_ROOT_MISMATCH',
  /**
   * The publisher claimed a `publicByteSize` below the lower bound the core
   * derives from the actual public quads it would attest to. `byteSize` is
   * signed into the ACK digest and prices the publish on-chain
   * (`ask · byteSize · epochs`); the contract can't see the content, so a core
   * MUST refuse to sign an under-stated footprint — otherwise the on-chain cost
   * can be driven toward zero (e.g. `byteSize = 1` for real content) regardless
   * of the ask. Permanent (a content/economic-shape lie); the publisher MUST
   * republish with a `byteSize` that reflects the real content.
   */
  BYTESIZE_UNDERCLAIM: 'BYTESIZE_UNDERCLAIM',
  /**
   * The core hit a peer-LOCAL, transient infrastructure failure while
   * servicing an otherwise well-formed request: its triple store errored
   * mid-read/write (e.g. a managed or external store restarting and refusing
   * a connection) or its live signer-registration chain lookup threw
   * (a degraded shared RPC). Introduced after the testnet storage-ACK
   * dead-air incident: every such failure previously THREW out of the
   * handler, which ProtocolRouter's inbound wrapper surfaces as a bare
   * stream abort with NO reply — the publisher burned its 3 transport
   * retries and bucketed the peer as `no_response` (7 cores dialled,
   * 21 send attempts, ALL `no_response`, 0 declines — zero diagnostic
   * signal). Transient — the store worker recovers / the RPC comes back,
   * so the publisher retries on the normal transient-decline cadence.
   * Old publishers that pre-date this code treat it as a terminal decline
   * WITH a reason, which is still strictly better than dead air.
   */
  CORE_TEMPORARILY_UNAVAILABLE: 'CORE_TEMPORARILY_UNAVAILABLE',
} as const;

export type StorageACKDeclineCode =
  (typeof STORAGE_ACK_DECLINE_CODES)[keyof typeof STORAGE_ACK_DECLINE_CODES];

/**
 * Decline codes whose root cause is expected to clear on its own
 * (typically SWM replication catching up via gossip). The publisher
 * retries these against the same peer through the normal transport
 * backoff before giving up, so a peer that would have ACKed seconds
 * later still contributes to quorum.
 *
 * Membership of this set is part of the protocol contract between
 * publisher and core — promoting / demoting a code is a behavior
 * change, not a wire change.
 */
export const TRANSIENT_STORAGE_ACK_DECLINE_CODES: ReadonlySet<string> = new Set<string>([
  STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM,
  STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM,
  // LU-11: a missing chunk usually means a gossip lost or a late-join
  // sync hasn't backfilled yet — both clear on the publisher's normal
  // retry cadence once SWM has caught up. A root mismatch is NOT
  // transient: the publisher's commitment is wrong, no amount of
  // waiting fixes it.
  STORAGE_ACK_DECLINE_CODES.MISSING_CIPHERTEXT_CHUNKS,
  // Dead-air fix: a store/RPC blip on the core clears when the local
  // local store or the shared RPC recovers — the same "wait a few
  // seconds and re-ask" cadence as SWM catch-up. Marking it transient
  // keeps a briefly-degraded core in the quorum pool instead of
  // deselecting it on the first blip.
  STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE,
]);

/** True iff `code` names a decline the publisher should retry rather than treat as permanent. */
export function isTransientStorageACKDeclineCode(code: string | undefined): boolean {
  return typeof code === 'string' && TRANSIENT_STORAGE_ACK_DECLINE_CODES.has(code);
}

/** The fixed, known decline-code enum values — the ONLY values permitted as a metric label. */
const KNOWN_STORAGE_ACK_DECLINE_CODES: ReadonlySet<string> = new Set<string>(
  Object.values(STORAGE_ACK_DECLINE_CODES),
);

/**
 * Bound a decline code to the known enum for use as a low-cardinality METRIC
 * label. A `declineCode` read off a peer's StorageACK is UNTRUSTED — a malicious
 * or buggy peer could emit endless unique codes and explode metric cardinality —
 * so anything outside the fixed enum maps to `'other'`. The full (sanitized)
 * code still rides logs and the `declines` diagnostic map; only the metric
 * dimension is bounded.
 */
export function boundedDeclineCodeLabel(code: string | undefined | null): string {
  return typeof code === 'string' && KNOWN_STORAGE_ACK_DECLINE_CODES.has(code) ? code : 'other';
}

/**
 * RC11 / PR5 — ACK-provenance telemetry: which of the four LU-6
 * Phase B discovery paths caused this core to be hosting the
 * curated CG's SWM substrate at ACK time. Populated by the
 * StorageACK handler from its host-mode-source resolver hook;
 * surfaced through the publisher's per-publish ACK-provenance
 * summary log + `QuorumUnmetError.peerOutcomes`.
 *
 * Source values:
 *   - `chain-event`: core auto-subscribed off a `ContextGraphCreated`
 *      chain event (PR4 path 1). Steady-state default for registered
 *      curated CGs on rc.10 cores.
 *   - `beacon`: core picked up the CG off the global discovery
 *      beacon topic (path 2). Used for pre-registration / off-chain-
 *      only CGs.
 *   - `reconciler`: periodic `hostModeReconcilerTimer` healed a
 *      subscription the first two paths missed (path 3). Indicates
 *      the chain event was lost / a beacon was missed / state was
 *      restored on restart.
 *   - `manual`: operator-driven `POST /api/shared-memory/host-mode/
 *      subscribe` enrolled this core for this CG (path 4). Indicates
 *      the operator deliberately bypassed automatic discovery.
 *   - `member`: local node is a CG MEMBER (not just a host); the
 *      member-mode SWM handler is authoritative. Differentiated from
 *      the host-mode sources because members can decrypt and member
 *      ACKs come with full plaintext verification.
 *
 * Strictly additive wire change: old senders never set field 8; old
 * receivers ignore it. New receivers treat an unset value as "source
 * unknown" (legacy peer, or pre-PR5 build) rather than promoting any
 * default — provenance-driven UI should render the empty case
 * explicitly.
 */
export const SUBSCRIPTION_SOURCES = {
  CHAIN_EVENT: 'chain-event',
  BEACON: 'beacon',
  RECONCILER: 'reconciler',
  MANUAL: 'manual',
  MEMBER: 'member',
} as const;

export type SubscriptionSource =
  (typeof SUBSCRIPTION_SOURCES)[keyof typeof SUBSCRIPTION_SOURCES];

/** Closed set of valid `subscriptionSource` strings. */
export const SUBSCRIPTION_SOURCE_VALUES: ReadonlySet<string> = new Set<string>(
  Object.values(SUBSCRIPTION_SOURCES),
);

/** True iff `value` is one of the documented `SubscriptionSource` strings. */
export function isSubscriptionSource(value: unknown): value is SubscriptionSource {
  return typeof value === 'string' && SUBSCRIPTION_SOURCE_VALUES.has(value);
}

/**
 * Wire schema. Fields 1–5 are the original ACK shape; fields 6–7 carry
 * a decline payload; field 8 carries PR5 ACK-provenance telemetry.
 * Optional string fields (rather than a `oneof`) keep every addition
 * strictly additive: old encoders never set the new fields, old
 * decoders silently ignore them, so cross-version traffic is
 * unchanged. New decoders inspect `declineCode` first — when it is
 * non-empty the message is a decline and the ACK fields are unset;
 * `subscriptionSource` is only meaningful on a signed ACK and is
 * blank / absent on a decline.
 */
export const StorageACKSchema = new Type('StorageACK')
  .add(new Field('merkleRoot', 1, 'bytes'))
  .add(new Field('coreNodeSignatureR', 2, 'bytes'))
  .add(new Field('coreNodeSignatureVS', 3, 'bytes'))
  .add(new Field('contextGraphId', 4, 'string'))
  .add(new Field('nodeIdentityId', 5, 'uint64'))
  .add(new Field('declineCode', 6, 'string'))
  .add(new Field('declineMessage', 7, 'string'))
  .add(new Field('subscriptionSource', 8, 'string'));

type Long = { low: number; high: number; unsigned: boolean };

export interface StorageACKMsg {
  merkleRoot: Uint8Array;
  coreNodeSignatureR: Uint8Array;
  coreNodeSignatureVS: Uint8Array;
  contextGraphId: string;
  nodeIdentityId: number | Long;
  /**
   * When non-empty, this message is a decline rather than a signed ACK
   * — see {@link STORAGE_ACK_DECLINE_CODES}. Old senders never set this
   * field; old receivers ignore it. New receivers MUST check this
   * before treating the message as an ACK (signature/merkleRoot are
   * unset on declines).
   */
  declineCode?: string;
  /**
   * Human-readable reason that accompanies `declineCode`. Surfaced into
   * publisher logs and the final `storage_ack_insufficient` error so
   * operators can diagnose hosting / replication issues without having
   * to ssh into individual cores.
   */
  declineMessage?: string;
  /**
   * RC11 / PR5 ACK-provenance — which of the four LU-6 Phase B paths
   * caused this core to be hosting the curated CG's SWM substrate at
   * ACK time. See {@link SUBSCRIPTION_SOURCES} for the closed set of
   * values. Optional: empty / unset means "source unknown" (legacy
   * peer, public CG that has no host-mode subscription concept, or a
   * pre-PR5 core build). Only meaningful on a signed ACK.
   */
  subscriptionSource?: string;
}

/**
 * Convenience: returns true iff the message is a decline (i.e.
 * `declineCode` is set to a non-empty string). Keeps callers from
 * having to remember the empty-string-as-undefined idiom that
 * protobufjs uses for unset string fields.
 */
export function isStorageACKDecline(msg: StorageACKMsg): boolean {
  return typeof msg.declineCode === 'string' && msg.declineCode.length > 0;
}

export function encodeStorageACK(msg: StorageACKMsg): Uint8Array {
  return StorageACKSchema.encode(
    StorageACKSchema.create(msg),
  ).finish();
}

export function decodeStorageACK(buf: Uint8Array): StorageACKMsg {
  return StorageACKSchema.decode(buf) as unknown as StorageACKMsg;
}
