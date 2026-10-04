// SPDX-License-Identifier: Apache-2.0

/** Retryable authority-index failure that may succeed on another RPC reader. */
export class ContextGraphAuthorityIndexRetryableError extends Error {
  override readonly name = 'ContextGraphAuthorityIndexRetryableError';

  constructor(
    message: string,
    readonly reason?: 'cursor-ahead',
  ) {
    super(message);
  }
}

export function isContextGraphAuthorityIndexRetryableError(
  error: unknown,
): error is ContextGraphAuthorityIndexRetryableError {
  return error instanceof ContextGraphAuthorityIndexRetryableError;
}
