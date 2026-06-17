/**
 * Protobuf wire schema for the V10 UPDATE StorageACK request.
 *
 * Sibling of `publish-intent.ts`. Where `PublishIntent` carries the
 * fields the PUBLISH ACK digest binds, `UpdateIntent` carries the
 * fields the UPDATE ACK digest binds (see `computeUpdateACKDigest` in
 * `packages/core/src/crypto/ack.ts`, which mirrors
 * `KnowledgeAssetsLifecycle._executeUpdateCore`).
 *
 * The peer recomputes the new flat-KC Merkle root from `stagingQuads`
 * (or its SWM copy), verifies it equals `newMerkleRoot`, and — on a
 * match — signs `computeUpdateACKDigest(chainId, kav10Address, …request
 * fields…)` with its operational key (EIP-191 over the 404-byte packed
 * digest). The signed response reuses the operation-agnostic
 * `StorageACK` message (`storage-ack.ts`); its `merkleRoot` field
 * carries `newMerkleRoot`.
 *
 * `kaId` + `preUpdateMerkleRootCount` are taken from the request and
 * trusted: the publisher binds them and the on-chain update tx reverts
 * if they are wrong, so the same trust model as `kaCount` on the
 * encrypted publish path applies.
 *
 * The `*Schema` const below is exported strictly for backwards
 * compatibility with deep-import consumers; prefer the `UpdateIntentMsg`
 * type + `encodeUpdateIntent` / `decodeUpdateIntent` re-exported from
 * `packages/core/src/proto/index.ts`.
 *
 * @internal
 */
import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

export const UpdateIntentSchema = new Type('UpdateIntent')
  /** On-chain KA id (decimal string for lossless bigint transport). */
  .add(new Field('kaId', 1, 'string'))
  /** TARGET on-chain numeric context graph id (decimal string). */
  .add(new Field('contextGraphId', 2, 'string'))
  /** Pre-update on-chain Merkle-roots array length for this KA. */
  .add(new Field('preUpdateMerkleRootCount', 3, 'uint64'))
  /** New flat-KC Merkle root (32 bytes) the publisher commits to on-chain. */
  .add(new Field('newMerkleRoot', 4, 'bytes'))
  /** New serialized byte size of the KC after update. */
  .add(new Field('newByteSize', 5, 'uint64'))
  /** New token amount, decimal string (run through floorPublishTokenAmount in the digest). */
  .add(new Field('newTokenAmount', 6, 'string'))
  /** Mint amount (greenfield = 0). */
  .add(new Field('mintAmount', 7, 'uint64'))
  /** Burn token ids, decimal strings (greenfield = []). */
  .add(new Field('burnTokenIds', 8, 'string', 'repeated'))
  /** New flat-KC Merkle leaf count (sorted + deduped). */
  .add(new Field('newMerkleLeafCount', 9, 'uint32'))
  /** OT-RFC-49 — refreshed curated `_catalog` root (32 zero bytes when absent). */
  .add(new Field('newCatalogRoot', 10, 'bytes'))
  /** OT-RFC-49 — refreshed curated catalog leaf count (0 when absent). */
  .add(new Field('newCatalogLeafCount', 11, 'uint32'))
  /** Dialing publisher peer id (informational). */
  .add(new Field('publisherPeerId', 12, 'string'))
  /** SOURCE SWM graph id where the data lives (defaults to contextGraphId). */
  .add(new Field('swmGraphId', 13, 'string'))
  /** Optional sub-graph name appended to the SWM URI. */
  .add(new Field('subGraphName', 14, 'string'))
  /** Updated KC quads (N-Quads bytes) so the peer can recompute/verify newMerkleRoot. */
  .add(new Field('stagingQuads', 15, 'bytes'))
  /** When true, `stagingQuads` is opaque ciphertext (curated CG); peer skips plaintext recompute. */
  .add(new Field('isEncryptedPayload', 16, 'bool'))
  /** ACK protocol version negotiated for this update (absent/0/1 → v1). */
  .add(new Field('ackProtocolVersion', 17, 'uint32'));

type Long = { low: number; high: number; unsigned: boolean };

export interface UpdateIntentMsg {
  /** On-chain KA id as a decimal string (lossless bigint transport). */
  kaId: string;
  /** TARGET on-chain numeric context graph id as a decimal string. */
  contextGraphId: string;
  /** Pre-update on-chain Merkle-roots array length for this KA. */
  preUpdateMerkleRootCount: number | Long;
  /** New flat-KC Merkle root (32 bytes). */
  newMerkleRoot: Uint8Array;
  /** New serialized byte size of the KC after update. */
  newByteSize: number | Long;
  /** New token amount as a decimal string. */
  newTokenAmount: string;
  /** Mint amount (greenfield = 0). */
  mintAmount?: number | Long;
  /** Burn token ids as decimal strings (greenfield = []). */
  burnTokenIds?: string[];
  /** New flat-KC Merkle leaf count (sorted + deduped). */
  newMerkleLeafCount: number;
  /**
   * OT-RFC-49 — refreshed curated `_catalog` Merkle root. Omitted / empty
   * on metadata-only updates and public CGs (decoded as 32 zero bytes for
   * the digest).
   */
  newCatalogRoot?: Uint8Array;
  /** OT-RFC-49 — refreshed curated catalog leaf count (0 when absent). */
  newCatalogLeafCount?: number;
  /** Dialing publisher peer id (informational). */
  publisherPeerId: string;
  /**
   * SOURCE SWM graph id where the peer locates the data to verify. Falls
   * back to `contextGraphId` when absent.
   */
  swmGraphId?: string;
  /** Optional sub-graph name appended to the SWM URI. */
  subGraphName?: string;
  /** Updated KC quads (N-Quads bytes) so the peer can recompute newMerkleRoot. */
  stagingQuads?: Uint8Array;
  /**
   * When `true`, `stagingQuads` is opaque AEAD ciphertext (curated CG):
   * the peer skips N-Quad parsing + Merkle recompute and trusts the
   * publisher's `newMerkleRoot` claim. Defaults to `false`.
   */
  isEncryptedPayload?: boolean;
  /** ACK protocol version negotiated for this update (absent/0/1 → v1). */
  ackProtocolVersion?: number;
}

export function encodeUpdateIntent(msg: UpdateIntentMsg): Uint8Array {
  return UpdateIntentSchema.encode(UpdateIntentSchema.create(msg)).finish();
}

export function decodeUpdateIntent(buf: Uint8Array): UpdateIntentMsg {
  return UpdateIntentSchema.decode(buf) as unknown as UpdateIntentMsg;
}
