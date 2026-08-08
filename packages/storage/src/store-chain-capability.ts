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
 * It REGISTERS, via {@link linkStoreChainV1}. The link lives in a module-private
 * `WeakMap` keyed by wrapper identity, mirroring how the ownership lease in
 * `managed-oxigraph-ownership-v1-internal.ts` keeps its authority table: the
 * registration function grants the caller nothing: it writes a link, it does not
 * read one, and nothing exported from this module can retrieve the wrapped store.
 *
 * That is the whole reason it is not a symbol-keyed getter. An earlier revision
 * used one and exported the symbol so first-party wrappers in other packages
 * could declare it — which made the getter public API and handed every consumer
 * an invariant bypass: `store[STORE_CHAIN_INNER].insert(...)` skips changelog
 * markers and graph-set index maintenance exactly as `store.innerStore.insert(...)`
 * would. Publishing a hidden handle is still publishing the handle.
 *
 * `.innerStore` remains honoured because it is a genuine pre-existing PUBLIC
 * property on `SharedMemoryLiteralBlobStore` and the agent's forwarder, and
 * removing it from the walk would silently break capability discovery for any
 * out-of-repo wrapper built on it. First-party wrappers no longer depend on it —
 * a test resolves the whole storage chain through the registry alone.
 *
 * `.inner` is NOT walked here. Reaching a TypeScript-private field made any
 * wrapper with an incidentally-named property an accidental opt-in to capability
 * discovery. It survives only in {@link resolveStoreChainCapabilityLegacyV1},
 * used by the single capability whose checked-in contract asserts it.
 */

/** wrapper -> wrapped store. Module-private: registration is write-only to callers. */
const CHAIN_LINKS = new WeakMap<object, unknown>();

/**
 * Declare that capability discovery may pass through `wrapper` to `inner`.
 *
 * Call once, from a decorator's constructor. Grants the caller no ability to
 * read any wrapped store, including its own — this is the whole point.
 */
export function linkStoreChainV1(wrapper: object, inner: unknown): void {
  CHAIN_LINKS.set(wrapper, inner);
}

export interface StoreChainNodeV1 {
  /** Pre-existing public convention. Prefer {@link linkStoreChainV1}. */
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

/** Adds the TS-private `.inner` reach. Quarantined — see the module doc. */
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
 * Walk `store` and its inner stores, returning the first node for which
 * `isCapable` holds, or `null` when the chain ends without one.
 *
 * `isCapable` is a TYPE PREDICATE, not a boolean: the helper returns the node
 * as-is with no cast, so the narrowing a caller gets is exactly the one its own
 * guard proved.
 *
 * `null` means ONE thing: the chain ended and no node had the capability. It
 * does not also mean "traversal gave up". An earlier draft used a depth cap of
 * 8, which silently returned `null` for a legitimately deeper chain — and for
 * the managed read gate that reads as "unleased store", i.e. fail-OPEN, which is
 * the exact failure this change exists to prevent. Termination is by object
 * identity, so depth is unbounded and the only non-terminating shape — a genuine
 * cycle — THROWS rather than being reported as absence.
 */
export function resolveStoreChainCapabilityV1<T>(
  store: unknown,
  isCapable: (candidate: unknown) => candidate is T,
): T | null {
  return walk(store, isCapable, registeredOrPublic);
}

/**
 * As {@link resolveStoreChainCapabilityV1}, but also follows a TS-private
 * `.inner`.
 *
 * COMPATIBILITY ONLY, for `asGraphWriteGenSource`, whose checked-in contract
 * asserts `asGraphWriteGenSource({ innerStore: { inner: store } })` resolves
 * (`graph-write-gen.test.ts`). Removing that reach once already regressed it
 * silently: its callers fail open on `null` and fall back to expensive full
 * scans, so nothing announces the loss.
 *
 * Do not use for new capabilities. Register with {@link linkStoreChainV1}.
 */
export function resolveStoreChainCapabilityLegacyV1<T>(
  store: unknown,
  isCapable: (candidate: unknown) => candidate is T,
): T | null {
  return walk(store, isCapable, registeredOrPublicOrLegacyInner);
}
