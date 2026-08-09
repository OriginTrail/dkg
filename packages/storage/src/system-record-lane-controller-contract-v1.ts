/**
 * The system-record lane controller-barrier CONTRACT (#2179): the barrier
 * vocabulary, the controller deps shapes, and the typed/legacy normalizer.
 * Separated from the materializer so the compatibility boundary can be read
 * without navigating lane-session mechanics; the materializer re-exports
 * everything here, so its public surface is unchanged.
 */
import type { ManagedOxigraphOwnershipLeaseV1 } from './managed-oxigraph-ownership-v1-internal.js';
import type { SystemRecordMaterializationEpochRotationV1 } from './system-record-materialization-epoch-contract-v1.js';
// Type-only, deliberately: the value-import graph stays acyclic (the
// materializer imports the normalizer VALUE from this module; this module
// imports only TYPES back).
import type {
  SystemRecordChildHandoffV1,
  SystemRecordTransactionExecutorV1,
} from './system-record-materializer-v1.js';

/**
 * Run a lifecycle transition as an exclusive section over the whole store.
 *
 * Every transition here can invalidate the client or the child, so ordinary
 * store traffic must be sealed and drained around it — otherwise a request that
 * was already in flight is cut off mid-exchange when the child is stopped, and
 * turns into a transport failure or an ambiguous write rather than
 * backpressure. The adapter backs this with the scheduler's control barrier;
 * tests supply a recording pass-through.
 *
 * The transition MUST NOT re-enter the store scheduler: it owns the store
 * exclusively for the duration, so scheduled work issued from inside it waits
 * for a barrier that cannot commit until the work drains. That is why the
 * handoff steps are limited to supervisor calls, owned-client drains and
 * synchronous cache invalidation.
 */
export type SystemRecordLaneBarrierV1 = <T>(
  purpose: string,
  transition: () => Promise<T>,
) => Promise<T>;

export interface SystemRecordLaneBarrierResultsV1 {
  readonly enable: void | SystemRecordMaterializationEpochRotationV1;
  readonly disable: void;
  readonly shutdown: void;
  readonly recovery: void;
}

export type SystemRecordLaneBarrierKindV1 = keyof SystemRecordLaneBarrierResultsV1;

/** Additive typed lifecycle path; adapters may translate kinds to scheduler keys. */
export type SystemRecordLaneTypedBarrierV1 = <K extends SystemRecordLaneBarrierKindV1>(
  kind: K,
  transition: () => Promise<SystemRecordLaneBarrierResultsV1[K]>,
) => Promise<SystemRecordLaneBarrierResultsV1[K]>;

/**
 * Dependencies shared by every controller composition route. The legacy and
 * typed entry points differ ONLY in how the barrier is supplied; everything
 * else lives here exactly once, so a future shared dependency (a tracing
 * hook, a lifecycle signal) is added in one place and reaches both routes or
 * neither.
 */
export interface SystemRecordLaneControllerSharedDepsV1 {
  /** The supervisor-issued live ownership lease. Captured, never accepted per-call. */
  readonly lease: ManagedOxigraphOwnershipLeaseV1;
  readonly handoff: SystemRecordChildHandoffV1;
  readonly executor: SystemRecordTransactionExecutorV1;
  /**
   * Adapter-owned admission latch, driven by the lifecycle's physical state.
   * `true` is published synchronously before enable can enqueue its barrier;
   * `false` is published only after disable physically commits or the lane is
   * terminally unavailable. Merely constructing the controller never calls it.
   */
  readonly setAdmissionActive?: (active: boolean) => void;
}

export interface SystemRecordLaneControllerDepsV1 extends SystemRecordLaneControllerSharedDepsV1 {
  /**
   * Required, not optional. An optional barrier is one that gets forgotten:
   * this capability shipped once with a barrier implemented, exported and
   * tested but with zero production callers, so the enable path stopped the
   * child while ordinary requests were still in flight. Required-ness is the
   * compile-time guard against that recurring, which is why retiring the
   * string contract does NOT make this member optional before the break.
   *
   * @deprecated The purpose-string contract cannot carry a sound result type:
   * coalescing is keyed by a runtime string while each caller picks a static
   * `T`, so a later same-purpose caller receives the first promise under its
   * own `T`. Supply {@link typedBarrier}; migrate string barriers to
   * `runTypedControlBarrier` with keys from `createStoreControlBarrierKeyV1`.
   * First-party composition no longer passes through this interface at all —
   * the managed coordinator calls the factory's typed overload with
   * {@link SystemRecordLaneControllerTypedDepsV1}, which has no string member
   * to fall back to. This member is removed at the next allowed breaking
   * version boundary, not before: the removal is source-incompatible for
   * external composers.
   */
  readonly barrier: SystemRecordLaneBarrierV1;
  /**
   * When supplied it is ALWAYS used and the string callback above is never
   * invoked; the fallback exists only for external composers that predate
   * typed keys.
   */
  readonly typedBarrier?: SystemRecordLaneTypedBarrierV1;
}

/**
 * Typed-only controller deps — the CANONICAL home of the #2179 rationale;
 * everywhere else carries at most a one-line pointer here.
 *
 * The purpose-string barrier contract is unsound: coalescing is keyed by a
 * runtime string while each caller picks a static result type, so a later
 * same-purpose caller receives the first promise under its own type. This
 * shape therefore has NO string `barrier` member — structurally absent, not
 * deprecated — so first-party composition cannot regress onto that contract
 * without editing this interface, and a type-contract pin fails the
 * typecheck lane if a string member is ever re-added. `typedBarrier` being
 * required is the same can't-forget guard that `barrier`'s required-ness
 * gives external composers on the legacy shape, which keeps the string
 * contract alive only until its breaking-version removal.
 */
export interface SystemRecordLaneControllerTypedDepsV1
  extends SystemRecordLaneControllerSharedDepsV1 {
  readonly typedBarrier: SystemRecordLaneTypedBarrierV1;
}

/** Typed deps pass through; legacy deps wrap `barrier`. Proven by `in`-narrowing, no cast. */
export function normalizeControllerBarrierV1(
  deps: SystemRecordLaneControllerDepsV1 | SystemRecordLaneControllerTypedDepsV1,
): SystemRecordLaneTypedBarrierV1 {
  if (!('barrier' in deps)) return deps.typedBarrier;
  return deps.typedBarrier ??
    ((kind, transition) => deps.barrier(`system-record.${kind}`, transition));
}

