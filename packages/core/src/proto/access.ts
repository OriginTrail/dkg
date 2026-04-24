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

export const AccessRequestSchema = new Type('AccessRequest')
  .add(new Field('kaUal', 1, 'string'))
  .add(new Field('requesterPeerId', 2, 'string'))
  .add(new Field('paymentProof', 3, 'bytes'))
  .add(new Field('requesterSignature', 4, 'bytes'))
  .add(new Field('requesterPublicKey', 5, 'bytes'));

export const AccessResponseSchema = new Type('AccessResponse')
  .add(new Field('granted', 1, 'bool'))
  .add(new Field('nquads', 2, 'bytes'))
  .add(new Field('privateMerkleRoot', 3, 'bytes'))
  .add(new Field('rejectionReason', 4, 'string'));

export interface AccessRequestMsg {
  kaUal: string;
  requesterPeerId: string;
  paymentProof: Uint8Array;
  requesterSignature: Uint8Array;
  /** Ed25519 public key for signature verification. */
  requesterPublicKey?: Uint8Array;
}

export interface AccessResponseMsg {
  granted: boolean;
  nquads: Uint8Array;
  privateMerkleRoot: Uint8Array;
  rejectionReason: string;
}

export function encodeAccessRequest(msg: AccessRequestMsg): Uint8Array {
  return AccessRequestSchema.encode(
    AccessRequestSchema.create(msg),
  ).finish();
}

export function decodeAccessRequest(buf: Uint8Array): AccessRequestMsg {
  return AccessRequestSchema.decode(buf) as unknown as AccessRequestMsg;
}

export function encodeAccessResponse(msg: AccessResponseMsg): Uint8Array {
  return AccessResponseSchema.encode(
    AccessResponseSchema.create(msg),
  ).finish();
}

export function decodeAccessResponse(buf: Uint8Array): AccessResponseMsg {
  return AccessResponseSchema.decode(buf) as unknown as AccessResponseMsg;
}
