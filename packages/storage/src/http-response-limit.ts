export class StoreResponseTooLargeError extends Error {
  readonly code = 'STORE_RESPONSE_TOO_LARGE';
  readonly maxBytes: number;
  readonly actualBytes: number | bigint;

  constructor(maxBytes: number, actualBytes: number | bigint) {
    super(`Triple-store response exceeds byte limit: found ${actualBytes}, limit ${maxBytes}`);
    this.name = 'StoreResponseTooLargeError';
    this.maxBytes = maxBytes;
    this.actualBytes = actualBytes;
  }
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
