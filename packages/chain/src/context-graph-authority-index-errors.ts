// SPDX-License-Identifier: Apache-2.0

/** Retryable authority-index failure that may succeed on another RPC reader. */
export class ContextGraphAuthorityIndexRetryableError extends Error {
  override readonly name = 'ContextGraphAuthorityIndexRetryableError';

  constructor(
    message: string,
    readonly reason?: 'cursor-ahead' | 'refresh-horizon-ahead',
  ) {
    super(message);
  }
}

export function isContextGraphAuthorityIndexRetryableError(
  error: unknown,
): error is ContextGraphAuthorityIndexRetryableError {
  return error instanceof ContextGraphAuthorityIndexRetryableError;
}

/**
 * The single fail-closed error both authority-anchor resolvers raise.
 *
 * The message is preserved verbatim as a prefix: it is the contract callers
 * (and operators reading logs) already recognize. The detail only says which
 * step of the anchor resolution failed.
 *
 * RETRYABLE by type, not by message. Every condition it reports — a head an
 * endpoint could not answer, an anchor below the configured depth, a block that
 * came back at the wrong height — is one that a different endpoint or a later
 * attempt can satisfy, so it must fail over rather than abort the authority
 * read that gates catalog admission. Typing it also keeps it away from
 * `classifyRpcRetryDisposition`'s message regex, which alternates bare
 * `429|503|502|500` with no word boundaries: the details here interpolate block
 * numbers, so a head of 31500123 would classify as `failover` and 31499123 as
 * `fail` purely on its digits.
 */
export function contextGraphAuthorityAnchorUnavailableV1(
  detail: string,
): ContextGraphAuthorityIndexRetryableError {
  return new ContextGraphAuthorityIndexRetryableError(
    `finalized Context Graph authority block is unavailable: ${detail}`,
  );
}
