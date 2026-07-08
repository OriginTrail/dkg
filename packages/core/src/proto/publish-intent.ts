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
 * PublishIntent message (spec §9.0, §15.1).
 *
 * Broadcast via GossipSub on the finalization topic to signal that a
 * publisher is about to submit a chain TX and needs 3 core node StorageACKs.
 *
 * Core nodes that have the data in SWM verify the merkle root and respond
 * with a StorageACK via direct P2P stream `/dkg/10.0.1/storage-ack`.
 */

export const PublishIntentSchema = new Type('PublishIntent')
  .add(new Field('merkleRoot', 1, 'bytes'))
  .add(new Field('contextGraphId', 2, 'string'))
  .add(new Field('publisherPeerId', 3, 'string'))
  .add(new Field('publicByteSize', 4, 'uint64'))
  .add(new Field('isPrivate', 5, 'bool'))
  .add(new Field('kaCount', 6, 'uint32'))
  .add(new Field('rootEntities', 7, 'string', 'repeated'))
  .add(new Field('stagingQuads', 8, 'bytes'))
  .add(new Field('epochs', 9, 'uint32'))
  .add(new Field('tokenAmountStr', 10, 'string'))
  // `contextGraphId` above is the TARGET on-chain numeric CG id used in the
  // ACK digest and the on-chain tx. The SWM data the peer must read lives
  // under a (possibly different) SOURCE graph — the `publishFromSharedMemory`
  // remap flow lets callers read from "devnet-test" and publish to numeric
  // id 42. Handlers resolve SWM via `swmGraphId ?? contextGraphId` + the
  // optional `subGraphName` suffix.
  .add(new Field('swmGraphId', 11, 'string'))
  .add(new Field('subGraphName', 12, 'string'))
  /** V10 flat-KC Merkle leaf count (sorted + deduped); must match ACK digest + on-chain KC. */
  .add(new Field('merkleLeafCount', 13, 'uint32'))
  // OT-RFC-38 / LU-5: when `true`, `stagingQuads` carries opaque ciphertext
  // bytes (AEAD-encrypted nquads keyed via the CG's swm-sender chain key)
  // and the receiver MUST NOT attempt N-Quad parsing or merkle-root
  // recomputation against it. Cores cannot decrypt curated payloads, so
  // they sign the V10 digest based on the publisher's claimed merkle root
  // and ciphertext byte size; member post-decrypt verification (LU-8)
  // catches any mismatch between the on-chain root and the actual
  // plaintext. Field number 14 keeps the proto strictly additive for
  // encoders, but encrypted payloads are only sent over the bumped
  // `/dkg/10.0.1/storage-ack` protocol so pre-LU-5 receivers never parse
  // ciphertext as plaintext.
  .add(new Field('isEncryptedPayload', 14, 'bool'))
  // OT-RFC-38 LU-11 / OT-RFC-39: per-KC ciphertext-chunks Merkle root the
  // publisher claims for curated batches. Cores recompute the root from
  // their locally-buffered per-chunk ciphertexts (indexed by
  // `swmMessageIndex` on the gossip envelope) and DECLINE the ACK on
  // mismatch. The same root lands on-chain via
  // `KnowledgeAssetsV10.PublishParams.ciphertextChunksRoot` so RFC-39
  // random sampling can verify against it. Empty / 32 zero bytes on
  // pre-LU-11 traffic.
  .add(new Field('ciphertextChunksRoot', 15, 'bytes'))
  // OT-RFC-38 LU-11: number of per-chunk ciphertexts staged for this
  // batch (== `(swmMessageIndex == i)` count, i in [0, count)). Cores
  // MUST find each chunk before signing. Defaults to 0 on the wire so
  // legacy v1 traffic decodes as "no chunks".
  .add(new Field('ciphertextChunkCount', 16, 'uint32'))
  // OT-RFC-38 LU-11: ACK protocol version negotiated for this publish.
  // Absent/0 → v1 (legacy LU-5 single-blob path; cores treat
  // `stagingQuads` as one opaque ciphertext). >= 2 → LU-11 chunked path
  // (cores expect `ciphertextChunkCount` chunks already received via
  // SWM gossip, verify the Merkle root, and ignore `stagingQuads`).
  // Sent over `PROTOCOL_STORAGE_ACK_V2` so pre-LU-11 receivers never
  // see this field and stay on v1 semantics.
  .add(new Field('ackProtocolVersion', 17, 'uint32'))
  // OT-RFC-49 — curated PUBLIC `_catalog` commitment the publisher claims
  // for this curated batch. The core recomputes
  // `computeCatalogRoot(catalogCommittedLeaves(<locally-served _catalog>))`
  // and DECLINEs `CATALOG_ROOT_MISMATCH` if it differs; the same root lands
  // on-chain via `KnowledgeAssetsLifecycle.PublishParams.catalogRoot` so
  // RFC-39 random sampling and the prover verify against it. Additive
  // fields (18/19) — empty / 32 zero bytes + 0 on public-CG traffic.
  .add(new Field('catalogRoot', 18, 'bytes'))
  .add(new Field('catalogLeafCount', 19, 'uint32'))
  // Folded public+private KAs expose only the per-entity private commitments to
  // core ACK signers. Cores never see private plaintext, but they can recompute
  // the exact KC root as hash(public subtree, collapse(private roots)). Sent
  // only over `PROTOCOL_STORAGE_ACK_V2` so V1 cores never silently ignore the
  // commitments during rolling upgrades.
  .add(new Field('privateMerkleRoots', 20, 'bytes', 'repeated'));

type Long = { low: number; high: number; unsigned: boolean };

export interface PublishIntentMsg {
  merkleRoot: Uint8Array;
  /** Target on-chain numeric CG id used by the ACK digest and the publishDirect tx. */
  contextGraphId: string;
  publisherPeerId: string;
  publicByteSize: number | Long;
  isPrivate: boolean;
  kaCount: number;
  rootEntities: string[];
  stagingQuads?: Uint8Array;
  epochs?: number;
  /** Decimal string representation of tokenAmount for lossless bigint transport. */
  tokenAmountStr?: string;
  /**
   * Source SWM graph id used by the peer to locate the data to verify. If
   * absent, peers fall back to `contextGraphId`. Different from
   * `contextGraphId` only when the publisher called
   * `publishFromSharedMemory` with an explicit `publishContextGraphId`
   * remap (source graph "foo" → on-chain id 42).
   */
  swmGraphId?: string;
  /**
   * Optional sub-graph name appended to the SWM URI. Lets core peers load
   * `.../<swmGraphId>/<subGraphName>/_shared_memory` when the publisher
   * writes into a sub-graph partition.
   */
  subGraphName?: string;
  /** V10 flat-KC Merkle leaf count after sort+dedupe (see `V10MerkleTree.leafCount`). */
  merkleLeafCount?: number;
  /**
   * OT-RFC-38 / LU-5. When `true`, `stagingQuads` is opaque ciphertext
   * (AEAD-encrypted nquads keyed via the CG's swm-sender chain key) and
   * the receiver MUST treat it as a binary blob: no N-Quad parsing, no
   * merkle-root recompute, no rootEntities cross-check. Cores still
   * verify the ciphertext byte count against `publicByteSize` (so a
   * misreported size doesn't slip through pricing) and sign the V10
   * digest the publisher claimed. Member post-decrypt verification
   * (LU-8) catches plaintext-vs-on-chain-root mismatches.
   *
   * Defaults to `false`/undefined on the wire so the existing public-CG
   * flow that ships plaintext nquads inline keeps working unchanged.
   */
  isEncryptedPayload?: boolean;
  /**
   * OT-RFC-38 LU-11 / OT-RFC-39 — per-KC ciphertext-chunks Merkle root
   * the publisher claims for curated batches. 32-byte keccak256 over
   * `keccak256(ct_i)` leaves in `swmMessageIndex` order (see
   * `buildCiphertextChunksRoot` in `@origintrail-official/dkg-core`).
   *
   * Cores recompute locally from per-chunk ciphertexts indexed under
   * `(cgId, batchId, swmMessageIndex)` and DECLINE the ACK on mismatch
   * before signing. The same root lands on-chain via
   * `KnowledgeAssetsV10.PublishParams.ciphertextChunksRoot` so RFC-39
   * random sampling has a stable commitment to verify against.
   *
   * Omitted/empty on pre-LU-11 traffic.
   */
  ciphertextChunksRoot?: Uint8Array;
  /**
   * OT-RFC-38 LU-11 — count of per-chunk ciphertexts staged for this
   * batch. `swmMessageIndex` ranges over `[0, ciphertextChunkCount)`.
   * Cores MUST hold every chunk before signing (a missing chunk is
   * either pulled via the LU-11 sync verb or causes a DECLINE).
   *
   * Defaults to `0` on the wire so legacy v1 PublishIntents decode as
   * "no chunks" and stay on the LU-5 single-blob path.
   */
  ciphertextChunkCount?: number;
  /**
   * OT-RFC-38 LU-11 — ACK protocol version negotiated for this publish.
   *
   * - Absent / `0` / `1` → v1 (legacy LU-5 single-blob: `stagingQuads`
   *   carries one opaque ciphertext; `ciphertextChunksRoot` and
   *   `ciphertextChunkCount` are unused).
   * - `>= 2` → LU-11 chunked: cores expect `ciphertextChunkCount`
   *   chunks already received via SWM gossip, verify the Merkle root
   *   matches the publisher's claim, and ignore `stagingQuads`.
   *
   * Chunked-path PublishIntents are sent over `PROTOCOL_STORAGE_ACK_V2`
   * so pre-LU-11 receivers (still on V1) never see this field and stay
   * on the LU-5 path.
   */
  ackProtocolVersion?: number;
  /**
   * OT-RFC-49 — the curated PUBLIC `_catalog` Merkle root the publisher
   * claims for this batch. 32-byte V10 root over the committed catalog
   * leaf-set (`computeCatalogRoot(catalogCommittedLeaves(...))`). The core
   * rebuilds the same root over its locally-served `<cg>/_catalog` graph and
   * DECLINEs `CATALOG_ROOT_MISMATCH` on disagreement; the same value is what
   * lands on-chain. Omitted / 32 zero bytes on public-CG traffic.
   */
  catalogRoot?: Uint8Array;
  /**
   * OT-RFC-49 — post sort+dedupe count of the committed catalog leaf-set
   * (== on-chain `getCatalogLeafCount` and the curated `chunkId` draw
   * modulus). Defaults to `0` on public-CG traffic.
   */
  catalogLeafCount?: number;
  /**
   * Per-entity private commitments for folded public+private KAs. These are
   * 32-byte Merkle roots over private triples, not private plaintext. Public
   * ACK handlers fold them into the claimed KC root while still verifying only
   * the public quads they store. Must be sent over `PROTOCOL_STORAGE_ACK_V2`;
   * V1 peers are not compatible because they ignore field 20.
   */
  privateMerkleRoots?: Uint8Array[];
}

/** Sent in `ackProtocolVersion` for LU-11 chunked ACKs. */
export const ACK_PROTOCOL_VERSION_V1_LU5 = 1;
export const ACK_PROTOCOL_VERSION_V2_LU11 = 2;

export function encodePublishIntent(msg: PublishIntentMsg): Uint8Array {
  return PublishIntentSchema.encode(
    PublishIntentSchema.create(msg),
  ).finish();
}

export function decodePublishIntent(buf: Uint8Array): PublishIntentMsg {
  return PublishIntentSchema.decode(buf) as unknown as PublishIntentMsg;
}
