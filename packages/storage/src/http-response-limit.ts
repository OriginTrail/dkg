import {
  BoundedResponseBodyLimitError,
  readResponseBodyBytesBounded,
} from '@origintrail-official/dkg-http-utils';

export interface StoreResponseTooLargeErrorLike {
  readonly code: 'STORE_RESPONSE_TOO_LARGE';
  readonly maxBytes: number;
  readonly actualBytes: number | bigint;
  readonly message: string;
}

export class StoreResponseTooLargeError extends Error
  implements StoreResponseTooLargeErrorLike {
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

/** Cross-worker structural guard for the store response-size contract. */
export function isStoreResponseTooLargeError(
  error: unknown,
): error is StoreResponseTooLargeErrorLike {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: unknown;
    maxBytes?: unknown;
    actualBytes?: unknown;
    message?: unknown;
  };
  return candidate.code === 'STORE_RESPONSE_TOO_LARGE'
    && typeof candidate.maxBytes === 'number'
    && Number.isSafeInteger(candidate.maxBytes)
    && candidate.maxBytes >= 0
    && (
      (typeof candidate.actualBytes === 'number'
        && Number.isFinite(candidate.actualBytes)
        && candidate.actualBytes >= 0)
      || (typeof candidate.actualBytes === 'bigint' && candidate.actualBytes >= 0n)
    )
    && typeof candidate.message === 'string';
}

export function assertValidMaxResponseBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxResponseBytes must be a non-negative safe integer');
  }
}

/** Read a fetch response body without ever buffering more than `maxBytes`. */
export async function readResponseTextBounded(
  response: Response,
  maxBytes: number,
): Promise<string> {
  assertValidMaxResponseBytes(maxBytes);

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
