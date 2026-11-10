export class RequestBodyLimitError extends Error {
  constructor(maxBytes) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = 'RequestBodyLimitError';
  }
}

/** Collect incoming bytes; callers own admission, decoding and HTTP errors.
 * On overflow, preserve the socket so the caller can send its rejection with
 * shouldKeepAlive=false. The HTTP server then closes it after flushing the reply.
 */
export async function readRequestBodyBytesBounded(request, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Invalid request byte limit');
  const chunks = []; let size = 0;
  const input = typeof request.iterator === 'function' ? request.iterator({ destroyOnReturn: false }) : request;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new RequestBodyLimitError(maxBytes);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}
