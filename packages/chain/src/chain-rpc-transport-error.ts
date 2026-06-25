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

// Chain-NAMESPACED transport codes — only the chain failover stack ever stamps
// these, so a code match alone is a reliable signal even if the error crossed a
// re-wrap boundary that preserved `.code`. `TIMEOUT` is deliberately NOT here:
// it is a generic, globally-used code, so a bare `code: 'TIMEOUT'` from an
// unrelated subsystem must NOT satisfy the guard — our OWN chain-RPC timeouts
// are `ChainRpcTransportError` instances, recognised by `instanceof` instead.
const NAMESPACED_TRANSPORT_CODES: ReadonlySet<string> = new Set<ChainRpcTransportCode>([
  'RPC_ENDPOINTS_EXHAUSTED',
  'RPC_RECEIPT_LOOKUP_FAILED',
]);

/**
 * Shape any transport-coded error presents to consumers (HTTP classifier, CLI).
 * Only `code` is guaranteed by {@link isChainRpcTransportError} (that is all the
 * guard verifies); `message`/`rpcUrls`/`txHash` are best-effort and optional, so
 * consumers must read them defensively (a real {@link ChainRpcTransportError}
 * and ethers errors always carry a string `message`, but the guard does not
 * require one — keeping the narrowing sound).
 */
export interface ChainRpcTransportErrorLike {
  code: ChainRpcTransportCode;
  message?: string;
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
 * True for a chain-RPC TRANSPORT failure, as a REAL boundary rather than a
 * global stringly-typed code convention:
 *   - any {@link ChainRpcTransportError} INSTANCE — the chain/CLI failover
 *     stack's own throws, including our wrapped RPC/receipt timeouts; OR
 *   - an error carrying a chain-NAMESPACED code (`RPC_ENDPOINTS_EXHAUSTED` /
 *     `RPC_RECEIPT_LOOKUP_FAILED`), which survives a re-wrap that preserves
 *     `.code` and is never produced outside the chain failover stack.
 * A bare `code: 'TIMEOUT'` from an unrelated subsystem does NOT satisfy this
 * (our own timeouts are instances), and on-chain reverts
 * (`CALL_EXCEPTION`/`INSUFFICIENT_FUNDS`) are never matched (the #988 contract).
 * The single predicate the HTTP classifier uses to map a transient transport
 * failure to a retryable 503/504.
 */
export function isChainRpcTransportError(err: unknown): err is ChainRpcTransportErrorLike {
  if (err instanceof ChainRpcTransportError) return true;
  return (
    !!err &&
    typeof err === 'object' &&
    typeof (err as { code?: unknown }).code === 'string' &&
    NAMESPACED_TRANSPORT_CODES.has((err as { code: string }).code)
  );
}
