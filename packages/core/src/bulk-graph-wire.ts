// SPDX-License-Identifier: Apache-2.0
/** Separate protocol: CREDIT is staged receipt; COMMIT alone means durable application. */
export const BULK_GRAPH_PROTOCOL = '/dkg/experimental/bulk-graph/1.0.0';
export const BULK_GRAPH_CHUNK_BYTES = 100_000_000;
export const BULK_GRAPH_MAX_ASSETS = 1024;
export const BULK_GRAPH_FRAME_BYTES = 64 * 1024;
export const BULK_GRAPH_REQUEST_BYTES = 512 * 1024;
export const BULK_GRAPH_HEADER_BYTES = 20;
export const BULK_GRAPH_KIND = Object.freeze({ REQUEST: 1, META: 2, DATA: 3, ASSET_END: 4,
  CREDIT: 5, COMMIT: 6, CHUNK_END: 7, REFUSE: 8 });
export interface BulkGraphFrame { kind: number; index: number; sequence: number; payload: Uint8Array }
const MAGIC = 0x444b4732;
export function validateBulkGraphHeader(kind: number, index: number, sequence: number, length: number): void {
  if (![kind,index,sequence,length].every(Number.isSafeInteger) || kind < 1 || kind > 8
    || index < 0 || index > BULK_GRAPH_MAX_ASSETS || sequence < 0 || sequence > 0xffffffff || length < 0)
    throw new Error('Invalid bulk graph frame header');
  const limit = kind === BULK_GRAPH_KIND.REQUEST ? BULK_GRAPH_REQUEST_BYTES
    : kind === BULK_GRAPH_KIND.META ? 128 * 1024 : BULK_GRAPH_FRAME_BYTES;
  if (length > limit || ([4,5,6].includes(kind) && length !== 0)
    || ([1,2,3,7,8].includes(kind) && length === 0)) throw new Error('Invalid bulk graph frame length');
}
export function encodeBulkGraphFrame(frame: BulkGraphFrame): Uint8Array {
  if (!(frame.payload instanceof Uint8Array)) throw new TypeError('Bulk graph payload must be bytes');
  validateBulkGraphHeader(frame.kind, frame.index, frame.sequence, frame.payload.length);
  const bytes = new Uint8Array(BULK_GRAPH_HEADER_BYTES + frame.payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC); view.setUint8(4, frame.kind); view.setUint32(8, frame.index);
  view.setUint32(12, frame.sequence); view.setUint32(16, frame.payload.length);
  bytes.set(frame.payload, BULK_GRAPH_HEADER_BYTES); return bytes;
}
/** Header-first allocation, independent of the native stream's chunk boundaries. */
export async function* decodeBulkGraphFrames(source: AsyncIterable<Uint8Array>, signal?: AbortSignal): AsyncGenerator<BulkGraphFrame> {
  const header = new Uint8Array(BULK_GRAPH_HEADER_BYTES);
  let used = 0, body: Uint8Array | undefined, bodyUsed = 0, kind = 0, index = 0, sequence = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('Bulk graph stream must yield bytes');
    let offset = 0;
    while (offset < chunk.length) {
      signal?.throwIfAborted();
      if (!body) {
        const n = Math.min(header.length - used, chunk.length - offset);
        header.set(chunk.subarray(offset, offset + n), used); used += n; offset += n;
        if (used < header.length) continue;
        const view = new DataView(header.buffer);
        if (view.getUint32(0) !== MAGIC || view.getUint8(5) || view.getUint16(6)) throw new Error('Invalid bulk graph wire version');
        kind = view.getUint8(4); index = view.getUint32(8); sequence = view.getUint32(12);
        const length = view.getUint32(16); validateBulkGraphHeader(kind,index,sequence,length);
        body = new Uint8Array(length); bodyUsed = 0;
      }
      const n = Math.min(body.length - bodyUsed, chunk.length - offset);
      body.set(chunk.subarray(offset, offset + n), bodyUsed); bodyUsed += n; offset += n;
      if (bodyUsed === body.length) {
        const frame = { kind, index, sequence, payload: body }; body = undefined; used = 0; yield frame;
      }
    }
  }
  if (used || body) throw new Error('Truncated bulk graph frame');
}
