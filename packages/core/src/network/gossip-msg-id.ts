/**
 * Gossipsub message-id function — RFC 07 §5.4.
 *
 * RFC 07 commits to a single content-deterministic msgId convention
 * so any future gossip backend (iroh-gossip, etc.) can dedup against
 * libp2p-gossipsub without protocol-level cooperation. The exact
 * encoding (after Codex review feedback on PR #501):
 *
 *     msgId(topic, payload, publisherId, sequenceNumber) :=
 *         sha256(
 *           u32_be(len(topic))           ‖ topic
 *           ‖ u32_be(len(payload))        ‖ payload
 *           ‖ u32_be(len(publisherId))    ‖ publisherId
 *           ‖ u64_be(sequenceNumber)
 *         )
 *
 * Why length framing
 * ------------------
 * Without length prefixes, raw concatenation collides:
 * `("ab", "c", from)` and `("a", "bc", from)` would hash the same
 * bytes and dedup as one message even though they're distinct
 * (topic, payload) tuples. The u32_be length prefix per field makes
 * the encoding injective — distinct tuples always hash to distinct
 * inputs.
 *
 * Why include sequenceNumber
 * --------------------------
 * The whole point of gossipsub's msgId is dedup-with-retries: a peer
 * publishing the same payload twice (e.g. resending after a network
 * blip) must produce TWO distinct msgIds, otherwise the second
 * publish is dropped as a duplicate. The upstream `msgIdFnStrictSign`
 * uses `(key, seqno)` precisely for this reason. Including the
 * sequence number in the hash preserves that semantic without
 * forfeiting cross-backend determinism: every backend with a notion
 * of per-publisher monotonic ordering (gossipsub seqno, iroh-gossip
 * sequence, etc.) maps the same (topic, payload, publisher, seq)
 * tuple to the same hash.
 *
 * Why throw on unsigned
 * ---------------------
 * Codex review feedback on PR #501 round 4: with no `from` and no
 * seqno, two different publishers sending the same payload would
 * produce the SAME msgId — false dedup. The upstream default for
 * unsigned (`sha256(data)`) has the same property, but a freshly-
 * shipped public function shouldn't replicate that pitfall. V10
 * configures gossipsub StrictSign by default so unsigned messages
 * don't appear in the wild today; throwing makes the unsupported
 * case loud and catches accidental misuse via the public re-export.
 *
 * Why split into raw + adapter
 * ----------------------------
 * Codex review feedback on PR #501 round 5: the round-4 signature
 * accepted a libp2p `Message` directly, which made the "cross-
 * backend dedup" framing aspirational rather than concrete. A
 * future iroh-gossip backend would have its own message type with
 * its own ways of representing publisher and sequence — at which
 * point either we'd duplicate the framing logic (drift risk) or
 * have to refactor every consumer to convert through the libp2p
 * shape.
 *
 * Round-5 split:
 *   - `dkgGossipMsgIdRaw({ topic, data, publisherIdBytes,
 *     sequenceNumber })` — backend-agnostic primitive over canonical
 *     value types. Every backend's adapter normalises into this and
 *     the framing/hash lives here once.
 *   - `dkgGossipMsgId(msg: libp2p.Message)` — thin libp2p adapter:
 *     unwraps `from.toMultihash().bytes` and `sequenceNumber`,
 *     enforces signed-only (because libp2p's unsigned variant has
 *     no publisher identity to feed in).
 * A future `dkgGossipMsgIdIroh(msg: iroh.GossipMessage)` adapter
 * goes alongside; the framing lives once in `dkgGossipMsgIdRaw`.
 *
 * Wiring
 * ------
 * v1 ships only the function and tests. The actual `msgIdFn` wiring
 * in `node.ts` is intentionally deferred — see RFC 07 §5.4 + Phase 5
 * for the rolling-upgrade rationale and the coordinated-cutover plan.
 *
 * @experimental Public API but intentionally unwired. The encoding
 * is pinned by `gossip-msg-id.test.ts`; downstream consumers may
 * import for inspection / future-backend adapters but should not
 * rely on the in-process libp2p mesh routing through it yet.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import type { Message } from '@libp2p/gossipsub';

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

function u64be(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, false);
  return b;
}

export class DkgGossipUnsignedMessageError extends Error {
  constructor() {
    super(
      'dkgGossipMsgId: unsigned messages are not supported. The DKG msgId ' +
        'scheme requires a publisher identity (`from`) and `sequenceNumber` ' +
        'to avoid false dedup of payload-identical publishes from different ' +
        'publishers. Use StrictSign (the gossipsub default) or extend the ' +
        'scheme with a per-message nonce.',
    );
    this.name = 'DkgGossipUnsignedMessageError';
  }
}

/**
 * Inputs for the backend-agnostic msgId primitive.
 *
 * - `topic` — gossip topic string (UTF-8 encoded inside the function).
 * - `data` — raw payload bytes.
 * - `publisherIdBytes` — canonical bytes identifying the publisher.
 *   For libp2p, this is `peerId.toMultihash().bytes`. For other
 *   backends, the equivalent canonical identity bytes. MUST be
 *   non-empty — see `DkgGossipMissingPublisherError` below.
 * - `sequenceNumber` — per-publisher monotonic sequence (gossipsub
 *   seqno, iroh sequence, etc.).
 *
 * @experimental
 */
export interface DkgGossipMsgIdInput {
  topic: string;
  data: Uint8Array;
  publisherIdBytes: Uint8Array;
  sequenceNumber: bigint;
}

/**
 * Thrown when `publisherIdBytes` is empty. The DKG msgId scheme is
 * built on the invariant that two payload-identical publishes from
 * different publishers must hash to different ids; an empty publisher
 * identity collapses that distinction.
 *
 * @experimental
 */
export class DkgGossipMissingPublisherError extends Error {
  constructor() {
    super(
      'dkgGossipMsgIdRaw: publisherIdBytes must be non-empty. The DKG ' +
        'msgId scheme requires publisher identity to avoid false dedup of ' +
        'payload-identical publishes from different publishers. Future ' +
        'backends MUST plumb their canonical publisher-identity bytes ' +
        'into this primitive.',
    );
    this.name = 'DkgGossipMissingPublisherError';
  }
}

/**
 * Backend-agnostic msgId primitive. Every gossip backend adapter
 * normalises into `DkgGossipMsgIdInput` and the framing + hash
 * lives here once.
 *
 * Throws `DkgGossipMissingPublisherError` if `publisherIdBytes` is
 * empty. Codex review feedback PR #501 round 6: the libp2p adapter
 * already rejects unsigned messages (where publisher identity is
 * absent), but the raw primitive used to accept the equivalent
 * `publisherIdBytes.length === 0` case, reopening the false-dedup
 * hazard at the cross-backend boundary the primitive was meant to
 * lock down.
 *
 * @experimental
 */
export function dkgGossipMsgIdRaw(input: DkgGossipMsgIdInput): Uint8Array {
  const topicBytes = new TextEncoder().encode(input.topic);
  const data = input.data;
  const fromBytes = input.publisherIdBytes;
  const seqno = input.sequenceNumber;

  if (fromBytes.length === 0) {
    throw new DkgGossipMissingPublisherError();
  }

  const total =
    4 + topicBytes.length +
    4 + data.length +
    4 + fromBytes.length +
    8;
  const buf = new Uint8Array(total);
  let off = 0;

  buf.set(u32be(topicBytes.length), off); off += 4;
  buf.set(topicBytes, off);                off += topicBytes.length;

  buf.set(u32be(data.length), off);        off += 4;
  buf.set(data, off);                      off += data.length;

  buf.set(u32be(fromBytes.length), off);   off += 4;
  buf.set(fromBytes, off);                 off += fromBytes.length;

  buf.set(u64be(seqno), off);

  return sha256(buf);
}

/**
 * libp2p-gossipsub adapter. Suitable as the `msgIdFn` parameter of
 * `gossipsub({ ... })` when (eventually) wired in `node.ts`.
 *
 * Throws `DkgGossipUnsignedMessageError` if `msg.type !== 'signed'`.
 *
 * @experimental Public but intentionally unwired in v1; see file
 * doc-comment + RFC 07 §5.4 for the rollout plan.
 */
export function dkgGossipMsgId(msg: Message): Uint8Array {
  if (msg.type !== 'signed') {
    throw new DkgGossipUnsignedMessageError();
  }
  return dkgGossipMsgIdRaw({
    topic: msg.topic,
    data: msg.data,
    publisherIdBytes: msg.from.toMultihash().bytes,
    sequenceNumber: msg.sequenceNumber,
  });
}
