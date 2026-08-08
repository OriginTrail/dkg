/**
 * One canonical walk over a `TripleStore` decorator chain.
 *
 * Three capabilities need to find the store that actually implements them —
 * the changelog reader, the write-generation source, and the managed read gate
 * — and each had grown its own copy of the traversal. The copies had already
 * DIVERGED: `asChangelogReader` followed only `.innerStore`, while the other
 * two also followed `.inner`. A capability that could not be found through a
 * given wrapper simply resolved to `null`, which every caller treats as "this
 * store does not have it" — so a traversal gap is silent by construction.
 *
 * Consolidating means wrapper shape, the legacy field fallback and the cycle
 * bound are decided once, and a new capability inherits all of it.
 *
 * ## The convention
 *
 * A decorator exposes its inner store as a PUBLIC `readonly innerStore`. That
 * is the contract; every decorator in this package and the agent's hand-rolled
 * forwarder now satisfy it.
 *
 * `.inner` remains a fallback only because it is what two of these walkers
 * already relied on, and dropping it would silently narrow discovery for any
 * wrapper outside this repo that copied the older shape. It reaches a
 * TypeScript-private field — legal at runtime, but not something new code
 * should depend on. Prefer `innerStore`.
 */

/** Bound against a pathological or cyclic chain. */
const MAX_STORE_CHAIN_DEPTH = 8;

interface StoreChainNode {
  readonly innerStore?: unknown;
  readonly inner?: unknown;
}

/**
 * Walk `store` and its inner stores, returning the first node satisfying
 * `isCapable`, or `null` when the chain ends without one.
 *
 * `null` means "no store in this chain has the capability". Callers must decide
 * what that implies: for the managed read gate it means there is no managed
 * backend and reads are unrestricted; for the write-gen source it means callers
 * must fail open and always scan.
 */
export function resolveStoreChainCapabilityV1<T>(
  store: unknown,
  isCapable: (candidate: object) => boolean,
): T | null {
  let node = store as StoreChainNode | null | undefined;
  for (let depth = 0; node && depth < MAX_STORE_CHAIN_DEPTH; depth++) {
    if (typeof node === 'object' && isCapable(node)) return node as T;
    node = (node.innerStore ?? node.inner) as StoreChainNode | null | undefined;
  }
  return null;
}
