import {
  readManagedOxigraphOwnershipSnapshotV1,
  type ManagedOxigraphOwnershipLeaseV1,
} from './managed-oxigraph-ownership-v1-internal.js';

/**
 * System-record V1 lane controller (#2052 Stack B2).
 *
 * This module owns the LIFECYCLE and the POLICY of the materialization lane.
 * It deliberately owns no bytes: the actual store transaction is performed by
 * an injected {@link SystemRecordTransactionExecutorV1}, which the mandatory
 * `sparql-http` adapter supplies. That split is what lets the plan's logical
 * fault matrix run as a pure reference model — a test executor can fail at any
 * transition boundary without a live child process — while keeping exactly one
 * implementation of the state machine.
 *
 * Default-unused: nothing constructs a controller unless the daemon supervisor
 * hands over a live ownership lease, and merely obtaining a controller performs
 * zero store, epoch, queue, permit or scheduler work.
 */

/* ------------------------------------------------------------------ *
 * Public contract
 * ------------------------------------------------------------------ */

/**
 * Activation descriptor. Carries no authority of its own: it names WHICH
 * `(network, kind)` set to enable, while the right to enable anything at all
 * comes from the ownership lease captured at controller construction.
 */
export interface SystemRecordLaneActivationV1 {
  readonly networkId: string;
  /** V1 accepts only the fixed `agents` kind; `ontology` is Stack E. */
  readonly kinds: readonly ['agents'];
  /**
   * Pre-activation shadow mode keeps the legacy lane authoritative: V1 rows are
   * materialized and charged, but legacy RDF is never deleted.
   */
  readonly mode: 'shadow' | 'authoritative';
}

export type SystemRecordApplyOutcomeV1 =
  | { readonly outcome: 'applied'; readonly stateRevision: string; readonly appliedStateDigest: string }
  | { readonly outcome: 'already-applied'; readonly stateRevision: string; readonly appliedStateDigest: string }
  | { readonly outcome: 'stale' }
  | { readonly outcome: 'root-collision' }
  | { readonly outcome: 'capacity-exhausted' }
  | { readonly outcome: 'deferred'; readonly reason: SystemRecordDeferralReasonV1 }
  | { readonly outcome: 'indeterminate'; readonly recoveryGeneration: string }
  | { readonly outcome: 'capability-lost' };

export type SystemRecordDeferralReasonV1 =
  | 'inspection-timeout'
  | 'inspection-overflow'
  | 'validation-mismatch'
  | 'state-changed'
  | 'generation-changed'
  | 'aborted'
  | 'insufficient-apply-budget';

/**
 * Session lifecycle states.
 *
 * `unavailable` and `shutdown` are terminal: once physical settlement cannot be
 * proven, or the process is tearing down, the lane never reopens in this
 * process. That is deliberate — a lane that could quietly re-enable after an
 * unproven settlement would be exactly the stale-generation write the whole
 * design exists to make impossible.
 */
export type SystemRecordLaneStateV1 =
  | 'disabled'
  | 'enabling'
  | 'enabled'
  | 'reconciling'
  | 'disabling'
  | 'shutdown'
  | 'unavailable';

export interface SystemRecordLaneSessionV1 {
  readonly state: SystemRecordLaneStateV1;
  /** Activation generation. Increments on every successful enable. */
  readonly activationGeneration: string;
  applyVerified(proof: unknown): Promise<SystemRecordApplyOutcomeV1>;
  close(mode: 'disable' | 'shutdown'): Promise<void>;
}

export interface SystemRecordLaneControllerV1 {
  open(activation: SystemRecordLaneActivationV1): Promise<SystemRecordLaneSessionV1>;
}

/* ------------------------------------------------------------------ *
 * Injected boundaries
 * ------------------------------------------------------------------ */

/**
 * Everything the lane needs from the supervisor to make a clean generation
 * handoff. Each step must be individually provable, because the enable path
 * asserts a physical fact ("the previous child cannot write again"), not a
 * logical one ("we asked it to stop").
 */
export interface SystemRecordChildHandoffV1 {
  /** Destroy the generation-specific HTTP client and its owned sockets. */
  destroyClient(): Promise<void>;
  /** Stop the owned child and PROVE exit plus port release. Reject if unproven. */
  stopAndProveOwnedChildDead(): Promise<void>;
  /** Await every promise and permit issued against the retired generation. */
  awaitRetiredWork(): Promise<void>;
  /** Start a replacement child and prove it is the ready listener. */
  startAndProveCleanGeneration(): Promise<void>;
  /** Rotate the materialization epoch under exclusive control. */
  rotateMaterializationEpoch(): Promise<void>;
}

export interface SystemRecordTransactionExecutorV1 {
  applyVerified(proof: unknown, childGeneration: string): Promise<SystemRecordApplyOutcomeV1>;
}

export interface SystemRecordLaneControllerDepsV1 {
  /** The supervisor-issued live ownership lease. Captured, never accepted per-call. */
  readonly lease: ManagedOxigraphOwnershipLeaseV1;
  readonly handoff: SystemRecordChildHandoffV1;
  readonly executor: SystemRecordTransactionExecutorV1;
}

/** Raised when an incompatible activation descriptor is offered to a live session. */
export class SystemRecordLaneActivationConflictError extends Error {
  readonly code = 'SYSTEM_RECORD_ACTIVATION_CONFLICT' as const;

  constructor(readonly existing: string, readonly requested: string) {
    super(
      `system-record lane is already open for ${existing}; ` +
        `reopening as ${requested} requires an explicit disable first`,
    );
    this.name = 'SystemRecordLaneActivationConflictError';
  }
}

/** Raised when a second owned-store controller is registered in one process. */
export class SystemRecordControllerRegistrationError extends Error {
  readonly code = 'SYSTEM_RECORD_DUPLICATE_CONTROLLER' as const;

  constructor() {
    super(
      'a daemon-managed system-record lane controller is already registered in this process; ' +
        'a second registration is refused before capability exposure',
    );
    this.name = 'SystemRecordControllerRegistrationError';
  }
}

const descriptorOf = (activation: SystemRecordLaneActivationV1): string =>
  `${activation.networkId}|${[...activation.kinds].sort().join(',')}|${activation.mode}`;

/**
 * Process-global single-registration invariant.
 *
 * Two managed controllers in one process would mean two supervisors each
 * believing they own "the" daemon-managed child. There is exactly one such
 * child by construction, so the second controller is necessarily wrong about
 * what it owns — and its recovery could stop a child the first one is mid-write
 * against. Refusing the second registration before any capability is exposed
 * makes that state unreachable rather than merely unlikely.
 *
 * Note this is NOT justified by the scheduler lacking store identity. Since
 * #2052 B2 the scheduler carries an opaque `storeId` and scopes control
 * barriers per `(storeId, purpose)`, so it would in fact tell two managed
 * stores apart. The invariant is enforced here rather than there deliberately:
 * "who owns the managed store" needs one source of truth, and duplicating it
 * into the scheduler would create a second one to drift out of sync.
 */
let registeredController: SystemRecordLaneControllerV1 | null = null;

/** Test-only reset. Never called from production code. */
export function __resetSystemRecordControllerRegistrationForTests(): void {
  registeredController = null;
}

export function createSystemRecordLaneControllerV1(
  deps: SystemRecordLaneControllerDepsV1,
): SystemRecordLaneControllerV1 {
  if (registeredController) throw new SystemRecordControllerRegistrationError();

  const session = new SystemRecordLaneSession(deps);
  const controller: SystemRecordLaneControllerV1 = Object.freeze({
    open: (activation: SystemRecordLaneActivationV1) => session.open(activation),
  });
  registeredController = controller;
  return controller;
}

/* ------------------------------------------------------------------ *
 * The one aggregate session
 * ------------------------------------------------------------------ */

class SystemRecordLaneSession implements SystemRecordLaneSessionV1 {
  private current: SystemRecordLaneStateV1 = 'disabled';
  private activation = 0n;
  private descriptor: string | null = null;
  /** In-flight transition, so same-intent callers coalesce instead of racing. */
  private transition: { kind: 'open' | 'disable' | 'shutdown'; descriptor: string | null; work: Promise<void> } | null =
    null;

  constructor(private readonly deps: SystemRecordLaneControllerDepsV1) {}

  get state(): SystemRecordLaneStateV1 {
    return this.current;
  }

  get activationGeneration(): string {
    return this.activation.toString(10);
  }

  /* -------------------------------------------------------------- */

  async open(activation: SystemRecordLaneActivationV1): Promise<SystemRecordLaneSessionV1> {
    const wanted = descriptorOf(activation);

    if (this.current === 'shutdown' || this.current === 'unavailable') {
      // Terminal states never reopen: admission stays sealed.
      throw new Error(`system-record lane is terminal (${this.current}) and cannot be reopened`);
    }

    // Same-descriptor concurrent opens coalesce; a different descriptor is a
    // caller error rather than an implicit reconfiguration, because switching
    // the enabled set silently would strand rows charged under the old one.
    if (this.transition) {
      if (this.transition.kind === 'open' && this.transition.descriptor === wanted) {
        await this.transition.work;
        return this;
      }
      if (this.transition.kind !== 'open') {
        // Disable and shutdown both outrank open.
        await this.transition.work;
      } else {
        throw new SystemRecordLaneActivationConflictError(
          this.transition.descriptor ?? 'unknown',
          wanted,
        );
      }
    }

    if (this.current === 'enabled') {
      if (this.descriptor === wanted) return this;
      throw new SystemRecordLaneActivationConflictError(this.descriptor ?? 'unknown', wanted);
    }

    const work = this.runEnable(wanted);
    this.transition = { kind: 'open', descriptor: wanted, work };
    try {
      await work;
    } finally {
      this.transition = null;
    }
    return this;
  }

  /**
   * `disabled -> enabling -> enabled`.
   *
   * The handoff order is load-bearing and is asserted step by step: destroy the
   * old client, prove the owned child and its port dead, drain retired work,
   * and only THEN start a clean generation and rotate the epoch. Doing any of
   * these out of order would leave a window in which a request issued against
   * the retired generation could still reach a replacement listener.
   *
   * Any failure is terminal `unavailable` rather than a retry: if we cannot
   * prove the old writer is gone, no amount of retrying makes it so, and
   * falling back to the legacy lane while that uncertainty stands is exactly
   * the bypass the design forbids.
   */
  private async runEnable(descriptor: string): Promise<void> {
    this.assertLeaseLive();
    this.current = 'enabling';
    try {
      await this.deps.handoff.destroyClient();
      await this.deps.handoff.stopAndProveOwnedChildDead();
      await this.deps.handoff.awaitRetiredWork();
      await this.deps.handoff.startAndProveCleanGeneration();
      await this.deps.handoff.rotateMaterializationEpoch();
    } catch (error) {
      this.current = 'unavailable';
      this.descriptor = null;
      throw error;
    }
    this.activation += 1n;
    this.descriptor = descriptor;
    this.current = 'enabled';
  }

  /* -------------------------------------------------------------- */

  async close(mode: 'disable' | 'shutdown'): Promise<void> {
    if (mode === 'shutdown') return this.runShutdown();

    if (this.current === 'shutdown') return; // shutdown supersedes disable
    if (this.current === 'disabled' || this.current === 'unavailable') return;

    if (this.transition) {
      if (this.transition.kind === 'disable') return this.transition.work;
      if (this.transition.kind === 'shutdown') return this.transition.work;
      // Disable outranks an in-flight open: join it, then disable the result.
      await this.transition.work.catch(() => undefined);
    }

    const work = this.runDisable();
    this.transition = { kind: 'disable', descriptor: null, work };
    try {
      await work;
    } finally {
      this.transition = null;
    }
  }

  /**
   * Disable wins over open and over V1 recovery admission, but it cannot
   * shortcut physical settlement: an uncertain old write must still be resolved
   * before legacy callers are allowed to bypass, or a retired request could
   * commit after legacy work has already read around it.
   */
  private async runDisable(): Promise<void> {
    this.current = 'disabling';
    try {
      await this.deps.handoff.awaitRetiredWork();
      await this.deps.handoff.rotateMaterializationEpoch();
    } catch (error) {
      this.current = 'unavailable';
      throw error;
    }
    this.descriptor = null;
    this.current = 'disabled';
  }

  /**
   * Shutdown outranks everything, never restarts and never post-reads. It is
   * idempotent and always reaches the terminal state even if a step throws:
   * a process that is going away cannot be left believing the lane is live.
   */
  private async runShutdown(): Promise<void> {
    if (this.current === 'shutdown') return;
    if (this.transition?.kind === 'shutdown') return this.transition.work;

    const work = (async () => {
      try {
        await this.deps.handoff.destroyClient();
        await this.deps.handoff.stopAndProveOwnedChildDead();
        await this.deps.handoff.awaitRetiredWork();
      } finally {
        this.descriptor = null;
        this.current = 'shutdown';
      }
    })();

    this.transition = { kind: 'shutdown', descriptor: null, work };
    try {
      await work;
    } finally {
      this.transition = null;
    }
  }

  /* -------------------------------------------------------------- */

  /**
   * Apply a verified replacement.
   *
   * Every precondition is re-read at call time rather than trusted from open:
   * the lease can be revoked by a child exit between two calls with no
   * notification, so a session that was enabled a millisecond ago may already
   * be writing into a different process.
   */
  async applyVerified(proof: unknown): Promise<SystemRecordApplyOutcomeV1> {
    if (this.current === 'shutdown' || this.current === 'unavailable') {
      return { outcome: 'capability-lost' };
    }
    if (this.current !== 'enabled') {
      // enabling / disabling / reconciling are all "not admitting work now".
      return { outcome: 'deferred', reason: 'generation-changed' };
    }

    const snapshot = readManagedOxigraphOwnershipSnapshotV1(this.deps.lease);
    if (!snapshot || snapshot.terminal) return { outcome: 'capability-lost' };
    if (!snapshot.ready) return { outcome: 'deferred', reason: 'generation-changed' };

    const boundGeneration = snapshot.childGeneration;
    const result = await this.deps.executor.applyVerified(proof, boundGeneration);

    // An indeterminate dispatch seals admission and hands ownership to
    // recovery; the lane must not accept further work against a generation
    // whose last write may or may not have committed.
    if (result.outcome === 'indeterminate') this.current = 'reconciling';

    // A generation that changed UNDER the dispatch means the response we just
    // read cannot be attributed to the child we addressed.
    const after = readManagedOxigraphOwnershipSnapshotV1(this.deps.lease);
    if (!after || after.childGeneration !== boundGeneration) {
      if (result.outcome === 'applied' || result.outcome === 'already-applied') {
        return { outcome: 'indeterminate', recoveryGeneration: after?.childGeneration ?? boundGeneration };
      }
    }
    return result;
  }

  private assertLeaseLive(): void {
    const snapshot = readManagedOxigraphOwnershipSnapshotV1(this.deps.lease);
    if (!snapshot) {
      throw new Error('system-record lane requires a supervisor-issued ownership lease');
    }
    if (snapshot.terminal) {
      throw new Error(
        `system-record lane ownership is terminal (${snapshot.lastInvalidation}); operator action required`,
      );
    }
  }
}
