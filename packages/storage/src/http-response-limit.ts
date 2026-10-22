import {
  BoundedResponseBodyLimitError,
  readResponseBodyBytesBounded,
} from '@origintrail-official/dkg-http-utils';

/** Await EOF without accumulating mutation progress output. Fetch retains its original signal. */
export async function drainResponseBody(response: Response, waitFor: <T>(work: Promise<T>) => Promise<T> = work => work): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  try { while (!(await waitFor(reader.read())).done) { /* Discard chunks. */ } }
  finally { reader.releaseLock(); }
}

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

  try {
    const bytes = await readResponseBodyBytesBounded(response, maxBytes);
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof BoundedResponseBodyLimitError) {
      throw new StoreResponseTooLargeError(maxBytes, error.actualBytes);
    }
    throw error;
  }
}
