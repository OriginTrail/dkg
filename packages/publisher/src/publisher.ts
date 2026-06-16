import type { Quad } from '@origintrail-official/dkg-storage';
import type { OnChainPublishResult } from '@origintrail-official/dkg-chain';
import type { OperationContext } from '@origintrail-official/dkg-core';

export const DEFAULT_PUBLISH_EPOCHS = 12;
/** PublishIntent encodes epochs as uint32; reject larger overrides before wire encoding. */
export const MAX_PUBLISH_EPOCHS = 0xffffffff;

export interface KAManifestEntry {
  tokenId: bigint;
  rootEntity: string;
  privateMerkleRoot?: Uint8Array;
  privateTripleCount?: number;
}

export type PhaseCallback = (phase: string, status: 'start' | 'end') => void;

export type ReceiverSignature = { identityId: bigint; r: Uint8Array; vs: Uint8Array };

/**
 * Callback that collects receiver signatures from peers.
 * Called AFTER data preparation, BEFORE on-chain tx.
 */
export type ReceiverSignatureProvider = (
  merkleRoot: string,
  publicByteSize: bigint,
) => Promise<ReceiverSignature[]>;

/**
 * V10 core node ACK signature collected via /dkg/10.0.1/storage-ack.
 * Spec §9.0.3: ACK = EIP-191(computePublishACKDigest(chainId, kav10Address,
 *   contextGraphId, merkleRoot, kaCount, byteSize, epochs, tokenAmount))
 */
export interface V10CoreNodeACK {
  peerId: string;
  signatureR: Uint8Array;
  signatureVS: Uint8Array;
  nodeIdentityId: bigint;
  /**
   * PR5 ACK-provenance: which of the four LU-6 Phase B discovery
   * paths (chain-event / beacon / reconciler / manual) or member-mode
   * the responding core reported was its reason for hosting this CG
   * at ACK time. `undefined` for legacy / pre-PR5 cores that don't
   * yet populate the wire field. Surfaced through the publisher's
   * per-publish ACK-provenance summary line on success.
   */
  subscriptionSource?: import('@origintrail-official/dkg-core').SubscriptionSource;
}

/**
 * Callback that collects V10 StorageACKs from 3 core nodes.
 * Called AFTER merkle root computation, BEFORE on-chain tx.
 *
 * Identifier split (remap support): `contextGraphId` is the TARGET on-chain
 * numeric CG id that the ACK digest and the on-chain tx use. `swmGraphId`
 * (optional) is the SOURCE graph where the data lives in SWM — peers load
 * quads from `<swmGraphId>` but sign the ACK over `<contextGraphId>`. When
 * omitted, peers fall back to `contextGraphId` for both.
 *
 * stagingQuads: optional N-Quads bytes to send inline to core nodes so
 * they can verify the merkle root without needing SWM pre-positioning.
 */
export type V10ACKProvider = (
  merkleRoot: Uint8Array,
  contextGraphId: string,
  kaCount: number,
  rootEntities: string[],
  publicByteSize: bigint,
  stagingQuads: Uint8Array | undefined,
  epochs: number | undefined,
  tokenAmount: bigint | undefined,
  swmGraphId: string | undefined,
  subGraphName: string | undefined,
  /** V10 flat-KC Merkle leaf count (sorted + deduped); binds ACK + on-chain KC to RandomSampling. */
  merkleLeafCount: number,
  /**
   * OT-RFC-49 / WS-D — when `true`, this is a CURATED publish: `stagingQuads`
   * carries the PUBLIC `_catalog` N-quads (plaintext — the catalog is public),
   * and the private data is encrypted for MEMBERS only (off the ACK wire).
   * Cores skip the flat-KC plaintext recompute (they don't hold the private
   * data) and instead rebuild + verify the catalog root from `catalogCommitment`
   * against the inline `stagingQuads`. Defaults to `false` so existing public-CG
   * callers are unchanged.
   */
  isEncryptedPayload?: boolean,
  /**
   * OT-RFC-49 / WS-D — the CURATED PUBLIC `_catalog` commitment for this
   * publish (REPLACED the stripped ciphertext-chunks commitment). When present,
   * the publisher computed `computeCatalogRoot(catalogCommittedLeaves(...))`
   * over the committed catalog leaf-set; the same `(catalogRoot, catalogLeafCount)`
   * is signed into the V10 ACK digest, lands on-chain, and is what the core
   * rebuilds over the inline catalog `stagingQuads` (DECLINE `CATALOG_ROOT_MISMATCH`
   * on disagreement). Required when `isEncryptedPayload === true` AND the curated
   * CG has a catalog entry; absent for public CGs.
   */
  catalogCommitment?: {
    catalogRoot: Uint8Array;
    catalogLeafCount: number;
  },
) => Promise<V10CoreNodeACK[]>;

/**
 * V10 update ACK provider: collects core node signatures over the update ACK
 * digest before `updateKnowledgeCollectionV10` is broadcast.
 *
 * The publisher passes ALL fields the 13-field UPDATE ACK digest binds so
 * the off-chain-signed digest is byte-identical to the on-chain verify.
 * The on-chain-resolved fields (`contextGraphId`, `preUpdateMerkleRootCount`,
 * `newTokenAmount`, `mintAmount`, `burnTokenIds`) MUST be sourced from the
 * SAME place the chain adapter resolves them for the update tx — the
 * publisher reads them via `chain.getUpdateAckDigestFields(...)` and threads
 * the resolved `newTokenAmount` straight into the update tx as
 * `boundNewTokenAmount` so there is no recompute drift.
 */
export type V10UpdateACKProvider = (params: {
  kaId: bigint;
  /** TARGET on-chain numeric context graph id (decimal string). */
  contextGraphId: string;
  /** Pre-update on-chain Merkle-roots array length for this KA. */
  preUpdateMerkleRootCount: bigint;
  newMerkleRoot: Uint8Array;
  newByteSize: bigint;
  /** Floored newTokenAmount the on-chain tx will submit (digest re-floors identically). */
  newTokenAmount: bigint;
  mintAmount: bigint;
  burnTokenIds: bigint[];
  newMerkleLeafCount: number;
  newCatalogRoot?: Uint8Array;
  newCatalogLeafCount?: number;
  /** Updated KC quads (N-Quads) so peers can recompute newMerkleRoot. */
  stagingQuads?: Uint8Array;
  /**
   * OT-RFC-49 / WS-D — when true, this is a CURATED update: `stagingQuads`
   * carries the PUBLIC `_catalog` N-quads (not the full KC), the private data
   * is member-encrypted, and the core takes the curated ACK branch (trusts the
   * claimed `newMerkleRoot`, verifies the CG is curated, signs the digest with
   * the `(newCatalogRoot, newCatalogLeafCount)` commitment). Public updates
   * leave this `undefined`.
   */
  isEncryptedPayload?: boolean;
  /** Source SWM graph id (defaults to contextGraphId). */
  swmGraphId?: string;
  subGraphName?: string;
}) => Promise<V10CoreNodeACK[]>;

/**
 * Callback that collects participant signatures for context graph governance.
 */
export type ParticipantSignatureProvider = (
  contextGraphId: bigint,
  merkleRoot: string,
) => Promise<ReceiverSignature[]>;

export interface PublishOptions {
  contextGraphId: string;
  quads: Quad[];
  privateQuads?: Quad[];
  /** Publisher peer ID used for KC ownership/access metadata. */
  publisherPeerId?: string;
  /** KC-level private access policy metadata. */
  accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  /** Allowed peer IDs when accessPolicy is allowList. */
  allowedPeers?: string[];
  manifest?: KAManifestEntry[];
  operationCtx?: OperationContext;
  /**
   * When true, triples are grouped by root entity and each group gets its
   * own `kaRoot`. The `kcMerkleRoot` is a Merkle tree over sorted `kaRoot`
   * values, enabling selective disclosure (prove one entity without
   * revealing others). Off by default — the flat hash is simpler and cheaper.
   */
  entityProofs?: boolean;
  /** Optional callback invoked at each phase boundary for instrumentation. */
  onPhase?: PhaseCallback;
  /** Override the data graph URI (used for context graph publishing). */
  targetGraphUri?: string;
  /** Override the meta graph URI (used for context graph publishing). */
  targetMetaGraphUri?: string;
  /**
   * Target sub-graph name within the context graph. When set, data is stored
   * in `did:dkg:context-graph:{id}/{subGraphName}` and metadata in
   * `did:dkg:context-graph:{id}/{subGraphName}/_meta`. Sub-graphs are
   * convention-based partitions — no on-chain enforcement in V10.0.
   */
  subGraphName?: string;
  /** @deprecated V9 receiver signatures removed — use v10ACKProvider instead. */
  receiverSignatureProvider?: ReceiverSignatureProvider;
  /**
   * V10 ACK provider: collects core node StorageACKs via P2P.
   * When provided, ACKs are collected and stored in the result.
   */
  v10ACKProvider?: V10ACKProvider;
  /** V10 update ACK provider — quorum signatures before on-chain update. */
  v10UpdateACKProvider?: V10UpdateACKProvider;
  /**
   * When publishing into a specific context graph (publishFromSharedMemory),
   * this overrides contextGraphId as the ACK domain and on-chain contextGraphId.
   */
  publishContextGraphId?: string;
  /**
   * When true, the data is already in peers' SWM via shared memory gossip.
   * V10 ACK collection will NOT send inline staging quads — core nodes
   * verify against their local SWM copy (storage-attestation guarantee).
   */
  fromSharedMemory?: boolean;
  /**
   * OT-RFC-38 / LU-5. When set, the publisher routes the inline ACK
   * payload through this hook to produce AEAD ciphertext bytes that
   * cores hold opaquely. The publisher will then send `stagingQuads =
   * ciphertext` with `isEncryptedPayload: true` so cores skip
   * merkle-root recompute and just sign the V10 digest the publisher
   * claimed. Member post-decrypt verification (LU-8) catches plaintext
   * mismatches; outsider attestation tokens (LU-9) cover third parties.
   *
   * `fromSharedMemory` is forced `true` when this hook is set —
   * encrypted-payload mode and the "data is in SWM already" semantic
   * coexist (curated CGs always read from SWM, then encrypt for the
   * ACK trip).
   *
   * Resolved by the caller (DKGAgent) based on the CG's access
   * policy. Public CGs leave this `undefined` and continue to ship
   * plaintext nquads inline.
   */
  encryptInlinePayload?: (plaintextNquads: Uint8Array) => Promise<Uint8Array> | Uint8Array;
  /**
   * OT-RFC-38 LU-11 / OT-RFC-39. The chunked-AEAD sibling of
   * `encryptInlinePayload`. When set AND `encryptInlinePayload` is
   * also set, the chunked path takes precedence: the publisher slices
   * the plaintext into N chunks, encrypts each with a deterministic
   * per-chunk nonce, fans the per-chunk ciphertexts out via SWM
   * gossip (one envelope per chunk, with `swmMessageIndex` + chunked
   * type marker), and sends an empty `stagingQuads` ACK request
   * carrying only the resulting `ciphertextChunksRoot` +
   * `ciphertextChunkCount` over `PROTOCOL_STORAGE_ACK_V2`. The
   * `batchId` argument lets the agent's implementation key each
   * chunk's persistence slot to the V10 KC `merkleRoot` so cores can
   * index per-chunk ciphertexts by `(cgId, batchId, chunkIndex)` for
   * RFC-39 random sampling. `publishOperationId` is intentionally
   * separate: it is the unique per-operation nonce domain for chunked
   * AEAD, so the same merkle root can never force nonce reuse across
   * distinct publish attempts. Returning bytes is intentionally NOT
   * exposed here — the chunks live on the SWM substrate, never in the
   * ACK request.
   */
  encryptInlineChunked?: (input: {
    plaintextNquads: Uint8Array;
    batchId: Uint8Array;
    publishOperationId: string;
  }) => Promise<{
    ciphertextChunksRoot: Uint8Array;
    ciphertextChunkCount: number;
    /**
     * Ciphertext byte size the publisher signed into the V10 ACK
     * digest. Concatenation of every per-chunk ciphertext length —
     * used downstream as `publicByteSize` for pricing parity with
     * the LU-5 single-blob path.
     */
    totalCiphertextBytes: number;
  }>;
  /** When true, the KC was created via V10 and updates should use the V10 path. */
  v10Origin?: boolean;
  /**
   * On-chain publish lifetime in epochs. Omitted ordinary publishes use
   * {@link DEFAULT_PUBLISH_EPOCHS}; PCA-funded publishes with no explicit
   * override are coerced to the PCA lockDurationEpochs for discount parity.
   */
  publishEpochs?: number;
  /**
   * Per-publish override for the on-chain `PublishParams.publisherNodeIdentityId`
   * attribution field (RFC-001 §4 attribution control).
   *
   * Default (`undefined`): use the publisher's persistent
   * `publisherNodeIdentityId` (the daemon's own identity), preserving the
   * pre-RFC-001 single-tenant semantics.
   *
   * Explicit `bigint` (including `0n`): use this exact value as the
   * on-chain attribution target. Lets a publisher service route a publish
   * with attribution credit going to a different core (modes a/b/c) or to
   * no one at all (mode d, value `0n`). The contract validates that any
   * non-zero value names a real sharding-table node.
   *
   * SCOPE: this controls the on-chain attribution field ONLY. The
   * publisher's own identity is still used for ACK self-signing (when
   * applicable) and signer resolution — those are about WHO the daemon
   * is, not WHO gets attribution credit. Per-call (no global mutation),
   * so concurrent publishes with conflicting overrides are safe.
   */
  publisherNodeIdentityIdOverride?: bigint;
  /**
   * RFC-001 §9.x — pre-computed AuthorAttestation produced at the
   * `agent.assertion.finalize()` boundary. This is the canonical
   * (and, post-Phase-C, the *only*) way to attribute authorship for
   * an on-chain publish.
   *
   * The caller has already:
   *   1. Computed `expectedMerkleRoot` over the same quads it is
   *      now asking the publisher to publish (computed via
   *      `computeFlatKCRoot` / `skolemizeByEntity` semantics).
   *   2. Signed (or collected a signature for) the typed data
   *      `buildAuthorAttestationTypedData({ chainId, kav10Address,
   *      contextGraphId, merkleRoot: expectedMerkleRoot,
   *      authorAddress })`.
   *
   * The publisher independently re-derives `kcMerkleRoot` from the
   * supplied `quads` and asserts equality with
   * `expectedMerkleRoot`. Mismatch = throw, because either the
   * caller's compute path drifted from the publisher's, or the
   * quads were mutated between finalize and publish.
   *
   * The compact `(r, vs)` and `authorAddress` are forwarded to
   * KAv10 verbatim. The publisher NEVER signs the AuthorAttestation
   * itself.
   *
   * For publish flows where no agent is provided, the agent layer
   * falls back to signing with the publisher's own EOA (via
   * `signAuthorAttestationAsPublisher`) at finalize-time, so the
   * publisher EOA still becomes `KC.author` in that case — but the
   * signature is produced by the agent layer, not by `publish()`.
   */
  precomputedAttestation?: {
    expectedMerkleRoot: Uint8Array;
    authorAddress: string;
    signature: { r: Uint8Array; vs: Uint8Array };
    schemeVersion: number;
    /**
     * OT-RFC-43 §F2 — the packed reservedKaId the agent signed the
     * AuthorAttestation over. The publisher REBUILDS the digest with this exact
     * value to verify the seal, and mints with it, so the on-chain id matches
     * the recovered signature. The agent is the single allocation point.
     */
    reservedKaId: bigint;
  };
  /**
   * RFC-001 greenfield — owner seal for on-chain `update`, produced before
   * the hosted API call (mirror of `precomputedAttestation` on publish).
   * Publisher verifies `expectedNewMerkleRoot` and forwards `(authorR, authorVS)`
   * to the chain adapter; it never signs the update attestation itself.
   */
  precomputedUpdateAttestation?: {
    expectedNewMerkleRoot: Uint8Array;
    authorAddress: string;
    signature: { r: Uint8Array; vs: Uint8Array };
    schemeVersion: number;
  };
  /**
   * OT-RFC-43 A2 (decision 1) — precomputed packed kaId
   * `(uint160(author) << 96) | number` reserved at `assertionFinalize`
   * (ALLOCATE-AT-FINALIZE). When supplied, the publisher's `ensureReservedKaId`
   * REUSES this id and SKIPS allocation, so a finalize→publish for one KA mints
   * exactly the stamped id with no second allocation. Undefined for direct /
   * mock publishes — the publisher then keeps its allocate-at-publish behavior
   * (back-compat).
   */
  reservedKaId?: bigint;
}

export interface PublishResult {
  kaId: bigint;
  /** The UAL assigned to this KC (tentative or confirmed). */
  ual: string;
  merkleRoot: Uint8Array;
  kaManifest: KAManifestEntry[];
  status: 'tentative' | 'confirmed' | 'failed';
  onChainResult?: OnChainPublishResult;
  /** Public quads that were stored (used for broadcast — never includes private triples). */
  publicQuads?: Quad[];
  /** Set when KC is confirmed on-chain but context-graph registration failed. */
  contextGraphError?: string;
  /** V10: Core node ACK signatures collected before chain TX (spec §9.0.3). */
  v10ACKs?: V10CoreNodeACK[];
  /** True when the KC was created via KnowledgeAssetsV10 (V10 storage path). */
  v10Origin?: boolean;
  /** Sub-graph the data was published into (for gossip propagation). */
  subGraphName?: string;
}

export interface Publisher {
  publish(options: PublishOptions): Promise<PublishResult>;
  update(kaId: bigint, options: PublishOptions): Promise<PublishResult>;
  skolemizeByEntity(quads: Quad[]): KAManifestEntry[];
  /** @deprecated Use skolemizeByEntity. */
  autoPartition(quads: Quad[]): KAManifestEntry[];
  skolemize(rootEntity: string, quads: Quad[]): Quad[];
}
