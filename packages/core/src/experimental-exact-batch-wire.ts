// SPDX-License-Identifier: Apache-2.0
/** Fixed experimental wire contract; registration and authorization belong to the host. */
export const EXACT_BATCH_STREAM_PROTOCOL = '/dkg/experimental/exact-batch-stream/1.0.0';
/** Fixed experimental profile, not an additional signed request field. */
export const EXACT_BATCH_STREAM_WINDOW_SIZE = 2 as const;
export const EXACT_BATCH_FRAME_KIND = Object.freeze({ REQUEST: 1, META: 2, DATA: 3, ASSET_END: 4, ACK: 5, BATCH_END: 6, REFUSE: 7 });
export const EXACT_BATCH_BATCH_INDEX = 255;
export const EXACT_BATCH_FRAME_HEADER_BYTES = 16;
export const EXACT_BATCH_MAX_FRAME_BYTES = 64 * 1024;
export const EXACT_BATCH_MAX_REQUEST_BYTES = 8 * 1024;
export const EXACT_BATCH_MAX_ASSETS = 10;
export const EXACT_BATCH_MAX_CHUNKS_PER_ASSET = 1024;
const MAGIC = new Uint8Array([68, 75, 66, 49]); // DKB1
/**
 * `BUSY` (added after the first five) says the responder is alive and could not
 * admit the request now. A requester built before it rejects the frame as an
 * unknown refusal, which it handles like the stream reset it got before.
 */
export const EXACT_BATCH_REFUSALS = Object.freeze(['UNSUPPORTED', 'RESOURCE_LIMIT', 'SOURCE_CHANGED', 'ASSET_MISSING', 'DENIED', 'BUSY'] as const);
export type ExactBatchFrameKind = typeof EXACT_BATCH_FRAME_KIND[keyof typeof EXACT_BATCH_FRAME_KIND];
export type ExactBatchRefusal = typeof EXACT_BATCH_REFUSALS[number];
export interface ExactBatchFrame {
  readonly kind: number;
  readonly assetIndex: number;
  readonly sequence: number;
  readonly payload: Uint8Array;
}

function uint(value: number, max: number): boolean { return Number.isInteger(value) && value >= 0 && value <= max; }
function validateHeader(kind: number, index: number, sequence: number, length: number): void {
  if (!uint(kind, 7) || kind === 0 || !uint(index, 255) || !uint(sequence, 0xffff_ffff) || !uint(length, EXACT_BATCH_MAX_FRAME_BYTES)) {
    throw new Error('Invalid exact batch frame header');
  }
  const batch = kind === EXACT_BATCH_FRAME_KIND.REQUEST || kind === EXACT_BATCH_FRAME_KIND.BATCH_END || kind === EXACT_BATCH_FRAME_KIND.REFUSE;
  if (batch ? index !== EXACT_BATCH_BATCH_INDEX : index >= EXACT_BATCH_MAX_ASSETS) throw new Error('Invalid exact batch frame index');
  if (kind === EXACT_BATCH_FRAME_KIND.REQUEST && (sequence !== 0 || length < 1 || length > EXACT_BATCH_MAX_REQUEST_BYTES)) throw new Error('Invalid exact batch request');
  if (kind === EXACT_BATCH_FRAME_KIND.META && (sequence !== 0 || length < 1)) throw new Error('Invalid exact batch metadata');
  if (kind === EXACT_BATCH_FRAME_KIND.DATA && (length < 1 || sequence >= EXACT_BATCH_MAX_CHUNKS_PER_ASSET)) throw new Error('Invalid exact batch data frame');
  if ((kind === EXACT_BATCH_FRAME_KIND.ASSET_END || kind === EXACT_BATCH_FRAME_KIND.ACK || kind === EXACT_BATCH_FRAME_KIND.BATCH_END) && length !== 0) throw new Error('Invalid exact batch control payload');
  if ((kind === EXACT_BATCH_FRAME_KIND.ASSET_END || kind === EXACT_BATCH_FRAME_KIND.ACK) && (sequence < 1 || sequence > EXACT_BATCH_MAX_CHUNKS_PER_ASSET)) throw new Error('Invalid exact batch chunk count');
  if (kind === EXACT_BATCH_FRAME_KIND.BATCH_END && (sequence < 1 || sequence > EXACT_BATCH_MAX_ASSETS)) throw new Error('Invalid exact batch end count');
  if (kind === EXACT_BATCH_FRAME_KIND.REFUSE && (sequence !== 0 || length < 1 || length > 64)) throw new Error('Invalid exact batch refusal');
}
function validatePayload(frame: ExactBatchFrame): void {
  if (frame.kind === EXACT_BATCH_FRAME_KIND.REFUSE) {
    const code = new TextDecoder('utf-8', { fatal: true }).decode(frame.payload);
    if (!(EXACT_BATCH_REFUSALS as readonly string[]).includes(code)) throw new Error('Unknown exact batch refusal');
  }
}

/** Validate a wire frame without interpreting its asset or compression payload. */
export function validateExactBatchFrame(frame: ExactBatchFrame): void {
  if (!(frame.payload instanceof Uint8Array)) throw new TypeError('Exact batch payload must be bytes');
  validateHeader(frame.kind, frame.assetIndex, frame.sequence, frame.payload.byteLength); validatePayload(frame);
}

export function encodeExactBatchFrame(frame: ExactBatchFrame): Uint8Array {
  validateExactBatchFrame(frame);
  const result = new Uint8Array(EXACT_BATCH_FRAME_HEADER_BYTES + frame.payload.byteLength);
  result.set(MAGIC); const view = new DataView(result.buffer);
  view.setUint8(4, frame.kind); view.setUint8(5, frame.assetIndex);
  view.setUint32(8, frame.sequence); view.setUint32(12, frame.payload.byteLength);
  result.set(frame.payload, EXACT_BATCH_FRAME_HEADER_BYTES); return result;
}

/** Incremental header-first parsing: never concatenate unbounded source chunks. */
export async function* decodeExactBatchFrames(source: AsyncIterable<Uint8Array>, options: { readonly signal?: AbortSignal } = {}): AsyncGenerator<ExactBatchFrame> {
  const header = new Uint8Array(EXACT_BATCH_FRAME_HEADER_BYTES);
  let headerBytes = 0, body: Uint8Array | undefined, bodyBytes = 0;
  let kind = 0, index = 0, sequence = 0;
  for await (const chunk of source) {
    options.signal?.throwIfAborted();
    if (!(chunk instanceof Uint8Array)) throw new TypeError('Exact batch stream must yield bytes');
    let offset = 0;
    while (offset < chunk.byteLength) {
      options.signal?.throwIfAborted();
      if (body === undefined) {
        const take = Math.min(header.byteLength - headerBytes, chunk.byteLength - offset);
        header.set(chunk.subarray(offset, offset + take), headerBytes); headerBytes += take; offset += take;
        if (headerBytes < header.byteLength) continue;
        const view = new DataView(header.buffer);
        if (!MAGIC.every((byte, i) => header[i] === byte) || view.getUint16(6) !== 0) throw new Error('Invalid exact batch magic or reserved bits');
        kind = view.getUint8(4); index = view.getUint8(5); sequence = view.getUint32(8);
        const length = view.getUint32(12); validateHeader(kind, index, sequence, length);
        body = new Uint8Array(length); bodyBytes = 0;
      }
      const take = Math.min(body.byteLength - bodyBytes, chunk.byteLength - offset);
      body.set(chunk.subarray(offset, offset + take), bodyBytes); bodyBytes += take; offset += take;
      if (bodyBytes === body.byteLength) {
        const frame = Object.freeze({ kind, assetIndex: index, sequence, payload: body }); validatePayload(frame);
        body = undefined; headerBytes = 0; yield frame;
      }
    }
  }
  options.signal?.throwIfAborted();
  if (headerBytes !== 0 || body !== undefined) throw new Error('Truncated exact batch stream frame');
}

