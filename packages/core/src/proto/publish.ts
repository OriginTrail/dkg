import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

const KAManifestEntrySchema = new Type('KAManifestEntry')
  .add(new Field('tokenId', 1, 'uint64'))
  .add(new Field('rootEntity', 2, 'string'))
  .add(new Field('privateMerkleRoot', 3, 'bytes'))
  .add(new Field('privateTripleCount', 4, 'uint32'));

const PublishRequestSchema = new Type('PublishRequest')
  .add(new Field('ual', 1, 'string'))
  .add(new Field('nquads', 2, 'bytes'))
  .add(new Field('paranetId', 3, 'string'))
  .add(new Field('kas', 4, 'KAManifestEntry', 'repeated'))
  .add(new Field('publisherIdentity', 5, 'bytes'))
  .add(new Field('publisherAddress', 6, 'string'))
  .add(new Field('startKAId', 7, 'uint64'))
  .add(new Field('endKAId', 8, 'uint64'))
  .add(new Field('chainId', 9, 'string'))
  .add(new Field('publisherSignatureR', 10, 'bytes'))
  .add(new Field('publisherSignatureVs', 11, 'bytes'))
  .add(new Field('txHash', 12, 'string'))
  .add(new Field('blockNumber', 13, 'uint64'))
  .add(new Field('operationId', 14, 'string'))
  .add(new Field('subGraphName', 15, 'string'))
  .add(KAManifestEntrySchema);

const PublishAckSchema = new Type('PublishAck')
  .add(new Field('merkleRoot', 1, 'bytes'))
  .add(new Field('identityId', 2, 'uint64'))
  .add(new Field('signatureR', 3, 'bytes'))
  .add(new Field('signatureVs', 4, 'bytes'))
  .add(new Field('accepted', 5, 'bool'))
  .add(new Field('rejectionReason', 6, 'string'))
  .add(new Field('publicByteSize', 7, 'uint64'));

export interface KAManifestEntryMsg {
  tokenId: number | Long;
  rootEntity: string;
  privateMerkleRoot: Uint8Array;
  privateTripleCount: number;
}

export interface PublishRequestMsg {
  ual: string;
  nquads: Uint8Array;
  paranetId: string;
  kas: KAManifestEntryMsg[];
  publisherIdentity: Uint8Array;
  publisherAddress: string;
  startKAId: number | Long;
  endKAId: number | Long;
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

export function encodePublishRequest(msg: PublishRequestMsg): Uint8Array {
  return PublishRequestSchema.encode(
    PublishRequestSchema.create(msg),
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
