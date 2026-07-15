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

export const KAManifestEntrySchema = new Type('KAManifestEntry')
  .add(new Field('tokenId', 1, 'string'))
  .add(new Field('rootEntity', 2, 'string'))
  .add(new Field('privateMerkleRoot', 3, 'bytes'))
  .add(new Field('privateTripleCount', 4, 'uint32'));

export const PublishRequestSchema = new Type('PublishRequest')
  .add(new Field('ual', 1, 'string'))
  .add(new Field('nquads', 2, 'bytes'))
  .add(new Field('contextGraphId', 3, 'string'))
  .add(new Field('kas', 4, 'KAManifestEntry', 'repeated'))
  .add(new Field('publisherIdentity', 5, 'bytes'))
  .add(new Field('publisherAddress', 6, 'string'))
  .add(new Field('startKAId', 7, 'string'))
  .add(new Field('endKAId', 8, 'string'))
  .add(new Field('chainId', 9, 'string'))
  .add(new Field('publisherSignatureR', 10, 'bytes'))
  .add(new Field('publisherSignatureVs', 11, 'bytes'))
  .add(new Field('txHash', 12, 'string'))
  .add(new Field('blockNumber', 13, 'uint64'))
  .add(new Field('operationId', 14, 'string'))
  .add(new Field('subGraphName', 15, 'string'))
  // Rootless KA scope. `ual` is already field 1; legacy `kas` MUST be empty.
  .add(new Field('contentScopeVersion', 16, 'uint32'))
  .add(new Field('assertionVersion', 17, 'string'))
  .add(new Field('publicTripleCount', 18, 'uint32'))
  .add(new Field('privateMerkleRoot', 19, 'bytes'))
  .add(new Field('privateTripleCount', 20, 'uint32'))
  .add(KAManifestEntrySchema);

export const PublishAckSchema = new Type('PublishAck')
  .add(new Field('merkleRoot', 1, 'bytes'))
  .add(new Field('identityId', 2, 'uint64'))
  .add(new Field('signatureR', 3, 'bytes'))
  .add(new Field('signatureVs', 4, 'bytes'))
  .add(new Field('accepted', 5, 'bool'))
  .add(new Field('rejectionReason', 6, 'string'))
  .add(new Field('publicByteSize', 7, 'uint64'));

export interface KAManifestEntryMsg {
  tokenId: string | number | bigint | Long;
  rootEntity: string;
  privateMerkleRoot: Uint8Array;
  privateTripleCount: number;
}

export interface PublishRequestMsg {
  ual: string;
  nquads: Uint8Array;
  contextGraphId: string;
  kas: KAManifestEntryMsg[];
  publisherIdentity: Uint8Array;
  publisherAddress: string;
  startKAId: string | number | bigint | Long;
  endKAId: string | number | bigint | Long;
  chainId: string;
  publisherSignatureR: Uint8Array;
  publisherSignatureVs: Uint8Array;
  /** Transaction hash from on-chain publish (allows targeted receipt verification). */
  txHash?: string;
  /** Block number of the on-chain publish transaction. */
  blockNumber?: number | Long;
  /** Originator's operation ID for cross-node log correlation. */
  operationId?: string;
  /** Sub-graph within the context graph. Receivers store in sub-graph data graph if set. */
  subGraphName?: string;
  /** Rootless KA graph-scope discriminator. New writers emit exactly 2. */
  contentScopeVersion?: number;
  /** One-based assertion/Merkle-root index encoded as a decimal string. */
  assertionVersion?: string;
  /** Number of public RDF triples in the complete assertion. */
  publicTripleCount?: number;
  /** Optional single KA-level private commitment. */
  privateMerkleRoot?: Uint8Array;
  /** Number of private RDF triples committed by privateMerkleRoot. */
  privateTripleCount?: number;
}

export interface PublishAckMsg {
  merkleRoot: Uint8Array;
  identityId: number | Long;
  signatureR: Uint8Array;
  signatureVs: Uint8Array;
  accepted: boolean;
  rejectionReason: string;
  /** Attested public byte size (receivers sign merkleRoot + this so token amount is verifiable) */
  publicByteSize?: number | Long;
}

type Long = { low: number; high: number; unsigned: boolean };

/**
 * Convert a KA id (tokenId / startKAId / endKAId) into the decimal-string
 * wire shape. KA ids are packed Option-1 values
 * `(uint160(author) << 96) | number` (~256-bit), which do NOT fit a uint64
 * gossip field — encoding them as a uint64 threw
 * `RangeError: Value … exceeds uint64 range` in the old `bigIntToProtoSafe`
 * path. Per OT-RFC-43 §9 the id wire type is a decimal string, so we accept
 * string / number / bigint / protobuf Long and emit the canonical decimal
 * string losslessly.
 */
function idToProtoString(val: string | number | bigint | Long): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'bigint') return val.toString();
  if (typeof val === 'number') return val.toString();
  const lo = BigInt(val.low >>> 0); const hi = BigInt(val.high >>> 0);
  return ((hi << 32n) | lo).toString();
}

export function encodePublishRequest(msg: PublishRequestMsg): Uint8Array {
  return PublishRequestSchema.encode(
    PublishRequestSchema.create({
      ...msg,
      kas: msg.kas.map((ka) => ({
        ...ka,
        tokenId: idToProtoString(ka.tokenId),
      })),
      startKAId: idToProtoString(msg.startKAId),
      endKAId: idToProtoString(msg.endKAId),
      ...(msg.blockNumber !== undefined
        ? { blockNumber: msg.blockNumber }
        : {}),
    }),
  ).finish();
}

export function decodePublishRequest(buf: Uint8Array): PublishRequestMsg {
  return PublishRequestSchema.decode(buf) as unknown as PublishRequestMsg;
}

export function encodePublishAck(msg: PublishAckMsg): Uint8Array {
  return PublishAckSchema.encode(PublishAckSchema.create(msg)).finish();
}

export function decodePublishAck(buf: Uint8Array): PublishAckMsg {
  return PublishAckSchema.decode(buf) as unknown as PublishAckMsg;
}
