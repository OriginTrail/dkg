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

  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declaredBytes = BigInt(contentLength);
    if (declaredBytes > BigInt(maxBytes)) {
      await response.body?.cancel().catch(() => undefined);
      throw new BoundedResponseBodyLimitError(maxBytes, declaredBytes, 'content-length');
    }
  }

  if (response.body === null) return new Uint8Array();
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
        throw new BoundedResponseBodyLimitError(maxBytes, totalBytes, 'stream');
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
  return body;
}
