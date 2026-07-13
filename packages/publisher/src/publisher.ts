import type { Quad } from '@origintrail-official/dkg-storage';
import type { OnChainPublishResult } from '@origintrail-official/dkg-chain';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { TrustedCatalogTripleKeys } from './catalog-trust.js';

export const DEFAULT_PUBLISH_EPOCHS = 12;
/** PublishIntent encodes epochs as uint32; reject larger overrides before wire encoding. */
export const MAX_PUBLISH_EPOCHS = 0xffffffff;

export interface KAManifestEntry {
  tokenId: bigint;
  rootEntity: string;
  privateMerkleRoot?: Uint8Array;
  privateTripleCount?: number;
}

/** Cancellation context used by pre-broadcast durability phases. */
export interface PhaseCallbackContext {
  /**
   * Aborted when the adapter abandons the associated transaction. Durable
   * listeners must check this after awaited work and suppress late writes.
   */
  signal?: AbortSignal;
  /** Pre-broadcast transaction identity for durable write-ahead listeners. */
  txHash?: string;
}

export type PhaseCallback = (
  phase: string,
  status: 'start' | 'end',
  context?: PhaseCallbackContext,
) => Promise<void> | void;

export interface PhaseScopeOptions {
  startContext?: PhaseCallbackContext;
  endContext?: PhaseCallbackContext;
}

export interface PhaseScope {
  /** Emit the matching end exactly once, even when multiple cleanup paths call close(). */
  close(): Promise<void>;
}

/**
 * Settle phase-owned work and its cleanup without losing either failure.
 * This is shared by ordinary reporter scopes and callbacks that open their
 * phase lazily from inside an adapter operation.
 */
export async function runWithPhaseCleanup<T>(
  phase: string,
  work: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let value!: T;
  let workFailed = false;
  let workError: unknown;
  try {
    value = await work();
  } catch (error) {
    workFailed = true;
    workError = error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (workFailed) {
      // A lazy opener can be awaited by both the adapter and cleanup path.
      // If both observed the exact same rejection, preserve it once rather
      // than manufacturing an AggregateError with duplicate entries.
      if (cleanupError === workError) throw workError;
      throw new AggregateError(
        [workError, cleanupError],
        `Phase ${phase} work and end callback both failed`,
      );
    }
    throw cleanupError;
  }
  if (workFailed) throw workError;
  return value;
}

/**
 * Awaited phase lifecycle boundary with closeable and scoped orchestration.
 *
 * `open()` never returns a scope when the start listener rejects, so an end is
 * not fabricated for a phase that did not open. A returned scope caches its
 * close promise, making cleanup idempotent even when the end listener rejects.
 * `scope()` closes in `finally`, balancing successful and failed work.
 */
export class PhaseReporter {
  constructor(private readonly callback?: PhaseCallback) {}

  async emit(
    phase: string,
    status: 'start' | 'end',
    context?: PhaseCallbackContext,
  ): Promise<void> {
    await this.callback?.(phase, status, context);
  }

  async open(phase: string, options: PhaseScopeOptions = {}): Promise<PhaseScope> {
    await this.emit(phase, 'start', options.startContext);
    let closePromise: Promise<void> | undefined;
    return {
      close: () => {
        closePromise ??= this.emit(phase, 'end', options.endContext);
        return closePromise;
      },
    };
  }

  async scope<T>(
    phase: string,
    work: () => Promise<T>,
    options: PhaseScopeOptions = {},
  ): Promise<T> {
    const scope = await this.open(phase, options);
    return runWithPhaseCleanup(phase, work, scope.close);
  }
}

/**
 * The single phase-callback execution boundary. Every publisher emitter awaits
 * this helper, so async listeners preserve phase ordering and a rejection is
 * observed by the operation instead of becoming an unhandled background task.
 */
export async function invokePhaseCallback(
  callback: PhaseCallback | undefined,
  phase: string,
  status: 'start' | 'end',
  context?: PhaseCallbackContext,
): Promise<void> {
  await new PhaseReporter(callback).emit(phase, status, context);
}

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
 * V10 core node ACK signature collected via storage-ack. Public/catalog ACKs
 * use /dkg/10.0.1/storage-ack; folded-private ACKs require
 * /dkg/10.0.2/storage-ack so field 20 support is capability-gated.
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

export interface V10CatalogACKCommitment {
  catalogRoot: Uint8Array;
  catalogLeafCount: number;
}

/**
 * ACK modes are intentionally mutually exclusive:
 * - public: ordinary public-CG ACKs; no private roots or catalog commitment.
 * - folded-private: public-CG ACKs that fold private Merkle commitments into
 *   the KC root without sending private plaintext to cores.
 * - curated-catalog: curated-CG ACKs that sign the public `_catalog`
 *   commitment. This mode cannot carry folded-private roots because cores
 *   cannot verify both the curated catalog and private commitments today.
 */
export type V10ACKMode =
  | { kind: 'public' }
  | { kind: 'folded-private'; privateMerkleRoots: readonly Uint8Array[] }
  | { kind: 'curated-catalog'; catalogCommitment: V10CatalogACKCommitment };

export interface V10ACKProviderBaseParams {
  merkleRoot: Uint8Array;
  /** TARGET on-chain numeric CG id that the ACK digest and on-chain tx use. */
  contextGraphId: string;
  kaCount: number;
  rootEntities: string[];
  publicByteSize: bigint;
  epochs?: number;
  tokenAmount?: bigint;
  /**
   * SOURCE graph where data lives in SWM. When omitted, peers fall back to
   * `contextGraphId` for both source and target.
   */
  swmGraphId?: string;
  subGraphName?: string;
  /** V10 flat-KC Merkle leaf count (sorted + deduped); binds ACK + on-chain KC to RandomSampling. */
  merkleLeafCount: number;
  /** Canonical KA UAL used by receiver-side lifecycle logs. */
  assetUal?: string;
}

export type V10ACKProviderParams =
  | (V10ACKProviderBaseParams & {
      ackMode: { kind: 'public' };
      /** Optional N-Quads bytes to send inline so cores can verify without SWM pre-positioning. */
      stagingQuads?: Uint8Array;
    })
  | (V10ACKProviderBaseParams & {
      ackMode: { kind: 'folded-private'; privateMerkleRoots: readonly Uint8Array[] };
      /** Public N-Quads bytes only. Private plaintext must never be sent. */
      stagingQuads?: Uint8Array;
    })
  | (V10ACKProviderBaseParams & {
      ackMode: { kind: 'curated-catalog'; catalogCommitment: V10CatalogACKCommitment };
      /** Public `_catalog` N-Quads bytes. Curated private data stays encrypted off the ACK wire. */
      stagingQuads: Uint8Array;
    });

/**
 * Callback that collects V10 StorageACKs from core nodes.
 * Called AFTER merkle root computation, BEFORE on-chain tx.
 */
export type V10ACKProviderObject = (params: V10ACKProviderParams) => Promise<V10CoreNodeACK[]>;

/**
 * Compatibility shape for integrations that implemented the original
 * positional callback contract before ACK mode became explicit. The object
 * provider is the canonical form for new code; folded-private publishes require
 * the object form because the old positional contract had no private-root slot.
 */
export type LegacyV10ACKProvider = (
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
  merkleLeafCount: number,
  isEncryptedPayload?: boolean,
  catalogCommitment?: V10CatalogACKCommitment,
) => Promise<V10CoreNodeACK[]>;

export type V10ACKProvider = V10ACKProviderObject | LegacyV10ACKProvider;

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
  /**
   * OT-RFC-49 / WS-D — set `true` for a curated update so the agent closure
   * forwards it into `collectUpdate`, stamping `UpdateIntent.isEncryptedPayload`.
   * Cores gate the inline-catalog rebuild/verify/persist path on this flag.
   * Omitted (undefined) for public updates — no catalog; unchanged on a healthy chain.
   */
  isEncryptedPayload?: boolean;
  /** Updated KC quads (N-Quads) so peers can recompute newMerkleRoot. */
  stagingQuads?: Uint8Array;
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
  /**
   * Skip the publisher-level context-graph graph creation/ensure step.
   * Only callers that already validated the target context graph should set
   * this; it avoids re-entering store-backed graph discovery on direct publish.
   */
  skipContextGraphEnsure?: boolean;
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
   * Binding-only numeric on-chain context graph id. Unlike publishContextGraphId,
   * this must not imply a remap/delete flow in the publisher.
   */
  onChainContextGraphId?: string | bigint;
  /**
   * Internal/private-CG catalog path: exact generated catalog triples that ride
   * in the KC Merkle root but are not user KA manifest roots. Public callers
   * should not set this for arbitrary metadata.
   */
  trustedNonManifestCatalogTriples?: TrustedCatalogTripleKeys;
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
    ciphertextChunks?: Uint8Array[];
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
   *      merkleRoot: expectedMerkleRoot, authorAddress, reservedKaId })`
   *      (#1116: the attestation no longer binds `contextGraphId`).
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
  /**
   * GH #1013 — when a publish lands `tentative` (local-only), WHY it skipped
   * chain submission:
   *   - `no-chain`        — no on-chain CG id / chain not V10-ready: local is the
   *                         only possible outcome (an honest local finalization).
   * Undefined on confirmed publishes and pre-#1013 results.
   */
  localChainSkipReason?: 'no-chain';
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
