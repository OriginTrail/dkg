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

export const AgentMessageSchema = new Type('AgentMessage')
  .add(new Field('conversationId', 1, 'string'))
  .add(new Field('sequence', 2, 'uint64'))
  .add(new Field('senderPeerId', 3, 'string'))
  .add(new Field('recipientPeerId', 4, 'string'))
  .add(new Field('encryptedPayload', 5, 'bytes'))
  .add(new Field('nonce', 6, 'bytes'))
  .add(new Field('senderSignature', 7, 'bytes'))
  .add(new Field('senderPublicKey', 8, 'bytes'));

type Long = { low: number; high: number; unsigned: boolean };

export interface AgentMessageMsg {
  conversationId: string;
  sequence: number | Long;
  senderPeerId: string;
  recipientPeerId: string;
  encryptedPayload: Uint8Array;
  nonce: Uint8Array;
  senderSignature: Uint8Array;
  senderPublicKey: Uint8Array;
}

export function encodeAgentMessage(msg: AgentMessageMsg): Uint8Array {
  return AgentMessageSchema.encode(
    AgentMessageSchema.create(msg),
  ).finish();
}

export function decodeAgentMessage(buf: Uint8Array): AgentMessageMsg {
  return AgentMessageSchema.decode(buf) as unknown as AgentMessageMsg;
}
