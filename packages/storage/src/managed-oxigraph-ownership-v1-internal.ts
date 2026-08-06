/**
 * Process-local ownership lease for the daemon-managed Oxigraph child (#2052 B2).
 *
 * The system-record materializer is only safe on a store whose backing process
 * this daemon started, verified by checksum, and proved to own the listen
 * socket. Every weaker signal available today is forgeable from persisted
 * configuration:
 *
 *   - `managedByDkg` is an operator-writable boolean, and `resolveAdapterOptions`
 *     in `triple-store.ts` actively REWRITES it to `false` on the managed path;
 *   - `atomicUpdates` is SYNTHESIZED as `true` by that same function from plain
 *     config, so it proves nothing about who owns the process;
 *   - a URL proves only that something answers on a port.
 *
 * So capability is gated on a live lease that only the supervisor can mint, that
 * carries a monotonic child generation, and that goes invalid the instant the
 * child exits, revives, stops, or loses listener ownership.
 *
 * Unforgeability rests on three properties, in order of strength:
 *
 *   1. The lease handle carries NO data. Its entire meaning lives in a
 *      module-private `WeakMap` keyed by object identity, so a structurally
 *      identical object resolves to nothing.
 *   2. It is transported under a `unique symbol` key. `JSON.stringify` drops
 *      symbol keys and `JSON.parse` cannot produce one, so a persisted config
 *      can never carry a lease — while object spread (`{ ...options }`, which
 *      `resolveAdapterOptions` performs) copies own enumerable symbol keys and
 *      therefore preserves it across the factory.
 *   3. Mutation authority is a separate controller object that the supervisor
 *      keeps and never hands out. Holding a lease lets you ASK whether it is
 *      live; it does not let you say that it is.
 *
 * A shallow copy, a cast, `Object.freeze`, a structuredClone, or a hand-built
 * `{ }` all fail (1). A config file fails (2). A store or wrapper that somehow
 * obtains the lease still cannot extend or revive it, failing (3).
 */

/** Opaque, non-inspectable lease handle. Compare by identity only. */
declare const MANAGED_OXIGRAPH_LEASE_BRAND: unique symbol;
export type ManagedOxigraphOwnershipLeaseV1 = {
  readonly [MANAGED_OXIGRAPH_LEASE_BRAND]: 'managed-oxigraph-ownership-v1';
};

/**
 * Transport key for adapter options.
 *
 * Exported because the CLI supervisor must attach it and the storage adapter
 * must read it, but the VALUE it carries is still meaningless without this
 * module's private table — publishing the key does not publish the authority.
 */
export const MANAGED_OXIGRAPH_LEASE_OPTION_KEY: unique symbol = Symbol(
  'dkg.managedOxigraphOwnershipLeaseV1',
);

/** Why a lease stopped being usable. Terminal reasons never recover. */
export type ManagedOxigraphOwnershipInvalidationV1 =
  | 'child-exit'
  | 'child-revive'
  | 'stop'
  | 'listener-ownership-lost'
  | 'port-release-unproven'
  | 'shutdown';

const TERMINAL_REASONS: ReadonlySet<ManagedOxigraphOwnershipInvalidationV1> =
  new Set<ManagedOxigraphOwnershipInvalidationV1>(['shutdown', 'port-release-unproven']);

export interface ManagedOxigraphOwnershipSnapshotV1 {
  /** Canonical decimal u64, matching the system-record scalar codec. */
  readonly childGeneration: string;
  /** True only while the supervisor-owned child is the proven ready listener. */
  readonly ready: boolean;
  /** Once terminal, no generation can ever be bound again on this lease. */
  readonly terminal: boolean;
  readonly lastInvalidation?: ManagedOxigraphOwnershipInvalidationV1;
}

interface LeaseState {
  generation: bigint;
  ready: boolean;
  terminal: boolean;
  lastInvalidation?: ManagedOxigraphOwnershipInvalidationV1;
}

/**
 * The private authority table. Module-scoped and never exported, so lease
 * identity is the only key that resolves and no consumer can enumerate it.
 */
const LEASE_STATE = new WeakMap<ManagedOxigraphOwnershipLeaseV1, LeaseState>();

/**
 * Supervisor-side handle. `OxigraphServerHandle` keeps this and hands out only
 * `.lease`, which is why a store can observe ownership but never assert it.
 */
export interface ManagedOxigraphOwnershipControllerV1 {
  readonly lease: ManagedOxigraphOwnershipLeaseV1;
  /**
   * Begin a new child generation. Call AFTER the supervisor-owned process tree
   * is the proven ready listener — never at spawn time, because a spawned but
   * unproven child must not be able to satisfy a capability check.
   */
  bindReadyGeneration(): string;
  /** Drop liveness now. Recoverable unless the reason is terminal. */
  invalidate(reason: ManagedOxigraphOwnershipInvalidationV1): void;
  snapshot(): ManagedOxigraphOwnershipSnapshotV1;
}

export function createManagedOxigraphOwnershipControllerV1(): ManagedOxigraphOwnershipControllerV1 {
  // A bare object with no own properties: nothing to read, nothing to copy that
  // would carry meaning, and `JSON.stringify(lease)` is `"{}"`.
  const lease = Object.freeze(
    Object.create(null) as object,
  ) as ManagedOxigraphOwnershipLeaseV1;

  LEASE_STATE.set(lease, { generation: 0n, ready: false, terminal: false });

  const state = (): LeaseState => {
    const current = LEASE_STATE.get(lease);
    /* c8 ignore next -- the constructor above is the only writer; unreachable */
    if (!current) throw new Error('managed Oxigraph ownership lease state is missing');
    return current;
  };

  return Object.freeze({
    lease,

    bindReadyGeneration(): string {
      const current = state();
      if (current.terminal) {
        throw new Error(
          `managed Oxigraph ownership lease is terminal (${current.lastInvalidation}); ` +
            'a replacement child may not be bound',
        );
      }
      current.generation += 1n;
      current.ready = true;
      current.lastInvalidation = undefined;
      return current.generation.toString(10);
    },

    invalidate(reason: ManagedOxigraphOwnershipInvalidationV1): void {
      const current = state();
      current.ready = false;
      current.lastInvalidation = reason;
      if (TERMINAL_REASONS.has(reason)) current.terminal = true;
    },

    snapshot(): ManagedOxigraphOwnershipSnapshotV1 {
      const current = state();
      return Object.freeze({
        childGeneration: current.generation.toString(10),
        ready: current.ready,
        terminal: current.terminal,
        ...(current.lastInvalidation === undefined
          ? {}
          : { lastInvalidation: current.lastInvalidation }),
      });
    },
  });
}

/**
 * Attach a lease to an adapter-options object.
 *
 * The property is own, enumerable and symbol-keyed on purpose: object spread
 * copies it (so `resolveAdapterOptions`' `{ ...config.options, … }` rewrite does
 * not silently drop capability) while `JSON.stringify` omits it (so a lease can
 * never be persisted and replayed). Returns a new object rather than mutating
 * the caller's config.
 */
export function attachManagedOxigraphLeaseV1<T extends Record<string | symbol, unknown>>(
  options: T,
  lease: ManagedOxigraphOwnershipLeaseV1,
): T {
  return { ...options, [MANAGED_OXIGRAPH_LEASE_OPTION_KEY]: lease };
}

/**
 * Recover a lease from adapter options.
 *
 * Returns `null` — never throws — for absent, forged, copied, deserialized or
 * wrong-typed candidates, so a non-managed store simply has no capability
 * instead of failing to construct.
 */
export function extractManagedOxigraphLeaseV1(
  options: unknown,
): ManagedOxigraphOwnershipLeaseV1 | null {
  if (typeof options !== 'object' || options === null) return null;
  const candidate = (options as Record<symbol, unknown>)[MANAGED_OXIGRAPH_LEASE_OPTION_KEY];
  return isManagedOxigraphOwnershipLeaseV1(candidate) ? candidate : null;
}

/** Identity check against the private table. A look-alike object fails here. */
export function isManagedOxigraphOwnershipLeaseV1(
  candidate: unknown,
): candidate is ManagedOxigraphOwnershipLeaseV1 {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    LEASE_STATE.has(candidate as ManagedOxigraphOwnershipLeaseV1)
  );
}

/**
 * Read a lease's live state.
 *
 * `null` means "not a lease at all"; a snapshot with `ready === false` means
 * "a real lease that is not currently usable". Callers must distinguish the two:
 * the first is a permanently non-capable store, the second is a store awaiting
 * generation recovery.
 */
export function readManagedOxigraphOwnershipSnapshotV1(
  lease: unknown,
): ManagedOxigraphOwnershipSnapshotV1 | null {
  if (!isManagedOxigraphOwnershipLeaseV1(lease)) return null;
  const current = LEASE_STATE.get(lease);
  /* c8 ignore next -- guarded by isManagedOxigraphOwnershipLeaseV1 above */
  if (!current) return null;
  return Object.freeze({
    childGeneration: current.generation.toString(10),
    ready: current.ready,
    terminal: current.terminal,
    ...(current.lastInvalidation === undefined
      ? {}
      : { lastInvalidation: current.lastInvalidation }),
  });
}
