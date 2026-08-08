/**
 * "May I still serve a read from cached state?" — backend-neutral.
 *
 * A decorator that answers a read from warm state never delegates downward, so
 * it never reaches whatever validity checks the backing store performs on a
 * real request. Whether that cached answer is still attributable to the store it
 * came from is a question only the backing store can answer, and it must be
 * answerable WITHOUT I/O or the cache stops being a cache.
 *
 * This interface is deliberately about cache coherence, not about any one
 * backend's ownership model. `GraphSetIndexStore` is a reusable index over any
 * store; coupling it to a managed-Oxigraph lease meant a second backend needing
 * the same guarantee would either have to grow a parallel symbol beside it or
 * pretend to be a managed Oxigraph. Both leak backend policy into a generic
 * layer.
 *
 * The managed-Oxigraph adapter implements this by consulting its ownership
 * lease — see `adapters/sparql-http.ts`. That policy stays entirely in the
 * adapter; the index only asks the neutral question.
 *
 * Stores with no cache-validity precondition simply do not implement it, and
 * `asCachedReadGateV1` resolves to `null`, which means "no store in this chain
 * constrains cached reads".
 */

import { resolveStoreChainCapabilityV1 } from './store-chain-capability.js';

/**
 * Symbol-keyed so discovery is an identity check rather than a structural match
 * on a method name — an unrelated store that happens to declare a same-named
 * method must not be mistaken for a gate that governs whether reads may be
 * served. Not exported from the package barrel.
 */
export const CACHED_READ_GATE_V1: unique symbol = Symbol('dkg.cachedReadGate.v1');

export interface CachedReadGateHostV1 {
  /**
   * Throw if cached state derived from this store may no longer be served.
   *
   * MUST NOT perform I/O: callers invoke this on the warm path, where the whole
   * point is that no request is made. `operation` is for diagnostics only.
   */
  [CACHED_READ_GATE_V1](operation: string): void;
}

/**
 * Recover the cached-read gate from anywhere in a decorator chain.
 *
 * Resolving rather than forwarding is what stops a wrapper silently erasing the
 * gate: an earlier revision called the gate on the immediate inner store with
 * optional chaining, and optional chaining treats an absent method as
 * PERMISSION — so one intervening decorator turned a fail-closed read into a
 * fail-open one.
 *
 * `null` means no store in the chain constrains cached reads, which is the
 * ordinary case for an operator-configured store.
 */
export function asCachedReadGateV1(store: unknown): CachedReadGateHostV1 | null {
  return resolveStoreChainCapabilityV1(store, isCachedReadGateHostV1);
}

function isCachedReadGateHostV1(candidate: unknown): candidate is CachedReadGateHostV1 {
  return typeof (candidate as Partial<CachedReadGateHostV1>)?.[CACHED_READ_GATE_V1] === 'function';
}
