import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { StoreResponseTooLargeError } from './http-response-limit.js';

/** A caller's logical result budget also bounds disk-backed literal allocation. */
export class LiteralHydrationBudget {
  private used = 0;
  constructor(readonly limit: number | undefined) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
      throw new RangeError('maxResponseBytes must be a non-negative safe integer');
  }
  get remaining(): number | undefined { return this.limit === undefined ? undefined : this.limit - this.used; }
  consume(value: string): string {
    this.used += Buffer.byteLength(value);
    if (this.limit !== undefined && this.used > this.limit) throw new StoreResponseTooLargeError(this.limit, this.used);
    return value;
  }
}

export async function readLiteralBlobBounded(path: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('External literal blob is not a regular file');
    if (stat.size > maxBytes) throw new StoreResponseTooLargeError(maxBytes, stat.size);
    // One sentinel byte detects growth after stat without an unbounded readFile.
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      signal?.throwIfAborted();
      const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    signal?.throwIfAborted();
    if (bytes > stat.size) throw new StoreResponseTooLargeError(maxBytes, bytes);
    const content = buffer.subarray(0, bytes).toString('utf8');
    return content;
  } finally { await file.close(); }
}
