// SPDX-License-Identifier: Apache-2.0

/**
 * Typed boundary for the TRANSPORT-level chain-RPC failures that the adapter,
 * the CLI failover stack, and the daemon's HTTP classifier all key on.
 *
 * Previously these were bare `new Error(...)` objects with ad-hoc
 * `(err as any).code = 'RPC_ENDPOINTS_EXHAUSTED'` casts and `rpcUrls`/`txHash`
 * fields scattered across packages — an implicit, stringly-typed cross-package
 * contract. This gives it one name, one factory, and one type guard:
 *   - `RPC_ENDPOINTS_EXHAUSTED`   — every configured RPC failed over (writes)
 *   - `RPC_RECEIPT_LOOKUP_FAILED` — receipt lookup failed on every endpoint
 *   - `TIMEOUT`                   — receipt wait / bounded RPC request timed out
 *
 * The guard is CODE-based (not `instanceof`) on purpose: a `TIMEOUT` can also be
 * stamped by ethers' own request timeout, and the CLI stack throws its own
 * instances — all must be recognised by the daemon's 503/504 mapping.
 */

export type ChainRpcTransportCode =
  | 'RPC_ENDPOINTS_EXHAUSTED'
  | 'RPC_RECEIPT_LOOKUP_FAILED'
  | 'TIMEOUT';

const TRANSPORT_CODES: ReadonlySet<string> = new Set<ChainRpcTransportCode>([
  'RPC_ENDPOINTS_EXHAUSTED',
  'RPC_RECEIPT_LOOKUP_FAILED',
  'TIMEOUT',
]);

/** Shape any transport-coded error presents to consumers (HTTP classifier, CLI). */
export interface ChainRpcTransportErrorLike {
  code: ChainRpcTransportCode;
  message: string;
  rpcUrls?: string[];
  txHash?: string;
}

export class ChainRpcTransportError extends Error {
  readonly code: ChainRpcTransportCode;

  /** Configured endpoints involved. HOST-ONLY callers must reduce before logging/echoing. */
  readonly rpcUrls?: string[];

  readonly txHash?: string;

  constructor(
    code: ChainRpcTransportCode,
    message: string,
    opts?: { cause?: unknown; rpcUrls?: readonly string[]; txHash?: string },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ChainRpcTransportError';
    this.code = code;
    if (opts?.rpcUrls) this.rpcUrls = [...opts.rpcUrls];
    if (opts?.txHash) this.txHash = opts.txHash;
  }
}

/**
 * True for ANY error carrying one of the three transport codes — whether it is
 * a {@link ChainRpcTransportError}, an ethers-stamped `TIMEOUT`, or the CLI
 * stack's own throw. This is the single predicate the HTTP classifier and the
 * CLI use to decide "transient transport failure → retryable".
 */
export function isChainRpcTransportError(err: unknown): err is ChainRpcTransportErrorLike {
  return (
    !!err &&
    typeof err === 'object' &&
    typeof (err as { code?: unknown }).code === 'string' &&
    TRANSPORT_CODES.has((err as { code: string }).code)
  );
}
