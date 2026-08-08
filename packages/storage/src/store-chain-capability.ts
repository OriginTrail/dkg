/**
 * One walk over a `TripleStore` decorator chain, shared by every capability
 * that must find the store actually implementing it.
 *
 * ## Traversal
 *
 * From the outermost store inward, taking the first node that satisfies the
 * caller's guard. A node's inner store is found by, in order:
 *
 * 1. a link recorded via {@link linkStoreChainV1} — how this package's own
 *    decorators opt in, without exposing the store they wrap;
 * 2. a public `innerStore` property — the convention wrappers outside this
 *    package use;
 * 3. a `inner` property — {@link resolveStoreChainCapabilityLegacyV1} only.
 *
 * ## What the result means
 *
 * `null` means the chain ended with no node holding the capability. It never
 * means traversal gave up: there is no depth limit, and the one shape that
 * cannot terminate — a cycle — throws {@link StoreChainCycleError}.
 *
 * That distinction is load-bearing. Callers treat `null` as "no such
 * capability", and for a safety capability such as the cached-read gate that
 * reads as "unconstrained" — so a traversal failure reported as `null` would
 * fail OPEN.
 *
 * ## Adding a capability
 *
 * Use {@link resolveStoreChainCapabilityV1} with a type predicate. Prefer a
 * symbol-keyed member so discovery is an identity check rather than a
 * structural match on a method name.
 */

/** wrapper -> wrapped store. Module-private, so registration cannot be read back. */
const CHAIN_LINKS = new WeakMap<object, unknown>();

/**
 * Record that capability discovery may pass through `wrapper` to `inner`.
 *
 * Call once from a decorator's constructor. Deliberately write-only: it exposes
 * no way to read a wrapped store, so it cannot become a route around the
 * decorator's own invariants the way a public `innerStore` can.
 */
export function linkStoreChainV1(wrapper: object, inner: unknown): void {
  CHAIN_LINKS.set(wrapper, inner);
}

export interface StoreChainNodeV1 {
  /** Public convention for wrappers outside this package. */
  readonly innerStore?: unknown;
}

/** A store chain that loops — a broken object graph, never a normal absence. */
export class StoreChainCycleError extends Error {
  readonly code = 'STORE_CHAIN_CYCLE' as const;

  constructor() {
    super('TripleStore decorator chain contains a cycle; capability discovery cannot complete');
    this.name = 'StoreChainCycleError';
  }
}

type NextInChain = (node: object) => unknown;

const registeredOrPublic: NextInChain = (node) =>
  CHAIN_LINKS.get(node) ?? (node as StoreChainNodeV1).innerStore;

const registeredOrPublicOrLegacyInner: NextInChain = (node) =>
  registeredOrPublic(node) ?? (node as { inner?: unknown }).inner;

function walk<T>(
  store: unknown,
  isCapable: (candidate: unknown) => candidate is T,
  next: NextInChain,
): T | null {
  const seen = new Set<unknown>();
  let node = store as object | null | undefined;
  while (node !== null && node !== undefined) {
    if (isCapable(node)) return node;
    if (seen.has(node)) throw new StoreChainCycleError();
    seen.add(node);
    node = next(node) as object | null | undefined;
  }
  return null;
}

/**
 * Find the first store in `store`'s chain satisfying `isCapable`, or `null`.
 *
 * `isCapable` is a type predicate and the node is returned unchanged, so the
 * narrowing a caller gets is exactly the one its own guard proved.
 */
export function resolveStoreChainCapabilityV1<T>(
  store: unknown,
  isCapable: (candidate: unknown) => candidate is T,
): T | null {
  return walk(store, isCapable, registeredOrPublic);
}

/**
 * As {@link resolveStoreChainCapabilityV1}, but also follows a `inner` property.
 *
 * Compatibility only, for `asGraphWriteGenSource`, whose published contract
 * covers wrappers exposing `inner` alone. Not for new capabilities: reaching an
 * arbitrarily-named property makes any object with that field an accidental
 * participant in discovery.
 */
export function resolveStoreChainCapabilityLegacyV1<T>(
  store: unknown,
  isCapable: (candidate: unknown) => candidate is T,
): T | null {
  return walk(store, isCapable, registeredOrPublicOrLegacyInner);
}
