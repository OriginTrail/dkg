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
  .add(new Field('payload', 7, 'bytes'))
  // OT-RFC-38 LU-11: curator-assigned monotonic counter per
  // `(contextGraphId, batchId)`, used by chunked curated publishes so
  // cores can index per-chunk ciphertexts as `(cgId, batchId, chunkId)`
  // without decrypting. Meaningful ONLY when `type ==
  // GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED`; for legacy `type ==
  // GOSSIP_TYPE_WORKSPACE_PUBLISH` envelopes the field is unused and
  // receivers MUST ignore it (proto3 zero-default makes field presence
  // an unreliable discriminator). When the chunked type is set, the
  // signature MUST be produced by `computeGossipSigningPayloadV2` which
  // covers `swmMessageIndex` so peers can't re-attribute a chunk to a
  // different slot.
  .add(new Field('swmMessageIndex', 8, 'uint32'));

export interface GossipEnvelopeMsg {
  version: string;
  type: string;
  contextGraphId: string;
  agentAddress: string;
  timestamp: string;
  signature: Uint8Array;
  payload: Uint8Array;
  /**
   * OT-RFC-38 LU-11 — present on chunked curated publishes. Cores index
   * per-chunk ciphertexts as `(cgId, batchId, chunkId == swmMessageIndex)`
   * so RFC-39 random sampling can pick a `chunkId` uniformly and the
   * prover can load the right ciphertext from local storage. Absent on
   * pre-LU-11 traffic — verifiers MUST treat absence as "v1 envelope"
   * and run the four-field signing helper.
   */
  swmMessageIndex?: number;
}

export const GOSSIP_ENVELOPE_VERSION = '10.0.0';
export const GOSSIP_TYPE_WORKSPACE_PUBLISH = 'share-write';
/**
 * OT-RFC-38 LU-11 — per-chunk curated workspace publish. Discriminator
 * value for `GossipEnvelopeMsg.type` on envelopes that carry exactly
 * one ciphertext chunk under `swmMessageIndex`. Receivers MUST:
 *   - run {@link computeGossipSigningPayloadV2} to verify the signature
 *     (which incorporates `swmMessageIndex`);
 *   - persist the inner ciphertext under `(cgId, batchId, swmMessageIndex)`
 *     rather than the single-blob slot;
 *   - treat `type === GOSSIP_TYPE_WORKSPACE_PUBLISH` envelopes verbatim
 *     as legacy V1 (no chunkId semantics, V1 signing helper).
 *
 * Using `type` instead of field-presence as the discriminator is forced
 * by proto3: a missing `swmMessageIndex` decodes as `0`, which is also
 * a valid chunkId for the first chunk of a chunked publish. The `type`
 * string is already in the signed payload, so an attacker can't flip
 * the discriminator without invalidating the signature.
 */
export const GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED = 'share-write-chunked';
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
 * Compute the signing payload for a V1 gossip envelope.
 * Signs length-framed fields: type, contextGraphId, timestamp, payload.
 *
 * This is the legacy four-field helper used by every pre-LU-11
 * gossip emitter and verifier. **Do not extend it** — LU-11 chunked
 * envelopes use {@link computeGossipSigningPayloadV2} so the V1
 * signature byte-shape stays frozen for backwards compatibility.
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

/**
 * Compute the signing payload for an LU-11 gossip envelope that carries
 * a `swmMessageIndex` (per-chunk curated publish).
 *
 * Signs the existing V1 four-field shape AND appends a fifth
 * length-framed field — the big-endian uint32 encoding of
 * `swmMessageIndex`. Pre-LU-11 envelopes that omit `swmMessageIndex`
 * MUST continue to use {@link computeGossipSigningPayload} and produce
 * bit-identical signatures to any pre-LU-11 peer.
 *
 * Receivers pick the verifier by checking whether the decoded envelope
 * has `swmMessageIndex !== undefined`.
 *
 * Including `swmMessageIndex` in the signature is non-optional: without
 * it, a malicious peer could re-attribute a legitimately-signed chunk
 * to a different chunkId on the wire, and cores would index the same
 * ciphertext under the wrong `(cgId, batchId, chunkId)` slot — silently
 * corrupting the chunkId → ciphertext mapping the prover relies on.
 */
export function computeGossipSigningPayloadV2(
  type: string,
  contextGraphId: string,
  timestamp: string,
  payload: Uint8Array,
  swmMessageIndex: number,
): Uint8Array {
  if (!Number.isInteger(swmMessageIndex) || swmMessageIndex < 0) {
    throw new Error(
      `computeGossipSigningPayloadV2: swmMessageIndex must be a non-negative integer (got ${swmMessageIndex})`,
    );
  }
  const fields = [
    framedField(textEncoder.encode(type)),
    framedField(textEncoder.encode(contextGraphId)),
    framedField(textEncoder.encode(timestamp)),
    framedField(payload),
    framedField(uint32Be(swmMessageIndex)),
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
