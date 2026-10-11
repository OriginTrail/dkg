// SPDX-License-Identifier: Apache-2.0

/**
 * Typed failures of an external JSON-RPC signer. Every one is final for the
 * operation that hit it: the RPC retry classifier treats them as non-retryable
 * so no endpoint failover or retry loop asks the signer to sign again.
 */
export type RemoteSignerErrorCode =
  /** The signer configuration is invalid. */
  | 'REMOTE_SIGNER_CONFIG'
  /** The signer could not be reached (connection refused, missing socket, TLS failure, ...). */
  | 'REMOTE_SIGNER_UNAVAILABLE'
  /** No complete response arrived within the configured timeout. */
  | 'REMOTE_SIGNER_TIMEOUT'
  /** The signer refused the credentials (HTTP 401/403). */
  | 'REMOTE_SIGNER_UNAUTHORIZED'
  /** A non-success HTTP status without a JSON-RPC error body. */
  | 'REMOTE_SIGNER_HTTP_ERROR'
  /** The response is not a well-formed JSON-RPC answer of the expected shape. */
  | 'REMOTE_SIGNER_BAD_RESPONSE'
  /** The signer returned a JSON-RPC error, for example a policy refusal. */
  | 'REMOTE_SIGNER_REJECTED'
  /** The signer does not implement the requested JSON-RPC method. */
  | 'REMOTE_SIGNER_METHOD_NOT_SUPPORTED'
  /** A required account is not served by the signer. */
  | 'REMOTE_SIGNER_ADDRESS_NOT_AVAILABLE'
  /** A returned signature does not recover to the expected address, or is not canonical. */
  | 'REMOTE_SIGNER_INVALID_SIGNATURE'
  /** A returned signed transaction differs from the transaction that was requested. */
  | 'REMOTE_SIGNER_TRANSACTION_MISMATCH'
  /** The transaction handed to the signer is not fully populated or not supported. */
  | 'REMOTE_SIGNER_TRANSACTION_NOT_SIGNABLE'
  /** An external signer failed to sign in a way it did not classify; its own error is the cause. */
  | 'REMOTE_SIGNER_FAILED';

export class RemoteSignerError extends Error {
  readonly code: RemoteSignerErrorCode;
  /** Host-only description of the signer endpoint (never a path, query or credential). */
  readonly endpoint?: string;
  /** JSON-RPC method that failed, when one was in flight. */
  readonly method?: string;
  /** JSON-RPC error code returned by the signer. */
  readonly rpcCode?: number;
  /** HTTP status returned by the signer. */
  readonly httpStatus?: number;

  constructor(
    code: RemoteSignerErrorCode,
    message: string,
    details: {
      endpoint?: string;
      method?: string;
      rpcCode?: number;
      httpStatus?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'RemoteSignerError';
    this.code = code;
    if (details.endpoint !== undefined) this.endpoint = details.endpoint;
    if (details.method !== undefined) this.method = details.method;
    if (details.rpcCode !== undefined) this.rpcCode = details.rpcCode;
    if (details.httpStatus !== undefined) this.httpStatus = details.httpStatus;
  }
}

/** True for a {@link RemoteSignerError}, including one rebuilt across a module boundary. */
export function isRemoteSignerError(err: unknown): err is RemoteSignerError {
  if (err instanceof RemoteSignerError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('REMOTE_SIGNER_');
}
