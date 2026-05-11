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

/**
 * V10 GossipSub authentication envelope.
 *
 * GossipSub protocols that can authenticate an agent writer wrap the payload
 * in this envelope, which provides:
 * - Protocol version ("10.0.0")
 * - Message type discrimination
 * - Context graph binding
 * - Agent identity and signature for authentication
 *
 * Legacy raw SWM payloads remain valid only for non-agent-gated context graphs
 * when no local signing key is available.
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

export const GOSSIP_ENVELOPE_VERSION = '10.0.0';
export const GOSSIP_TYPE_WORKSPACE_PUBLISH = 'share-write';
export const GOSSIP_ENVELOPE_FRESHNESS_MS = 5 * 60 * 1000;

export function encodeGossipEnvelope(msg: GossipEnvelopeMsg): Uint8Array {
  return GossipEnvelopeSchema.encode(
    GossipEnvelopeSchema.create(msg),
  ).finish();
}

export function decodeGossipEnvelope(buf: Uint8Array): GossipEnvelopeMsg {
  return GossipEnvelopeSchema.decode(buf) as unknown as GossipEnvelopeMsg;
}

const textEncoder = new TextEncoder();

function uint32Be(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value, false);
  return buf;
}

function framedField(value: Uint8Array): Uint8Array {
  const len = uint32Be(value.length);
  const framed = new Uint8Array(len.length + value.length);
  framed.set(len, 0);
  framed.set(value, len.length);
  return framed;
}

/**
 * Compute the signing payload for a gossip envelope.
 * Signs length-framed fields: type, contextGraphId, timestamp, payload.
 */
export function computeGossipSigningPayload(
  type: string,
  contextGraphId: string,
  timestamp: string,
  payload: Uint8Array,
): Uint8Array {
  const fields = [
    framedField(textEncoder.encode(type)),
    framedField(textEncoder.encode(contextGraphId)),
    framedField(textEncoder.encode(timestamp)),
    framedField(payload),
  ];
  const total = fields.reduce((sum, field) => sum + field.length, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const field of fields) {
    combined.set(field, offset);
    offset += field.length;
  }
  return combined;
}
