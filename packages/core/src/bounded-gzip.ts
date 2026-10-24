// SPDX-License-Identifier: Apache-2.0
import { createGzip, createGunzip, type Gzip, type Gunzip } from 'node:zlib';

export interface BoundedGzipOptions {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxOutputLines?: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}
const MAX_CODEC_BYTES = 16 * 1024 * 1024;
const MAX_CODEC_TIMEOUT_MS = 5_000;
const PROCESS_CODEC_RESERVED_BYTES = 96 * 1024 * 1024;
const MAX_ACTIVE_CODECS = 4;
let reservedBytes = 0;
let activeCodecs = 0;

export class BoundedGzipLimitError extends Error {
  readonly code = 'BOUNDED_GZIP_LIMIT';
  constructor(readonly dimension: 'input-bytes' | 'output-bytes' | 'output-lines', readonly limit: number) {
    super(`Bounded gzip ${dimension} exceeds ${limit}`);
  }
}
export class BoundedGzipCapacityError extends Error {
  readonly code = 'BOUNDED_GZIP_CAPACITY';
  constructor() { super('Bounded gzip process capacity unavailable'); }
}
function validate(options: BoundedGzipOptions) {
  for (const value of [options.maxInputBytes, options.maxOutputBytes]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CODEC_BYTES) throw new TypeError('Invalid bounded gzip byte ceiling');
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_CODEC_TIMEOUT_MS
    || (options.maxOutputLines !== undefined && (!Number.isSafeInteger(options.maxOutputLines)
      || options.maxOutputLines < 1 || options.maxOutputLines > 100_000))) throw new TypeError('Invalid bounded gzip work ceiling');
}

/** A native zlib stream is retired and physically closed before this promise settles. */
async function transform(input: Uint8Array, options: BoundedGzipOptions, inflate: boolean): Promise<Uint8Array> {
  validate(options); options.signal?.throwIfAborted();
  if (!(input instanceof Uint8Array)) throw new TypeError('Bounded gzip input must be bytes');
  if (input.byteLength > options.maxInputBytes) throw new BoundedGzipLimitError('input-bytes', options.maxInputBytes);
  // Own an input copy, output chunks and their final concatenation. Reserve
  // worst-case capacity before dispatch; fail locally rather than queueing.
  const reservation = input.byteLength + 2 * options.maxOutputBytes;
  if (activeCodecs >= MAX_ACTIVE_CODECS || reservedBytes + reservation > PROCESS_CODEC_RESERVED_BYTES) throw new BoundedGzipCapacityError();
  activeCodecs++; reservedBytes += reservation;
  let codec: Gzip | Gunzip | undefined;
  try {
    const source = Buffer.from(input);
    codec = inflate ? createGunzip({ chunkSize: 64 * 1024 }) : createGzip({ level: 1, chunkSize: 64 * 1024 });
    const ownedCodec = codec;
    return await new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let outputBytes = 0; let outputLines = 0; let lastByte: number | undefined;
      let failure: unknown; let ended = false; let inputOffset = 0; let nativePending = false;
      const fail = (error: unknown, physicalCallback = false) => {
        failure ??= error;
        // Node's zlib destroy closes the handle synchronously even when a
        // native write is still pending. Defer destruction until that worker
        // calls back; a timeout cannot release physical capacity prematurely.
        if ((!nativePending || physicalCallback) && !ownedCodec.destroyed) ownedCodec.destroy(error instanceof Error ? error : new Error(String(error)));
      };
      const onAbort = () => fail(options.signal!.reason ?? new DOMException('Gzip cancelled', 'AbortError'));
      const timer = setTimeout(() => fail(new DOMException('Bounded gzip deadline exceeded', 'TimeoutError')), options.timeoutMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      ownedCodec.on('error', error => { failure ??= error; });
      ownedCodec.on('data', (chunk: Buffer) => {
        if (failure !== undefined) { fail(failure, true); return; }
        outputBytes += chunk.byteLength;
        if (outputBytes > options.maxOutputBytes) { fail(new BoundedGzipLimitError('output-bytes', options.maxOutputBytes), true); return; }
        if (options.maxOutputLines !== undefined) {
          for (const byte of chunk) if (byte === 10) outputLines++;
          lastByte = chunk.at(-1);
          if (outputLines > options.maxOutputLines) { fail(new BoundedGzipLimitError('output-lines', options.maxOutputLines), true); return; }
        }
        chunks.push(chunk);
      });
      ownedCodec.on('end', () => {
        ended = true; nativePending = false;
        if (options.maxOutputLines !== undefined && outputLines + (lastByte !== undefined && lastByte !== 10 ? 1 : 0) > options.maxOutputLines) {
          fail(new BoundedGzipLimitError('output-lines', options.maxOutputLines));
        }
      });
      ownedCodec.on('close', () => {
        clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
        if (failure !== undefined) reject(failure);
        else if (!ended) reject(new Error('Bounded gzip closed before completion'));
        else {
          const joined = Buffer.concat(chunks, outputBytes);
          resolve(new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength));
        }
      });
      const dispatch = () => {
        if (ownedCodec.destroyed) return;
        if (options.signal?.aborted) { onAbort(); return; }
        if (inputOffset >= source.byteLength) {
          nativePending = true;
          ownedCodec.end(() => { nativePending = false; if (failure !== undefined) fail(failure, true); });
          return;
        }
        const next = Math.min(inputOffset + 64 * 1024, source.byteLength);
        const chunk = source.subarray(inputOffset, next); inputOffset = next;
        nativePending = true;
        ownedCodec.write(chunk, error => {
          nativePending = false;
          if (error) fail(error, true); else if (failure !== undefined) fail(failure, true); else dispatch();
        });
      };
      dispatch();
    });
  } finally {
    // close is awaited above, so a cancelled native worker cannot overlap a
    // caller's fallback or retain its process reservation after settlement.
    if (codec && !codec.destroyed) codec.destroy();
    activeCodecs--; reservedBytes -= reservation;
  }
}
export function gzipBounded(input: Uint8Array, options: BoundedGzipOptions): Promise<Uint8Array> { return transform(input, options, false); }
export function gunzipBounded(input: Uint8Array, options: BoundedGzipOptions): Promise<Uint8Array> { return transform(input, options, true); }
