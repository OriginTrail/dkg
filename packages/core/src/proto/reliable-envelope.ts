/**
 * Universal protobuf envelope used by `Messenger.sendToPeer` to wrap
 * every short peer-to-peer message before handing it to
 * `ProtocolRouter.send`, and unwrap on the receiver side inside
 * `Messenger.register`'s handler wrapper.
 *
 * Background
 * ----------
 * The Universal Messenger substrate (rc.9 plan) wraps every short
 * protocol payload — chat, skill, query, join, storage-ack, verify,
 * swm-key, private-access — in a uniform outer envelope so the
 * substrate can provide reliability (receiver-side dedup, durable
 * outbox, retry-with-idempotency) without per-protocol special cases.
 *
 * The envelope adds three correlation fields to whatever bytes the
 * application protocol already produces:
 *
 *   - `messageId` — a UUID v4 (caller-supplied or Messenger-generated)
 *     used by the receiver-side idempotency table to dedupe duplicate
 *     deliveries (e.g. from a multi-path race in PR-4 or a stale-
 *     snapshot outbox flush in the post-#538 generic outbox), and by
 *     the sender-side outbox to key persistent retry state.
 *
 *   - `version` — a uint32 schema version (`= 1` today) so future
 *     envelope shape changes can be detected without bumping the
 *     entire libp2p protocol prefix again. The protocol-prefix bump
 *     (e.g. `/dkg/10.0.0/X` → `/dkg/10.0.1/X`) is the coarse-grained
 *     compatibility break; the version field is for fine-grained
 *     evolution within a prefix.
 *
 *   - `tsMs` — the sender's wall-clock at send time (ms since epoch).
 *     Used by the receiver for staleness reasoning (drop messages
 *     more than ~24h old) and by the SLO histogram in PR-12 to
 *     compute end-to-end latency.
 *
 * The original protocol bytes — whether protobuf-encoded
 * `AccessRequest`, JSON-encoded `JoinRequest`, pipe-delimited sync
 * frame, etc. — are carried verbatim in the `payload` field. The
 * application handler never sees the envelope: `Messenger.register`'s
 * wrapper decodes it, checks idempotency, then invokes the handler
 * with the original `Uint8Array` payload.
 *
 * Existing per-protocol correlation IDs (`proposalId`, `operationId`,
 * `conversationId`, `requestId`, etc.) stay untouched inside the
 * payload for app-level semantics — they're orthogonal to the
 * envelope's `messageId`.
 *
 * Mirrors the encode/decode pattern in `./message.ts` (the
 * `AgentMessage` protobuf for chat). No external runtime dependency
 * beyond `protobufjs`, which is already pulled in by `./message.ts`.
 *
 * @internal — `ReliableEnvelopeSchema` is exported for the same
 * backwards-compat reason as `AgentMessageSchema`; prefer the
 * `ReliableEnvelopeMsg` type + `encodeReliableEnvelope` /
 * `decodeReliableEnvelope` re-exported from `./index.ts`.
 */
import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

export const ReliableEnvelopeSchema = new Type('ReliableEnvelope')
  .add(new Field('messageId', 1, 'string'))
  .add(new Field('version', 2, 'uint32'))
  .add(new Field('tsMs', 3, 'uint64'))
  .add(new Field('payload', 4, 'bytes'));

type Long = { low: number; high: number; unsigned: boolean };

/** Current `ReliableEnvelope.version` value emitted by `encodeReliableEnvelope`. */
export const RELIABLE_ENVELOPE_VERSION = 1;

export interface ReliableEnvelopeMsg {
  /** UUID v4 string. Caller-supplied or Messenger-generated. */
  messageId: string;
  /** Envelope schema version. Always `RELIABLE_ENVELOPE_VERSION` (= 1) today. */
  version: number;
  /**
   * Sender's wall-clock timestamp (ms since epoch) at send time.
   * `Long` shape comes from protobufjs's default `uint64` decoder — callers
   * that need a plain `number` can use `Number(msg.tsMs)` when the value
   * is within the safe-integer range (always true for ms-since-epoch
   * timestamps until year 287396).
   */
  tsMs: number | Long;
  /** Original protocol bytes — the existing protobuf/JSON/pipe-delimited payload, unchanged. */
  payload: Uint8Array;
}

export function encodeReliableEnvelope(msg: ReliableEnvelopeMsg): Uint8Array {
  return ReliableEnvelopeSchema.encode(
    ReliableEnvelopeSchema.create(msg),
  ).finish();
}

export function decodeReliableEnvelope(buf: Uint8Array): ReliableEnvelopeMsg {
  return ReliableEnvelopeSchema.decode(buf) as unknown as ReliableEnvelopeMsg;
}
