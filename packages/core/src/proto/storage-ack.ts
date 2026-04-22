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

const StorageACKSchema = new Type('StorageACK')
  .add(new Field('merkleRoot', 1, 'bytes'))
  .add(new Field('coreNodeSignatureR', 2, 'bytes'))
  .add(new Field('coreNodeSignatureVS', 3, 'bytes'))
  .add(new Field('contextGraphId', 4, 'string'))
  .add(new Field('nodeIdentityId', 5, 'uint64'));

type Long = { low: number; high: number; unsigned: boolean };

export interface StorageACKMsg {
  merkleRoot: Uint8Array;
  coreNodeSignatureR: Uint8Array;
  coreNodeSignatureVS: Uint8Array;
  contextGraphId: string;
  nodeIdentityId: number | Long;
}

export function encodeStorageACK(msg: StorageACKMsg): Uint8Array {
  return StorageACKSchema.encode(
    StorageACKSchema.create(msg),
  ).finish();
}

export function decodeStorageACK(buf: Uint8Array): StorageACKMsg {
  return StorageACKSchema.decode(buf) as unknown as StorageACKMsg;
}
