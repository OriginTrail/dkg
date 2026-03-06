import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

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
  .add(KAUpdateManifestEntrySchema);

export interface KAUpdateManifestEntryMsg {
  rootEntity: string;
  privateMerkleRoot?: Uint8Array;
  privateTripleCount?: number;
}

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
}

export function encodeKAUpdateRequest(msg: KAUpdateRequestMsg): Uint8Array {
  const toNum = (v: number | bigint) => typeof v === 'bigint' ? Number(v) : v;
  return KAUpdateRequestSchema.encode(
    KAUpdateRequestSchema.create({
      ...msg,
      batchId: toNum(msg.batchId),
      blockNumber: toNum(msg.blockNumber),
      timestampMs: toNum(msg.timestampMs),
    }),
  ).finish();
}

export function decodeKAUpdateRequest(buf: Uint8Array): KAUpdateRequestMsg {
  const decoded = KAUpdateRequestSchema.decode(buf) as unknown as Record<string, unknown>;
  const toNum = (v: unknown): number => {
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object' && 'toNumber' in v) return (v as { toNumber(): number }).toNumber();
    return Number(v);
  };
  return {
    ...(decoded as unknown as KAUpdateRequestMsg),
    batchId: toNum(decoded.batchId),
    blockNumber: toNum(decoded.blockNumber),
    timestampMs: toNum(decoded.timestampMs),
  };
}
