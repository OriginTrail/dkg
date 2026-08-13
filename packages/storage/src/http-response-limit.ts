export const STORE_RESPONSE_TOO_LARGE_CODE = 'STORE_RESPONSE_TOO_LARGE';

export class StoreResponseTooLargeError extends Error {
  readonly code = STORE_RESPONSE_TOO_LARGE_CODE;
  readonly maxBytes: number;
  readonly actualBytes: number | bigint;

  constructor(maxBytes: number, actualBytes: number | bigint) {
    super(`Triple-store response exceeds byte limit: found ${actualBytes}, limit ${maxBytes}`);
    this.name = 'StoreResponseTooLargeError';
    this.maxBytes = maxBytes;
    this.actualBytes = actualBytes;
  }
}

/**
 * THE canonical test for "the transport refused an oversized body".
 *
 * Lives next to the class that defines the code so a caller never has to restate either.
 * Deliberately NOT `instanceof` alone: not every client throws this class — the managed
 * SPARQL client raises its own error when a chunk would exceed the remaining budget — so
 * the code is the wider net, and both shapes carry it.
 */
export function isStoreResponseTooLargeErrorV1(error: unknown): boolean {
  return error instanceof StoreResponseTooLargeError
    || (typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === STORE_RESPONSE_TOO_LARGE_CODE);
}

/** Read a fetch response body without ever buffering more than `maxBytes`. */
export async function readResponseTextBounded(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxResponseBytes must be a non-negative safe integer');
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength)) {
    const declaredBytes = BigInt(contentLength);
    if (declaredBytes > BigInt(maxBytes)) {
      throw new StoreResponseTooLargeError(maxBytes, declaredBytes);
    }
  }

  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new StoreResponseTooLargeError(maxBytes, totalBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
