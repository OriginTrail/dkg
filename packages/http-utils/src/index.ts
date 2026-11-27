export type BoundedResponseBodyLimitSource = 'content-length' | 'stream';

export class BoundedResponseBodyLimitError extends Error {
  readonly maxBytes: number;
  readonly actualBytes: number | bigint;
  readonly source: BoundedResponseBodyLimitSource;

  constructor(
    maxBytes: number,
    actualBytes: number | bigint,
    source: BoundedResponseBodyLimitSource,
  ) {
    super(`Response body exceeds ${maxBytes} bytes`);
    this.name = 'BoundedResponseBodyLimitError';
    this.maxBytes = maxBytes;
    this.actualBytes = actualBytes;
    this.source = source;
  }
}

/** Collect a response body under a strict encoded-byte ceiling. */
export async function readResponseBodyBytesBounded(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }

  const chunks: Uint8Array[] = [];
  const totalBytes = await consumeResponseBodyChunks(response, maxBytes, chunk => {
    chunks.push(chunk);
  });

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Consume response bytes incrementally under an optional encoded-byte ceiling.
 * Header rejection, streamed overflow, and consumer failure all cancel the
 * body before the returned promise settles.
 */
export async function consumeResponseBodyChunks(
  response: Response,
  maxBytes: number | undefined,
  consume: (chunk: Uint8Array) => void | Promise<void>,
): Promise<number> {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }

  const contentLength = response.headers.get('content-length');
  if (maxBytes !== undefined && contentLength !== null && /^\d+$/.test(contentLength)) {
    const declaredBytes = BigInt(contentLength);
    if (declaredBytes > BigInt(maxBytes)) {
      await response.body?.cancel().catch(() => undefined);
      throw new BoundedResponseBodyLimitError(maxBytes, declaredBytes, 'content-length');
    }
  }

  if (response.body === null) return 0;
  const reader = response.body.getReader();
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (maxBytes !== undefined && totalBytes > maxBytes) {
        throw new BoundedResponseBodyLimitError(maxBytes, totalBytes, 'stream');
      }
      await consume(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return totalBytes;
}

export {
  BrotliResponseRefusedError,
  fetchGlobalDispatcher,
  installGlobalBrotliRefusal,
  isBrotliRefusing,
  isComposableDispatcher,
  refuseBrotliResponses,
  withBrotliRefusal,
  type ComposableDispatcher,
  type DispatchFunction,
  type FetchGlobalDispatcher,
  type GlobalBrotliRefusal,
} from './fetch-brotli-refusal.js';
