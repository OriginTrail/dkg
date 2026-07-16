// SPDX-License-Identifier: Apache-2.0

/**
 * Typed boundary for the TRANSPORT-level chain-RPC failures that the adapter,
 * the CLI failover stack, and the daemon's HTTP classifier all key on.
 *
 * Previously these were bare `new Error(...)` objects with ad-hoc
 * `(err as any).code = 'RPC_ENDPOINTS_EXHAUSTED'` casts and `rpcUrls`/`txHash`
 * fields scattered across packages — an implicit, stringly-typed cross-package
 * contract. This gives it one name, one factory, and ONE structural type guard
 * over a single set of chain-NAMESPACED codes:
 *   - `RPC_ENDPOINTS_EXHAUSTED`   — every configured RPC failed over (writes)
 *   - `RPC_RECEIPT_LOOKUP_FAILED` — receipt lookup failed on every endpoint
 *   - `RPC_TIMEOUT`               — receipt wait / bounded RPC request timed out
 *
 * All three are chain-OWNED, namespaced codes — only the chain/CLI failover
 * stack ever stamps them — so the guard is ONE simple structural check (`code`),
 * with no `instanceof`/prototype coupling and identical behaviour for every
 * transport case (each survives a plain-object re-wrap that preserves `.code`).
 * In particular the timeout case uses the internal `RPC_TIMEOUT` (NOT the
 * generic, globally-used `TIMEOUT`) so a bare `code: 'TIMEOUT'` stamped by ethers
 * or any unrelated subsystem does NOT satisfy this boundary; the daemon's HTTP
 * layer maps `RPC_TIMEOUT` back to the public/legacy `code: 'TIMEOUT'` 504 body.
 * On-chain reverts (`CALL_EXCEPTION`/`INSUFFICIENT_FUNDS`) never match (#988).
 */

// SINGLE SOURCE OF TRUTH for the chain-NAMESPACED transport codes. The union
// type AND the guard's Set both derive from this tuple, so a code can never be
// added/removed in one place and missed in the other.
export const CHAIN_RPC_TRANSPORT_CODES = [
  'RPC_ENDPOINTS_EXHAUSTED',
  'RPC_RECEIPT_LOOKUP_FAILED',
  'RPC_TIMEOUT',
] as const;

export type ChainRpcTransportCode = (typeof CHAIN_RPC_TRANSPORT_CODES)[number];

const TRANSPORT_CODES: ReadonlySet<string> = new Set(CHAIN_RPC_TRANSPORT_CODES);

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
  rpcUrls?: readonly string[];
  txHash?: string;
}

export class ChainRpcTransportError extends Error {
  readonly code: ChainRpcTransportCode;

  /** Configured endpoints involved. HOST-ONLY callers must reduce before logging/echoing.
   *  Exposed as a `readonly` array AND frozen on capture, so a consumer can neither
   *  reassign nor mutate (`err.rpcUrls.push(...)`) this cross-package boundary's context. */
  readonly rpcUrls?: readonly string[];

  readonly txHash?: string;
  constructor(
    code: ChainRpcTransportCode,
    message: string,
    opts?: { cause?: unknown; rpcUrls?: readonly string[]; txHash?: string },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ChainRpcTransportError';
    this.code = code;
    if (opts?.rpcUrls) this.rpcUrls = Object.freeze([...opts.rpcUrls]);
    if (opts?.txHash) this.txHash = opts.txHash;
  }
}

/**
 * Shared factory for the chain-RPC TIMEOUT transport error, so the chain-side
 * `withTimeout`, the receipt-wait deadline, and the CLI `cliWithTimeout` all emit
 * the SAME `RPC_TIMEOUT` (never the generic `TIMEOUT`) from ONE place — the
 * namespaced-code invariant is not duplicated across emitters.
 */
export function createRpcTimeoutError(
  message: string,
  opts?: { cause?: unknown; txHash?: string },
): ChainRpcTransportError {
  return new ChainRpcTransportError('RPC_TIMEOUT', message, opts);
}

/**
 * True for a chain-RPC TRANSPORT failure — ONE simple structural check over the
 * chain-NAMESPACED codes (`RPC_ENDPOINTS_EXHAUSTED` / `RPC_RECEIPT_LOOKUP_FAILED`
 * / `RPC_TIMEOUT`). Every {@link ChainRpcTransportError} carries one of these, so
 * instances match too, and the same check survives a re-wrap that preserves
 * `.code`. A bare generic `code: 'TIMEOUT'` from an unrelated subsystem does NOT
 * match (the chain timeout code is the namespaced `RPC_TIMEOUT`), and on-chain
 * reverts (`CALL_EXCEPTION`/`INSUFFICIENT_FUNDS`) never match (the #988 contract).
 * The single predicate the HTTP classifier uses to map a transient transport
 * failure to a retryable 503/504.
 */
export function isChainRpcTransportError(err: unknown): err is ChainRpcTransportErrorLike {
  return (
    !!err &&
    typeof err === 'object' &&
    typeof (err as { code?: unknown }).code === 'string' &&
    TRANSPORT_CODES.has((err as { code: string }).code)
  );
}
