/**
 * Wire framing for `/dkg/10.0.2/message` and any future long-lived
 * messenger transport. Each frame is:
 *
 *   <uvarint frame-length><frame-body>
 *
 * Where `frame-body` is:
 *
 *   <uvarint frame-type><payload bytes>
 *
 * Frame types:
 *
 *   * 0x01 REQUEST  — application payload (sender → receiver)
 *   * 0x02 RESPONSE — application payload (receiver → sender)
 *   * 0x03 ERROR    — UTF-8 error string (receiver → sender, terminal for that request)
 *   * 0x04 PING     — keepalive probe, no payload
 *   * 0x05 PONG     — keepalive acknowledgement, no payload
 *
 * Design constraints:
 *
 *   * **Variable-length integer (uvarint)** — Protobuf-compatible
 *     varint encoding for both `frame-length` and `frame-type`. Lets
 *     control frames (PING/PONG, type+1 byte length=1) cost 2 bytes
 *     while keeping the door open for future >127 frame types
 *     without a wire break.
 *
 *   * **No request id at the wire level (yet).** The pool serialises
 *     requests per stream — at most one request in-flight per
 *     `(peer, protocol)` pair. The next RESPONSE/ERROR frame the
 *     reader sees IS the answer to the most recent REQUEST. Adding
 *     request ids costs ~3 bytes/frame and adds dispatcher
 *     complexity that the chat-rate workload doesn't need; if a
 *     future caller pipelines, we can introduce a `0x06 REQUEST_V2`
 *     frame type with an embedded id without breaking 0x01 readers.
 *
 *   * **Bounded frame size.** The decoder rejects any frame whose
 *     declared length exceeds the configured cap (default 10 MiB,
 *     matching {@link DEFAULT_MAX_READ_BYTES} in `protocol-router.ts`).
 *     A malicious or buggy peer cannot pin our memory by claiming a
 *     huge frame; the limit triggers a stream-level abort.
 *
 *   * **Streaming decode.** The decoder is an async generator that
 *     consumes bytes incrementally from any `AsyncIterable<Uint8Array>`
 *     source (libp2p `Stream` works directly). It yields each frame
 *     as soon as the full body has arrived; partial-frame state is
 *     held in an internal buffer.
 *
 * No external dependencies — varint impl is inline (~25 LoC).
 */

/**
 * Wire-level frame type discriminator. Values are stable as part of
 * the `/dkg/10.0.2/*` wire format; never renumber.
 */
export enum FrameType {
  REQUEST = 0x01,
  RESPONSE = 0x02,
  ERROR = 0x03,
  PING = 0x04,
  PONG = 0x05,
}

/**
 * A single decoded wire frame. `payload` is the raw bytes after the
 * type byte; for ERROR frames it's the UTF-8-encoded error message,
 * for PING/PONG it's a zero-length view.
 */
export interface DecodedFrame {
  type: FrameType;
  payload: Uint8Array;
}

/** Default per-frame max length, matching the protocol-router cap. */
export const DEFAULT_MAX_FRAME_BYTES = 10 * 1024 * 1024;

/** Maximum bytes a uvarint length prefix may consume (5 bytes covers 0..2^35). */
const MAX_VARINT_BYTES = 5;

/**
 * Encode a non-negative integer as a uvarint (LEB128 / Protobuf).
 * Returns the encoded bytes; throws on negative or >= 2^32 input.
 * Exported for tests.
 */
export function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`encodeVarint: out of range (${value})`);
  }
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return new Uint8Array(out);
}

/**
 * Try to decode a uvarint from `buf` starting at `offset`. Returns
 * `{ value, bytesRead }` on success or `null` if the buffer doesn't
 * yet contain the full varint (caller should buffer more bytes and
 * retry). Throws on overlong / out-of-range encodings.
 *
 * Implementation note: accumulates arithmetically rather than via
 * `<<` shifts because the 5th byte of a varint contributes bits
 * 28..34 to the result. JavaScript's bitwise operators are 32-bit
 * signed-coerce, so `(byte & 0x7f) << 28` truncates bits 31..34
 * and would let a 5-byte varint with payload > 2^32-1 wrap to a
 * smaller value instead of throwing as the docstring promises.
 * Codex PR #560 review caught the regression. We use `Math.pow(2,
 * shift) * payload` to stay in IEEE 754 double space (lossless up
 * to 2^53) and explicitly reject values >= 2^32 on the 5th byte.
 */
export function tryDecodeVarint(
  buf: Uint8Array,
  offset = 0,
): { value: number; bytesRead: number } | null {
  let value = 0;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    if (offset + i >= buf.length) return null;
    const byte = buf[offset + i]!;
    const payload = byte & 0x7f;
    // On the 5th byte (i === 4) the payload contributes bits 28..34.
    // Only the low 4 bits (0..15) are representable inside a 32-bit
    // unsigned integer; anything larger is an out-of-range encoding.
    if (i === 4 && payload > 0x0f) {
      throw new RangeError('tryDecodeVarint: varint exceeds 32-bit range');
    }
    value += payload * Math.pow(2, 7 * i);
    if ((byte & 0x80) === 0) {
      // Defensive: ensure we never return a value outside the
      // documented 0..2^32-1 range, even on legal 5-byte encodings
      // whose high bits sum to just under the cap. The check above
      // already covers this in practice, but the bound makes the
      // post-condition explicit.
      if (value > 0xffffffff) {
        throw new RangeError('tryDecodeVarint: varint exceeds 32-bit range');
      }
      return { value, bytesRead: i + 1 };
    }
  }
  throw new RangeError('tryDecodeVarint: varint exceeds 5 bytes');
}

/**
 * Encode a frame as `<uvarint body-length><uvarint frame-type><payload bytes>`.
 *
 * The body-length covers both the type varint and the payload, so a
 * reader can `read N bytes` after the length prefix and recover the
 * entire frame as one blob — useful when the stream's underlying
 * `for await` chunks don't align with frame boundaries.
 */
export function encodeFrame(type: FrameType, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const typeBytes = encodeVarint(type);
  const bodyLength = typeBytes.length + payload.length;
  const lengthBytes = encodeVarint(bodyLength);
  const out = new Uint8Array(lengthBytes.length + bodyLength);
  out.set(lengthBytes, 0);
  out.set(typeBytes, lengthBytes.length);
  out.set(payload, lengthBytes.length + typeBytes.length);
  return out;
}

/**
 * Streaming frame decoder. Consumes bytes from `source` and yields
 * each fully-arrived `DecodedFrame`. Stops when the source is
 * exhausted (graceful close) — a partial frame at EOF is treated as
 * a protocol error and throws.
 *
 * @param source Any async byte stream (libp2p `Stream` works directly).
 * @param maxFrameBytes Reject frames larger than this. Default 10 MiB.
 */
export async function* decodeFrames(
  source: AsyncIterable<Uint8Array>,
  maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES,
): AsyncGenerator<DecodedFrame, void, void> {
  let buf = new Uint8Array(0);

  // Read more bytes from the source into `buf`. Returns true when a
  // new chunk arrived, false on EOF.
  const sourceIterator = source[Symbol.asyncIterator]();

  async function readMore(): Promise<boolean> {
    const next = await sourceIterator.next();
    if (next.done) return false;
    const chunk = next.value instanceof Uint8Array
      ? next.value
      : new Uint8Array((next.value as { subarray: () => Uint8Array }).subarray());
    if (chunk.length === 0) {
      // Empty chunk — keep reading. Some libp2p stream impls emit
      // them at backpressure boundaries.
      return readMore();
    }
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf, 0);
    merged.set(chunk, buf.length);
    buf = merged;
    return true;
  }

  while (true) {
    let lengthHeader: { value: number; bytesRead: number } | null = null;
    while (lengthHeader === null) {
      lengthHeader = tryDecodeVarint(buf, 0);
      if (lengthHeader !== null) break;
      const got = await readMore();
      if (!got) {
        if (buf.length === 0) return; // clean EOF
        throw new Error('decodeFrames: stream ended mid-length-prefix');
      }
    }
    const bodyLength = lengthHeader.value;
    if (bodyLength > maxFrameBytes) {
      throw new Error(
        `decodeFrames: frame length ${bodyLength} exceeds cap ${maxFrameBytes}`,
      );
    }
    while (buf.length < lengthHeader.bytesRead + bodyLength) {
      const got = await readMore();
      if (!got) {
        throw new Error('decodeFrames: stream ended mid-frame-body');
      }
    }
    const bodyStart = lengthHeader.bytesRead;
    const bodyEnd = bodyStart + bodyLength;
    const typeHeader = tryDecodeVarint(buf, bodyStart);
    if (typeHeader === null) {
      throw new Error('decodeFrames: malformed frame (empty body)');
    }
    if (typeHeader.bytesRead > bodyLength) {
      throw new Error('decodeFrames: frame body too short for type prefix');
    }
    const payloadStart = bodyStart + typeHeader.bytesRead;
    const payload = buf.slice(payloadStart, bodyEnd);

    yield { type: typeHeader.value as FrameType, payload };

    // Compact buf: drop everything we just consumed.
    buf = buf.length === bodyEnd ? new Uint8Array(0) : buf.slice(bodyEnd);
  }
}
