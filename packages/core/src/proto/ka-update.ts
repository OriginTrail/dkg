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
const PbLong = protobuf.util.Long as unknown as {
  fromBigInt(val: bigint, unsigned?: boolean): { low: number; high: number; unsigned: boolean };
  fromNumber(val: number, unsigned?: boolean): { low: number; high: number; unsigned: boolean };
};

export const KAUpdateManifestEntrySchema = new Type('KAUpdateManifestEntry')
  .add(new Field('rootEntity', 1, 'string'))
  .add(new Field('privateMerkleRoot', 2, 'bytes'))
  .add(new Field('privateTripleCount', 3, 'uint32'));

export const KAUpdateRequestSchema = new Type('KAUpdateRequest')
  .add(new Field('paranetId', 1, 'string'))
  .add(new Field('batchId', 2, 'uint64'))
  .add(new Field('nquads', 3, 'bytes'))
  .add(new Field('manifest', 4, 'KAUpdateManifestEntry', 'repeated'))
  .add(new Field('publisherPeerId', 5, 'string'))
  .add(new Field('publisherAddress', 6, 'string'))
  .add(new Field('txHash', 7, 'string'))
  .add(new Field('blockNumber', 8, 'uint64'))
  .add(new Field('newMerkleRoot', 9, 'bytes'))
  .add(new Field('timestampMs', 10, 'uint64'))
  .add(new Field('operationId', 11, 'string'))
  .add(KAUpdateManifestEntrySchema);

type Long = { low: number; high: number; unsigned: boolean };

export interface KAUpdateManifestEntryMsg {
  rootEntity: string;
  privateMerkleRoot?: Uint8Array;
  privateTripleCount?: number;
}

/** Input type for encoding — accepts number, bigint, or protobuf Long. */
export interface KAUpdateRequestMsg {
  paranetId: string;
  batchId: number | bigint;
  nquads: Uint8Array;
  manifest: KAUpdateManifestEntryMsg[];
  publisherPeerId: string;
  publisherAddress: string;
  txHash: string;
  blockNumber: number | bigint;
  newMerkleRoot: Uint8Array;
  timestampMs: number | bigint;
  /** Originator's operation ID for cross-node log correlation. */
  operationId?: string;
}

function toBigInt(v: number | bigint | Long | unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (v && typeof v === 'object' && 'low' in v && 'high' in v) {
    const long = v as Long;
    return BigInt(long.high >>> 0) * 0x100000000n + BigInt(long.low >>> 0);
  }
  return BigInt(Number(v));
}

function toLong(v: number | bigint): { low: number; high: number; unsigned: boolean } {
  if (typeof v === 'bigint') return PbLong.fromBigInt(v, true);
  return PbLong.fromNumber(v, true);
}

export function encodeKAUpdateRequest(msg: KAUpdateRequestMsg): Uint8Array {
  return KAUpdateRequestSchema.encode(
    KAUpdateRequestSchema.create({
      ...msg,
      batchId: toLong(msg.batchId),
      blockNumber: toLong(msg.blockNumber),
      timestampMs: toLong(msg.timestampMs),
    }),
  ).finish();
}

/** Decode returns bigint for uint64 fields (safe from protobuf Long precision issues). */
export function decodeKAUpdateRequest(buf: Uint8Array): KAUpdateRequestMsg {
  const decoded = KAUpdateRequestSchema.decode(buf) as unknown as Record<string, unknown>;
  return {
    ...(decoded as unknown as KAUpdateRequestMsg),
    batchId: toBigInt(decoded.batchId),
    blockNumber: toBigInt(decoded.blockNumber),
    timestampMs: toBigInt(decoded.timestampMs),
  };
}
