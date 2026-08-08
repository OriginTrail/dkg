/**
 * One canonical walk over a `TripleStore` decorator chain.
 *
 * Three capabilities need to find the store that actually implements them —
 * the changelog reader, the write-generation source, and the managed read gate
 * — and each had grown its own copy of the traversal. The copies had already
 * DIVERGED: `asChangelogReader` followed only `.innerStore`, while the other
 * two also followed a TypeScript-private `.inner`. A capability that cannot be
 * found through a given wrapper simply resolves to `null`, and every caller
 * reads `null` as "this store does not have it" — so a traversal gap is silent
 * by construction.
 *
 * ## The contract
 *
 * A decorator exposes its inner store as a PUBLIC `readonly innerStore`. That
 * is the whole contract, and every decorator in this package plus the agent's
 * hand-rolled forwarder satisfies it.
 *
 * The `.inner` fallback the two older walkers carried is deliberately NOT here.
 * It only ever worked by reaching a TypeScript-private field at runtime, it was
 * never a documented convention, and it made any object with an incidental
 * `inner` property part of capability discovery. It is also now unnecessary:
 * `GraphSetIndexStore` and `ChangelogStore` expose `innerStore`, which is
 * exactly the set of wrappers `.inner` existed to cross. Verified rather than
 * assumed — the full storage lane passes with `innerStore` alone.
 */

/** Bound against a pathological or cyclic chain. */
const MAX_STORE_CHAIN_DEPTH = 8;

/** The one field a decorator must expose to be transparent to capability discovery. */
export interface StoreChainNodeV1 {
  readonly innerStore?: unknown;
}

/**
 * Walk `store` and its inner stores, returning the first node for which
 * `isCapable` holds, or `null` when the chain ends without one.
 *
 * `isCapable` is a TYPE PREDICATE, not a boolean: the helper returns the node
 * as-is with no cast, so the narrowing a caller gets is exactly the one its own
 * guard proved. An earlier draft took `(candidate: object) => boolean` and cast
 * the result to a caller-chosen `T`, which let a partial check mint a fully
 * typed capability — the wrong shape for a primitive whose entire purpose is
 * making decorator-chain capabilities safer.
 *
 * `null` means "no store in this chain has the capability", and callers must
 * decide what that implies: for the managed read gate it means there is no
 * managed backend, so reads are unrestricted; for the write-gen source it means
 * callers must fail open and always scan.
 */
export function resolveStoreChainCapabilityV1<T>(
  store: unknown,
  isCapable: (candidate: unknown) => candidate is T,
): T | null {
  let node = store as StoreChainNodeV1 | null | undefined;
  for (let depth = 0; node && depth < MAX_STORE_CHAIN_DEPTH; depth++) {
    if (isCapable(node)) return node;
    node = node.innerStore as StoreChainNodeV1 | null | undefined;
  }
  return null;
}
