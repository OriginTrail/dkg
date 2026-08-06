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

export interface SystemRecordLaneControllerDepsV1 {
  /** The supervisor-issued live ownership lease. Captured, never accepted per-call. */
  readonly lease: ManagedOxigraphOwnershipLeaseV1;
  readonly handoff: SystemRecordChildHandoffV1;
  readonly executor: SystemRecordTransactionExecutorV1;
  /**
   * Required, not optional. An optional barrier is one that gets forgotten:
   * this capability shipped once with a barrier implemented, exported and
   * tested but with zero production callers, so the enable path stopped the
   * child while ordinary requests were still in flight.
   */
  readonly barrier: SystemRecordLaneBarrierV1;
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
  session.owner = controller;
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

  /**
   * The controller this session backs, so shutdown can release the
   * process-global registration only if it is still the registered one.
   */
  owner: SystemRecordLaneControllerV1 | null = null;

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

    this.assertNotTerminal();

    // Same-descriptor concurrent opens coalesce; a different descriptor is a
    // caller error rather than an implicit reconfiguration, because switching
    // the enabled set silently would strand rows charged under the old one.
    if (this.transition) {
      if (this.transition.kind === 'open' && this.transition.descriptor === wanted) {
        await this.transition.work;
        // Re-check: the joined open may itself have failed into `unavailable`.
        this.assertNotTerminal();
        return this;
      }
      if (this.transition.kind !== 'open') {
        // Only a DISABLE can be here now: a shutdown makes `current` terminal at
        // intent, so `assertNotTerminal()` above has already thrown.
        //
        // Awaiting is correct, but the state validated BEFORE the await is stale
        // afterwards — a shutdown latching here makes the lane terminal, and
        // proceeding would start a fresh child after shutdown had proved the old
        // one dead and its port released. An executed exploit reached exactly
        // that: state `enabled`, activation generation 2, and a subsequent
        // `applyVerified` dispatched to the executor on a lane the process had
        // already shut down.
        await this.transition.work.catch(() => undefined);
        this.assertNotTerminal();
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

    const entry = { kind: 'open' as const, descriptor: wanted, work: this.runEnable(wanted) };
    this.transition = entry;
    try {
      await entry.work;
    } finally {
      this.release(entry);
    }
    // A shutdown can latch while our OWN handoff runs. `runEnable` then refuses
    // to publish `enabled`, so without this we would hand the caller back a
    // session whose `state` is already `shutdown`, as though the open had
    // succeeded.
    this.assertNotTerminal();
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
    this.commitState('enabling');
    try {
      // Under the barrier: admission is sealed and both tagged and untagged
      // work is drained before the child is touched, and not resumed until the
      // replacement generation is bound.
      await this.deps.barrier('system-record.enable', async () => {
        await this.deps.handoff.destroyClient();
        await this.deps.handoff.stopAndProveOwnedChildDead();
        await this.deps.handoff.awaitRetiredWork();
        await this.deps.handoff.startAndProveCleanGeneration();
        await this.deps.handoff.rotateMaterializationEpoch();
      });
    } catch (error) {
      this.commitState('unavailable');
      this.descriptor = null;
      throw error;
    }
    // POST-CONDITION: the handoff claims to have started and proved a clean
    // generation, so verify that rather than assume it. Without this,
    // `runEnable` moved to `enabled` purely because no step threw, and a
    // handoff that resolved without binding a ready generation produced an
    // "enabled" lane over a child that was not the proven listener.
    const bound = readManagedOxigraphOwnershipSnapshotV1(this.deps.lease);
    if (!bound || bound.terminal || !bound.ready) {
      this.commitState('unavailable');
      this.descriptor = null;
      throw new Error(
        'system-record lane enable completed without a proven-ready child generation ' +
          `(${bound ? `ready=${bound.ready} terminal=${bound.terminal}` : 'no lease'})`,
      );
    }

    // Publish as ONE commit. A shutdown that latched under the handoff outranks
    // this enable: the state write is refused, and the activation generation
    // must not be published either — a terminal lane advertising a fresh
    // activation is exactly the resurrection the latch exists to prevent.
    // State first, then the rest: no await separates them, so no observer can
    // see half a commit.
    if (!this.commitState('enabled')) return;
    this.activation += 1n;
    this.descriptor = descriptor;
  }

  /* -------------------------------------------------------------- */

  async close(mode: 'disable' | 'shutdown'): Promise<void> {
    if (mode === 'shutdown') return this.runShutdown();

    if (this.current === 'shutdown') return; // shutdown supersedes disable
    if (this.current === 'disabled' || this.current === 'unavailable') return;

    if (this.transition) {
      if (this.transition.kind === 'disable') return this.transition.work;
      // A `kind === 'shutdown'` branch used to sit here. Under the latch it is
      // unreachable: a shutdown makes `current` terminal at intent, so the
      // `current === 'shutdown'` check above has already returned. Deleted
      // rather than kept, because a branch that can no longer change an outcome
      // reads as protection.
      //
      // Disable outranks an in-flight open: join it, then disable the result.
      await this.transition.work.catch(() => undefined);
      // The joined open may have ended terminal, or a shutdown may have latched
      // while we waited. Re-read rather than acting on stale state.
      const after = this.readState();
      if (after === 'shutdown' || after === 'disabled' || after === 'unavailable') return;
      // Another disable that joined the SAME open may have resumed first and
      // already installed itself. `current` is then `disabling`, which none of
      // the three states above excludes, so installing anyway opened a SECOND
      // `system-record.disable` section and rotated the materialization epoch
      // twice for one disable.
      const raced = this.readTransition();
      if (raced?.kind === 'disable') return raced.work;
    }

    const entry = { kind: 'disable' as const, descriptor: null, work: this.runDisable() };
    this.transition = entry;
    try {
      await entry.work;
    } finally {
      this.release(entry);
    }
  }

  /**
   * Disable wins over open and over V1 recovery admission, but it cannot
   * shortcut physical settlement: an uncertain old write must still be resolved
   * before legacy callers are allowed to bypass, or a retired request could
   * commit after legacy work has already read around it.
   */
  private async runDisable(): Promise<void> {
    this.commitState('disabling');
    try {
      await this.deps.barrier('system-record.disable', async () => {
        await this.deps.handoff.awaitRetiredWork();
        await this.deps.handoff.rotateMaterializationEpoch();
      });
    } catch (error) {
      this.commitState('unavailable');
      throw error;
    }
    this.descriptor = null;
    this.commitState('disabled');
  }

  /**
   * Shutdown outranks everything, never restarts and never post-reads. It is
   * idempotent and always reaches the terminal state even if a step throws:
   * a process that is going away cannot be left believing the lane is live.
   */
  /**
   * NOT `async`, deliberately.
   *
   * Shutdown intent has to be established SYNCHRONOUSLY, before any await, or
   * concurrent callers each build their own teardown. Previously both callers
   * passed the "is a shutdown already running?" check (the in-flight transition
   * was still the open), both awaited it, both resumed, and both ran the
   * teardown while overwriting `this.transition`. Observed with two concurrent
   * shutdowns behind a stalled open: 4 destroy and 4 stop calls where 3 of each
   * were expected. Double stop-and-prove-release is not a harmless idempotency
   * assumption at a process-ownership boundary — each one signals a child and
   * asserts a port fact.
   *
   * Assigning `this.transition` before returning makes the second caller join
   * the first, whatever it is awaiting.
   */
  private runShutdown(): Promise<void> {
    // ORDER IS LOAD-BEARING, and it is the reverse of what it was.
    //
    // The latch below makes `current === 'shutdown'` true from the instant of
    // intent. With the state check first, every caller after the first would
    // get a RESOLVED promise while the child was still being stopped, and would
    // never see the teardown's failure. Joining first keeps "close('shutdown')
    // resolved" meaning "the teardown finished".
    if (this.transition?.kind === 'shutdown') return this.transition.work;
    if (this.readState() === 'shutdown') return Promise.resolve();

    // THE LATCH. Shutdown intent becomes the committed state SYNCHRONOUSLY —
    // before this method can suspend, and therefore before any other caller can
    // run a single statement.
    //
    // Every precedence decision in this class already re-reads `current` after
    // its awaits. Until now `current` could not carry shutdown intent at all:
    // it was written only in the teardown's `finally`, so for the whole teardown
    // the lane still read `enabled`. The only thing that DID carry the intent
    // was `this.transition`, a pointer any other transition's `finally` was
    // allowed to erase — which is exactly what round 2 of the review found.
    //
    // Moving terminality onto the state field is a change of CARRIER, not a
    // third patch to the pointer. It is what makes `applyVerified` correct with
    // no change to `applyVerified`: a dispatch during the teardown now sees a
    // terminal lane and returns `capability-lost` instead of being admitted.
    this.current = 'shutdown';

    const work = (async () => {
      // JOIN an in-flight open/disable rather than clobbering it. Overwriting
      // `this.transition` left the other transition running concurrently, so a
      // stalled enable would resume AFTER shutdown completed and set the lane
      // back to `enabled` — starting a replacement child after shutdown had
      // already proved the old one dead. Shutdown supersedes, which means it
      // must outlive the transition it supersedes, not race it.
      //
      // Failures are absorbed: the other transition losing to a teardown is an
      // expected outcome, and shutdown must reach terminal regardless.
      const inFlight = this.transition?.work;
      if (inFlight) await inFlight.catch(() => undefined);
      // A `if (this.readState() === 'shutdown') return;` used to sit here. Under
      // the latch it is ALWAYS true, so keeping it would skip every teardown —
      // the child would never be stopped and the lane would report a clean
      // shutdown. Deleted rather than adapted: the check it performed (has
      // someone else already shut down?) is the join two lines above.

      try {
        // Shutdown stops the child too, so it is sealed like the others.
        //
        // If the section cannot be acquired the teardown does NOT run, and that
        // is the safe side: the lane still reaches terminal (below, in the
        // `finally`), so nothing writes through it again, while the child is
        // left alive under the daemon supervisor that still owns it and stops
        // it at process exit. Stopping the child outside a section — with
        // requests in flight — is the exact hazard the barrier exists for, and
        // "could not quiesce" is not a reason to do it anyway.
        //
        // The error propagates: a shutdown that could not quiesce the store is
        // not a clean one and the caller has to be able to tell.
        await this.deps.barrier('system-record.shutdown', async () => {
          await this.deps.handoff.destroyClient();
          await this.deps.handoff.stopAndProveOwnedChildDead();
          await this.deps.handoff.awaitRetiredWork();
        });
      } finally {
        this.descriptor = null;
        // `this.current = 'shutdown'` used to be here. The latch already
        // committed it and `commitState` refuses to move off it, so a second
        // write would be a redundant mechanism for the same fact.
        this.transition = null;
        // Release the process-global registration. Holding it past shutdown
        // made a replacement controller unconstructable for the process
        // lifetime — and because the adapter calls the factory inside an
        // unguarded capability probe, the resulting throw escaped a
        // `getSystemRecordLaneControllerV1?.()` call, which must never throw.
        if (registeredController === this.owner) registeredController = null;
      }
    })();

    // THE fix, and it is this one line's PLACEMENT rather than its content:
    // the assignment happens synchronously, before any await, so a second
    // shutdown caller sees `kind === 'shutdown'` at the top and joins instead
    // of building its own teardown. Previously this method was `async` and the
    // assignment landed AFTER the join, so both callers passed the check while
    // the in-flight transition was still the OPEN and both ran a teardown —
    // 4 destroy / 4 stop where 3 of each were expected.
    //
    // It also makes the shutdown visible to `open()` and `close('disable')`,
    // which join `this.transition.work` and then re-check terminal state.
    //
    // A separate `shutdownWork` field was tried here and removed: with this
    // assignment synchronous it never changed an outcome, and mutating it away
    // left all 36 tests green. An inert guard reads as protection, so it is
    // worse than none.
    this.transition = { kind: 'shutdown', descriptor: null, work };
    return work;
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

    // Derive the FINAL outcome first, then seal on it.
    //
    // The previous order sealed only on the executor's own `indeterminate` and
    // then synthesized a second one below without sealing — so a success whose
    // generation changed under the dispatch returned `indeterminate` to the
    // caller while leaving the lane `enabled`, and the very next apply was
    // admitted. Reproduced: two dispatches, both returning `indeterminate`,
    // state `enabled` throughout. The second must never have been admitted.
    //
    // Attribution is checked on the WHOLE ownership snapshot, not just the
    // generation string: a lease that has gone not-ready or terminal under the
    // dispatch is equally unable to attribute the response, and reading only
    // `childGeneration` would miss both.
    const after = readManagedOxigraphOwnershipSnapshotV1(this.deps.lease);
    const attributable =
      after !== null &&
      !after.terminal &&
      after.ready &&
      after.childGeneration === boundGeneration;

    const final: SystemRecordApplyOutcomeV1 =
      !attributable && (result.outcome === 'applied' || result.outcome === 'already-applied')
        ? {
            outcome: 'indeterminate',
            recoveryGeneration: after?.childGeneration ?? boundGeneration,
          }
        : result;

    // One seal, on the final outcome, however it was reached. The lane must not
    // accept further work against a generation whose last write may or may not
    // have committed.
    // `commitState`, not a raw write: this is the fourth writer of `current` and
    // the only one that never touches `this.transition`, so no amount of
    // pointer discipline can reach it. A dispatch parked in the executor across
    // a COMPLETED shutdown resumed here and wrote `reconciling` over the
    // terminal state, after which the lane reopened and dispatched again.
    if (final.outcome === 'indeterminate') this.commitState('reconciling');
    return final;
  }

  /**
   * Clear the in-flight pointer ONLY if it is still ours.
   *
   * `runShutdown` deliberately REPLACES the pointer so that later callers join
   * its teardown instead of building a second one. An unconditional clear erased
   * that entry the moment the superseded transition settled, and the teardown
   * became invisible: a later `close('shutdown')` had nothing to join, built its
   * own, and two child signals plus two port assertions ran for one session.
   *
   * The pointer is now only a coalescing hint — it decides who joins whom, never
   * whether a transition runs or what state results. A stale one degrades to a
   * redundant join rather than a wrong transition.
   */
  private release(entry: object): void {
    if (this.transition === entry) this.transition = null;
  }

  /**
   * The only writer of `current` apart from the shutdown latch itself.
   *
   * Because shutdown latches synchronously at intent, every other transition can
   * be mid-flight when it lands, and each one ends by writing its own outcome —
   * `enabled`, `disabled`, `unavailable`, `reconciling` — from a continuation
   * that resumes AFTER the latch. Refusing those writes here makes "terminal is
   * final" a property of the FIELD rather than of an await ordering that has now
   * been audited wrong twice.
   *
   * Returns false so a caller that publishes more than the state (`runEnable`
   * also publishes the activation generation and descriptor) can abandon the
   * whole commit rather than half of it.
   *
   * Note on the two synchronous call sites: `commitState('enabling')` and
   * `commitState('disabling')` are reached with no await between them and their
   * caller's terminal check, so their refusal is currently unreachable. They go
   * through here anyway, because the property being relied on is "`commitState`
   * is the only writer of `current`" — a raw write at those two sites
   * reintroduces exactly the await-placement audit that has been wrong twice.
   */
  private commitState(next: SystemRecordLaneStateV1): boolean {
    if (this.readState() === 'shutdown') return false;
    this.current = next;
    return true;
  }

  /**
   * Terminal states never reopen.
   *
   * Called both BEFORE and AFTER every `await this.transition.work`, because
   * state validated before an await is stale after it — that staleness is what
   * let a shut-down lane revive and dispatch a write.
   */
  private assertNotTerminal(): void {
    const state = this.readState();
    if (state === 'shutdown' || state === 'unavailable') {
      throw new Error(`system-record lane is terminal (${state}) and cannot be reopened`);
    }
  }

  /**
   * Widened read of `current`, defeating control-flow narrowing.
   *
   * TypeScript narrows `this.current` and does NOT invalidate that narrowing
   * across an `await` — it assumes no one else mutated the field meanwhile.
   * That assumption is exactly the bug this class had: a concurrent transition
   * DOES change the state under an await, and the compiler was reporting the
   * post-await re-checks as impossible comparisons. Reading through a method
   * call keeps the union wide so the guards type-check and, more importantly,
   * so a future reader is not tempted to delete them as dead code.
   */
  private readState(): SystemRecordLaneStateV1 {
    return this.current;
  }

  /**
   * Widened read of `transition`, for the same reason as {@link readState}.
   *
   * TypeScript narrows `this.transition.kind` from the checks earlier in
   * `close()` and does not invalidate that narrowing across the `await` — so a
   * post-await re-read of the very field a concurrent caller is expected to have
   * changed is reported as an impossible comparison. That report is the compiler
   * asserting the assumption this class exists to break.
   */
  private readTransition(): SystemRecordLaneSession['transition'] {
    return this.transition;
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
