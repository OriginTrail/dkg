/**
 * One implementation of the system-record lane forwarding protocol.
 *
 * Two wrappers hold cached state derived from the store and therefore have to
 * react when the lane commits: `GraphSetIndexStore` maintains a graph-set
 * index, and the agent's store forwarder drives a listContextGraphs cache. Both
 * previously carried their own copy of the same three-part protocol —
 *
 *   1. probe the inner store on EVERY call;
 *   2. memoize the wrapper, keyed on the inner controller's identity;
 *   3. wrap each session so apply outcomes reach local bookkeeping.
 *
 * — and the copies drifted, in the direction that matters. A negative result
 * was latched in three of four layers, so a single probe landing inside an
 * ordinary child revive would have disabled the lane for the rest of the
 * process; and presence was latched, so a wrapper kept advertising a lane after
 * the lease went terminal while the adapter underneath would have denied it.
 * Capability discovery is the safety gate callers consult, which makes a stale
 * "yes" the dangerous direction.
 *
 * Only the OUTCOME POLICY differs between the two, and it genuinely differs —
 * see {@link SystemRecordLaneOutcomePolicyV1}. So the protocol lives here once
 * and the policy is supplied per wrapper.
 */

import type {
  SystemRecordApplyOutcomeV1,
  SystemRecordLaneActivationV1,
  SystemRecordLaneControllerV1,
  SystemRecordLaneSessionV1,
} from './system-record-materializer-v1.js';

/**
 * What a wrapper does with an apply outcome.
 *
 * Invoked after every `applyVerified`, with the outcome about to be returned to
 * the caller. Implementations do local bookkeeping only. A bookkeeping error
 * is reported separately and cannot replace the authoritative lane outcome.
 *
 * The two production policies deliberately disagree about `root-collision`,
 * and that disagreement is correct rather than drift: it can durably quarantine
 * state, so it is not a no-op write — but it adds and removes no NAMED GRAPH,
 * so an index tracking graph membership must ignore it while a cache tracking
 * readable content must not.
 */
export interface SystemRecordLaneOutcomePolicyV1 {
  onOutcome(outcome: SystemRecordApplyOutcomeV1): void;

  /**
   * Bookkeeping threw after the lane committed.
   *
   * The outcome is returned regardless — that is settled above — but a log
   * line does not repair anything: the wrapper's cache now believes it is
   * fresh while having missed a commit. Only the wrapper knows what that
   * implies, so it is told, and should respond conservatively.
   */
  onOutcomeError?(error: unknown, outcome: SystemRecordApplyOutcomeV1): void;
}

/**
 * Forwards a lane controller from an inner store, applying `policy` to every
 * apply outcome.
 *
 * One instance per wrapper: it holds that wrapper's memo and the callback that
 * probes the inner store. Keeping the probe inside this boundary makes "probe
 * on every forward" structural instead of call-site discipline.
 */
export class SystemRecordLaneForwarderV1 {
  private memo: SystemRecordLaneControllerV1 | null | undefined;
  /** The inner controller the memo wraps, so a replacement is not masked. */
  private memoizedInner: SystemRecordLaneControllerV1 | null | undefined;

  constructor(
    private readonly probe: () => SystemRecordLaneControllerV1 | undefined,
    private readonly policy: SystemRecordLaneOutcomePolicyV1,
  ) {}

  forward(): SystemRecordLaneControllerV1 | undefined {
    const inner = this.probe();
    if (!inner) {
      // Absence is NEVER latched: the adapter reports undefined during any
      // window in which the managed child is not the proven-ready listener.
      this.memo = null;
      this.memoizedInner = null;
      return undefined;
    }
    // Keyed on identity, so a replacement controller is wrapped afresh rather
    // than masked by a facade over the old one.
    if (this.memo && this.memoizedInner === inner) return this.memo;

    this.memoizedInner = inner;
    this.memo = Object.freeze({
      open: async (activation: SystemRecordLaneActivationV1) =>
        this.wrapSession(await inner.open(activation)),
    });
    return this.memo;
  }

  private wrapSession(session: SystemRecordLaneSessionV1): SystemRecordLaneSessionV1 {
    const { policy } = this;
    return {
      get state() {
        return session.state;
      },
      get activationGeneration() {
        return session.activationGeneration;
      },
      async applyVerified(proof: unknown): Promise<SystemRecordApplyOutcomeV1> {
        const outcome = await session.applyVerified(proof);
        try {
          policy.onOutcome(outcome);
        } catch (error) {
          // The lane may already have committed. Turning bookkeeping failure
          // into an apply rejection would hide that outcome and invite retries.
          try {
            console.error(
              '[SystemRecordLaneForwarderV1] outcome policy failed after lane apply:',
              error,
            );
          } catch {
            // Diagnostics are also best-effort after the authoritative result.
          }
          // Beyond diagnostics: let the wrapper self-heal. Without this the
          // cache keeps serving as if it recorded the apply.
          try {
            policy.onOutcomeError?.(error, outcome);
          } catch {
            // A failing recovery hook must not resurrect the masking bug.
          }
        }
        return outcome;
      },
      close: (mode: 'disable' | 'shutdown') => session.close(mode),
    };
  }
}
