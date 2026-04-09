import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

export const FinalizationMessageSchema = new Type('FinalizationMessage')
  .add(new Field('ual', 1, 'string'))
  .add(new Field('paranetId', 2, 'string'))
  .add(new Field('kcMerkleRoot', 3, 'bytes'))
  .add(new Field('txHash', 4, 'string'))
  .add(new Field('blockNumber', 5, 'uint64'))
  .add(new Field('batchId', 6, 'uint64'))
  .add(new Field('startKAId', 7, 'uint64'))
  .add(new Field('endKAId', 8, 'uint64'))
  .add(new Field('publisherAddress', 9, 'string'))
  .add(new Field('rootEntities', 10, 'string', 'repeated'))
  .add(new Field('timestampMs', 11, 'uint64'))
  .add(new Field('operationId', 12, 'string'))
  .add(new Field('contextGraphId', 13, 'string'))
  .add(new Field('subGraphName', 14, 'string'));

type Long = { low: number; high: number; unsigned: boolean };

export interface FinalizationMessageMsg {
  ual: string;
  paranetId: string;
  kcMerkleRoot: Uint8Array;
  txHash: string;
  blockNumber: number | bigint | Long;
  batchId: number | bigint | Long;
  startKAId: number | bigint | Long;
  endKAId: number | bigint | Long;
  publisherAddress: string;
  rootEntities: string[];
  timestampMs: number | bigint | Long;
  /** Originator's operation ID for cross-node log correlation. */
  operationId?: string;
  /** When set, the enshrine targeted a context graph instead of the paranet data graph. */
  contextGraphId?: string;
  /** Sub-graph within the context graph. Receivers promote SWM into sub-graph data graph if set. */
  subGraphName?: string;
}

const MAX_UINT64 = (1n << 64n) - 1n;

function bigIntToProtoSafe(val: number | bigint | Long): number | Long {
  if (typeof val === 'bigint') {
    if (val < 0n || val > MAX_UINT64) {
      throw new RangeError(`Value ${val} exceeds uint64 range [0, 2^64-1]`);
    }
    const low = Number(val & 0xFFFFFFFFn);
    const high = Number((val >> 32n) & 0xFFFFFFFFn);
    return { low, high, unsigned: true };
  }
  return val as number | Long;
}

export function encodeFinalizationMessage(msg: FinalizationMessageMsg): Uint8Array {
  return FinalizationMessageSchema.encode(
    FinalizationMessageSchema.create({
      ...msg,
      blockNumber: bigIntToProtoSafe(msg.blockNumber),
      batchId: bigIntToProtoSafe(msg.batchId),
      startKAId: bigIntToProtoSafe(msg.startKAId),
      endKAId: bigIntToProtoSafe(msg.endKAId),
      timestampMs: bigIntToProtoSafe(msg.timestampMs),
    }),
  ).finish();
}

export function decodeFinalizationMessage(buf: Uint8Array): FinalizationMessageMsg {
  return FinalizationMessageSchema.decode(buf) as unknown as FinalizationMessageMsg;
}
