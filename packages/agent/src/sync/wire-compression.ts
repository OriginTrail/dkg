// SPDX-License-Identifier: Apache-2.0
import { gzipBounded, gunzipBounded } from '@origintrail-official/dkg-core';

export const EXACT_SYNC_GZIP_ENCODING = 'gzip-nquads-v1' as const;
export const EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
export const EXACT_SYNC_GZIP_MAX_INFLATED_BYTES = 16 * 1024 * 1024;
export const EXACT_SYNC_GZIP_MAX_ROWS = 100_000;
export const EXACT_SYNC_GZIP_MAX_HEAP_BYTES_ESTIMATE = 32 * 1024 * 1024;
const EXACT_SYNC_GZIP_PROFILE = Object.freeze({
  responseEncoding: EXACT_SYNC_GZIP_ENCODING,
  maxCompressedBytes: EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES,
  maxInflatedBytes: EXACT_SYNC_GZIP_MAX_INFLATED_BYTES,
  maxRows: EXACT_SYNC_GZIP_MAX_ROWS,
  maxHeapBytesEstimate: EXACT_SYNC_GZIP_MAX_HEAP_BYTES_ESTIMATE,
});
export type ExactSyncGzipProfile = typeof EXACT_SYNC_GZIP_PROFILE;
const MAGIC = new TextEncoder().encode('DKGZQ01\n');
const HEADER_BYTES = 20;
const CODEC_TIMEOUT_MS = 5_000;
type CompressionRequest = Readonly<{ responseEncoding?: unknown; assetUals?: readonly string[];
  includeSharedMemory?: boolean; phase?: string }>;
export function normalizeExactSyncResponseEncoding(value: unknown): typeof EXACT_SYNC_GZIP_ENCODING | undefined {
  return value === EXACT_SYNC_GZIP_ENCODING ? EXACT_SYNC_GZIP_ENCODING : undefined;
}
/** Encoding is response shaping only; it never establishes read authority. */
export function negotiatesExactSyncGzip(request: CompressionRequest): boolean {
  return request.responseEncoding === EXACT_SYNC_GZIP_ENCODING && request.includeSharedMemory !== true
    && (request.phase === 'data' || request.phase === 'meta') && request.assetUals?.length === 1;
}
/** One negotiated encoding decision and its fixed resource ceilings. */
export function resolveExactSyncGzipProfile(request: CompressionRequest): typeof EXACT_SYNC_GZIP_PROFILE | undefined {
  return negotiatesExactSyncGzip(request) ? EXACT_SYNC_GZIP_PROFILE : undefined;
}
export function isExactSyncGzipFrame(bytes: Uint8Array): boolean {
  return bytes.byteLength >= MAGIC.length && MAGIC.every((byte, index) => bytes[index] === byte);
}
function lines(bytes: Uint8Array): number {
  let count = 0; for (const byte of bytes) if (byte === 10) count++;
  return count + (bytes.byteLength > 0 && bytes.at(-1) !== 10 ? 1 : 0);
}

/** Compress unchanged N-Quads only for a requesting, already-authorized exact peer. */
export async function encodeNegotiatedExactSyncResponse(bytes: Uint8Array, options: {
  readonly request: CompressionRequest; readonly signal?: AbortSignal;
}): Promise<Uint8Array> {
  return encodeResolvedExactSyncResponse(bytes, {
    profile: resolveExactSyncGzipProfile(options.request), signal: options.signal,
  });
}

/** Encode with the request profile already chosen by the authenticated responder. */
export async function encodeResolvedExactSyncResponse(bytes: Uint8Array, options: {
  readonly profile: ExactSyncGzipProfile | undefined; readonly signal?: AbortSignal;
}): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  const profile = options.profile;
  if (!profile || bytes.byteLength === 0) return bytes;
  if (bytes.byteLength > profile.maxInflatedBytes || lines(bytes) > profile.maxRows) {
    throw new RangeError('Exact sync decoded page exceeds bounded transport profile');
  }
  let compressed: Uint8Array;
  try {
    compressed = await gzipBounded(bytes, { maxInputBytes: profile.maxInflatedBytes,
      maxOutputBytes: profile.maxCompressedBytes - HEADER_BYTES, timeoutMs: CODEC_TIMEOUT_MS, signal: options.signal });
  } catch (error) {
    options.signal?.throwIfAborted();
    // The responder can use its existing plain path only within that path's
    // four-MiB body cap. Larger codec refusal is an error, never a partial EOF.
    if (bytes.byteLength <= profile.maxCompressedBytes) return bytes;
    throw error;
  }
  if (compressed.byteLength + HEADER_BYTES >= bytes.byteLength && bytes.byteLength <= profile.maxCompressedBytes) return bytes;
  const frame = new Uint8Array(HEADER_BYTES + compressed.byteLength);
  frame.set(MAGIC); const view = new DataView(frame.buffer);
  view.setUint32(8, bytes.byteLength); view.setUint32(12, lines(bytes)); view.setUint32(16, compressed.byteLength);
  frame.set(compressed, HEADER_BYTES); return frame;
}

/** A recognized malformed/compression-bomb frame never falls back to plaintext. */
export async function decodeNegotiatedExactSyncResponse(bytes: Uint8Array, options: {
  readonly allowCompression: boolean; readonly signal?: AbortSignal; readonly maxInflatedBytes?: number;
}): Promise<Readonly<{ bytes: Uint8Array; compressed: boolean; rows?: number }>> {
  options.signal?.throwIfAborted();
  const maxInflated = Math.min(options.maxInflatedBytes ?? EXACT_SYNC_GZIP_MAX_INFLATED_BYTES, EXACT_SYNC_GZIP_MAX_INFLATED_BYTES);
  if (!Number.isSafeInteger(maxInflated) || maxInflated < 0) throw new TypeError('Invalid exact sync inflate allowance');
  if (!isExactSyncGzipFrame(bytes)) {
    if (options.allowCompression && bytes.byteLength > EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES) throw new RangeError('Exact sync plaintext frame exceeds physical wire allowance');
    if (options.allowCompression && bytes.byteLength > maxInflated) throw new RangeError('Exact sync decoded phase exceeds remaining allowance');
    const rows = options.allowCompression ? lines(bytes) : undefined;
    if (rows !== undefined && rows > EXACT_SYNC_GZIP_MAX_ROWS) throw new RangeError('Exact sync decoded page exceeds row allowance');
    return Object.freeze({ bytes, compressed: false, ...(rows === undefined ? {} : { rows }) });
  }
  if (!options.allowCompression || bytes.byteLength < HEADER_BYTES || bytes.byteLength > EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES) {
    throw new Error('Unnegotiated or oversized exact sync gzip frame');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const inflatedLength = view.getUint32(8), rowCount = view.getUint32(12), compressedLength = view.getUint32(16);
  if (inflatedLength < 1 || inflatedLength > maxInflated || rowCount < 1 || rowCount > EXACT_SYNC_GZIP_MAX_ROWS
    || compressedLength < 18 || compressedLength !== bytes.byteLength - HEADER_BYTES) throw new Error('Invalid exact sync gzip lengths or rows');
  const inflated = await gunzipBounded(bytes.subarray(HEADER_BYTES), { maxInputBytes: EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES,
    maxOutputBytes: inflatedLength, maxOutputLines: rowCount, timeoutMs: CODEC_TIMEOUT_MS, signal: options.signal });
  if (inflated.byteLength !== inflatedLength || lines(inflated) !== rowCount) throw new Error('Exact sync gzip declared length/row mismatch');
  new TextDecoder('utf-8', { fatal: true }).decode(inflated);
  options.signal?.throwIfAborted(); return Object.freeze({ bytes: inflated, compressed: true, rows: rowCount });
}
