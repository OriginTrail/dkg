/**
 * One canonical walk over a `TripleStore` decorator chain.
 *
 * Three capabilities need to find the store that actually implements them —
 * the changelog reader, the write-generation source, and the managed read gate
 * — and each had grown its own copy of the traversal. The copies had already
 * DIVERGED: `asChangelogReader` followed only `.innerStore`, while the other
 * two also followed `.inner`. A capability that cannot be found through a given
 * wrapper resolves to `null`, and every caller reads `null` as "this store does
 * not have it" — so a traversal gap is silent by construction.
 *
 * ## How a decorator becomes traversable
 *
 * In preference order:
 *
 * 1. `[STORE_CHAIN_INNER]` — the intentional mechanism. A symbol-keyed getter,
 *    so a decorator declares "capability discovery may pass through me" WITHOUT
 *    publishing its wrapped store. That distinction is the point: a public
 *    `innerStore` on an index or changelog decorator is an architectural escape
 *    hatch, because `store.innerStore.insert(...)` bypasses the very index
 *    maintenance and change-marker recording the wrapper exists to enforce.
 *    The symbol is not exported from the package barrel.
 *
 * 2. `.innerStore` — the pre-existing public convention, honoured because
 *    wrappers already rely on it: `SharedMemoryLiteralBlobStore` and the
 *    agent's hand-rolled forwarder both expose it, and `asChangelogReader` has
 *    always walked it.
 *
 * 3. `.inner` — LEGACY COMPATIBILITY, not a convention to build on. It reaches
 *    a TypeScript-private field at runtime. An earlier revision of this module
 *    dropped it as unnecessary; that was wrong, and the test that proved it
 *    wrong (`graph-write-gen.test.ts`, `asGraphWriteGenSource({ innerStore: {
 *    inner: store } })`) was not in the workflow lane used to check the change.
 *    `asGraphWriteGenSource` has followed `.inner` since it was written, and
 *    removing it silently returns `null`, which its callers treat as "no
 *    write-generation support" and fall back to expensive full scans. New code
 *    should use the symbol.
 */

/**
 * Symbol-keyed accessor for the wrapped store.
 *
 * Deliberately not on `TripleStore` and not exported from the barrel: this is
 * how a decorator opts into traversal without widening its public surface.
 */
export const STORE_CHAIN_INNER: unique symbol = Symbol('dkg.storeChainInner.v1');

export interface StoreChainNodeV1 {
  readonly [STORE_CHAIN_INNER]?: unknown;
  readonly innerStore?: unknown;
  /** @deprecated Legacy shape; declare {@link STORE_CHAIN_INNER} instead. */
  readonly inner?: unknown;
}

/** A store chain that loops — a broken object graph, never a normal absence. */
export class StoreChainCycleError extends Error {
  readonly code = 'STORE_CHAIN_CYCLE' as const;

  constructor() {
    super('TripleStore decorator chain contains a cycle; capability discovery cannot complete');
    this.name = 'StoreChainCycleError';
  }
}

const nextInChain = (node: StoreChainNodeV1): unknown =>
  node[STORE_CHAIN_INNER] ?? node.innerStore ?? node.inner;

/**
 * Walk `store` and its inner stores, returning the first node for which
 * `isCapable` holds, or `null` when the chain ends without one.
 *
 * `isCapable` is a TYPE PREDICATE, not a boolean: the helper returns the node
 * as-is with no cast, so the narrowing a caller gets is exactly the one its own
 * guard proved. An earlier draft took `(candidate: object) => boolean` and cast
 * to a caller-chosen `T`, which let a partial check mint a fully typed
 * capability.
 *
 * `null` means ONE thing: the chain ended and no node had the capability. It
 * does not also mean "traversal gave up". An earlier draft used a depth cap of
 * 8, which silently returned `null` for a legitimately deeper chain — and for
 * the managed read gate that reads as "unleased store", i.e. fail-OPEN, which
 * is the exact failure this whole change exists to prevent. Termination is now
 * by object identity, so depth is unbounded and the only non-terminating shape
 * — a genuine cycle — THROWS rather than being reported as absence.
 */
export function resolveStoreChainCapabilityV1<T>(
  store: unknown,
  isCapable: (candidate: unknown) => candidate is T,
): T | null {
  const seen = new Set<unknown>();
  let node = store as StoreChainNodeV1 | null | undefined;
  while (node !== null && node !== undefined) {
    if (isCapable(node)) return node;
    if (seen.has(node)) throw new StoreChainCycleError();
    seen.add(node);
    node = nextInChain(node) as StoreChainNodeV1 | null | undefined;
  }
  return null;
}
