import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

/**
 * V10 GossipSub message envelope.
 *
 * All GossipSub messages are wrapped in this envelope which provides:
 * - Protocol version ("10.0.0")
 * - Message type discrimination
 * - Context graph binding
 * - Agent identity and signature for authentication
 */

export const GossipEnvelopeSchema = new Type('GossipEnvelope')
  .add(new Field('version', 1, 'string'))
  .add(new Field('type', 2, 'string'))
  .add(new Field('contextGraphId', 3, 'string'))
  .add(new Field('agentAddress', 4, 'string'))
  .add(new Field('timestamp', 5, 'string'))
  .add(new Field('signature', 6, 'bytes'))
  .add(new Field('payload', 7, 'bytes'));

export interface GossipEnvelopeMsg {
  version: string;
  type: string;
  contextGraphId: string;
  agentAddress: string;
  timestamp: string;
  signature: Uint8Array;
  payload: Uint8Array;
}

export function encodeGossipEnvelope(msg: GossipEnvelopeMsg): Uint8Array {
  return GossipEnvelopeSchema.encode(
    GossipEnvelopeSchema.create(msg),
  ).finish();
}

export function decodeGossipEnvelope(buf: Uint8Array): GossipEnvelopeMsg {
  return GossipEnvelopeSchema.decode(buf) as unknown as GossipEnvelopeMsg;
}

const textEncoder = new TextEncoder();

/**
 * Compute the signing payload for a gossip envelope.
 * Signs: type + contextGraphId + timestamp + payload
 */
export function computeGossipSigningPayload(
  type: string,
  contextGraphId: string,
  timestamp: string,
  payload: Uint8Array,
): Uint8Array {
  const prefix = textEncoder.encode(`${type}${contextGraphId}${timestamp}`);
  const combined = new Uint8Array(prefix.length + payload.length);
  combined.set(prefix, 0);
  combined.set(payload, prefix.length);
  return combined;
}
