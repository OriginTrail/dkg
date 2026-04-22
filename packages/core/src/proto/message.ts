import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

const AgentMessageSchema = new Type('AgentMessage')
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
