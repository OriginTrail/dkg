import {
  readManagedOxigraphOwnershipSnapshotV1,
  type ManagedOxigraphOwnershipLeaseV1,
} from './managed-oxigraph-ownership-v1-internal.js';
import type {
  SystemRecordAtomicApplySettlementV1,
  SystemRecordAtomicRecoveryRegistrarV1,
  SystemRecordAtomicRecoveryRequestV1,
  SystemRecordAtomicRecoveryResolutionV1,
  SystemRecordAtomicRecoveryRuntimeV1,
} from './system-record-atomic-apply-executor-v1-internal.js';
import {
  SystemRecordApplyAdmissionTrackerV1,
  type SystemRecordOwnedRecoverySettlementV1,
} from './system-record-lane-coordination-v1-internal.js';
import {
  snapshotSystemRecordDenseArrayV1,
  snapshotSystemRecordExactDataRecordV1,
} from './system-record-input-guards-v1-internal.js';

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
  | 'unavailable'
  /**
   * The owning store closed. Terminal, and distinct from `shutdown`: only
   * `shutdown` claims the child was proven dead, and a detach proves nothing
   * about the child because the adapter never owned it.
   */
  | 'detached';

export interface SystemRecordLaneSessionV1 {
  readonly state: SystemRecordLaneStateV1;
  /** The activation generation this facade was created for. */
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
  destroyClient(absoluteDeadlineMs?: number): Promise<void>;
  /** Stop the owned child and PROVE exit plus port release. Reject if unproven. */
  stopAndProveOwnedChildDead(absoluteDeadlineMs?: number): Promise<void>;
  /** Await every promise and permit issued against the retired generation. */
  awaitRetiredWork(absoluteDeadlineMs?: number): Promise<void>;
  /** Start a replacement child and prove it is the ready listener. */
  startAndProveCleanGeneration(absoluteDeadlineMs?: number): Promise<void>;
  /** Permanently refuse ordinary managed mutations after an unproven transition. */
  failManagedMutationsClosed?(reason: string): void;
  /**
   * Durably rotate the per-network agents epoch under exclusive control.
   *
   * The optional argument and void result preserve the B2 handoff shape. A
   * void result is accepted only for an executor without the B3 settlement
   * boundary; the controller then derives the proven child generation from
   * its lease and keeps the missing epoch behind an internal legacy marker.
   * A B3 activation still requires the concrete binding.
   */
  rotateMaterializationEpoch(networkId?: string): Promise<void | {
    readonly epoch: string;
    readonly childGeneration: string;
  }>;
  /**
   * Bind the exact-recovery read to the proven replacement generation.
   * Optional only while the B2 adapter migrates to the B3 atomic executor;
   * an uncertain B3 write without it fails terminally closed.
   */
  createRecoveryRuntime?(
    binding: SystemRecordLaneExecutionBindingV1,
    absoluteDeadlineMs: number,
    signal: AbortSignal,
  ): SystemRecordAtomicRecoveryRuntimeV1;
}

export interface SystemRecordTransactionExecutorV1 {
  applyVerified(proof: unknown, childGeneration: string): Promise<SystemRecordApplyOutcomeV1>;
  /** Release an authentic proof that lifecycle admission refused before dispatch. */
  discardVerified?(proof: unknown): void;
  /**
   * Preferred activation-bound entry point.
   *
   * Optional only while the storage adapter migrates from the B2
   * child-generation-only contract. The lane always performs the complete
   * facade binding check itself; an executor that implements this method also
   * receives the frozen facts needed to repeat that check at dispatch.
   */
  applyVerifiedBound?(
    proof: unknown,
    binding: SystemRecordLaneExecutionBindingV1,
  ): Promise<SystemRecordApplyOutcomeV1>;
  /**
   * B3 transaction boundary. Mutation settlement is explicit and an uncertain
   * write transfers ownership through `registerRecovery` while the executor's
   * exclusive scheduler permit is still live. The executor must pass the exact
   * binding object it received, invoke the registrar at most once before its
   * returned promise settles, and must not retain that invocation-scoped
   * capability afterward. The registrar call synchronously installs recovery
   * ownership; the executor itself may have awaited inspection and dispatch.
   */
  applyVerifiedSettlementBound?(
    proof: unknown,
    binding: SystemRecordLaneExecutionBindingV1,
    registerRecovery: SystemRecordAtomicRecoveryRegistrarV1,
  ): Promise<SystemRecordAtomicApplySettlementV1>;
}

export interface SystemRecordLaneExecutionBindingV1 {
  readonly activationGeneration: string;
  readonly networkId: string;
  readonly kind: 'agents';
  readonly mode: 'shadow' | 'authoritative';
  readonly sessionIdentity: object;
  readonly childGeneration: string;
  readonly materializationEpoch: string;
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
  /**
   * Adapter-owned admission latch, driven by the lifecycle's physical state.
   * `true` is published synchronously before enable can enqueue its barrier;
   * `false` is published only after disable physically commits or the lane is
   * terminally unavailable. Merely constructing the controller never calls it.
   */
  readonly setAdmissionActive?: (active: boolean) => void;
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

interface SystemRecordLaneActivationSnapshotV1 {
  readonly networkId: string;
  readonly kind: 'agents';
  readonly mode: 'shadow' | 'authoritative';
}

const NETWORK_ID_PATTERN_V1 = /^[A-Za-z0-9._:-]+$/;
const MAX_NETWORK_ID_BYTES_V1 = 128;
const UTF8 = new TextEncoder();

/** Snapshot the closed activation record without invoking caller traps or accessors. */
const snapshotActivation = (activation: unknown): SystemRecordLaneActivationSnapshotV1 => {
  const record = snapshotSystemRecordExactDataRecordV1(
    activation,
    ['kinds', 'mode', 'networkId'],
    'system-record lane activation',
  );
  const networkId = record.networkId;
  if (
    typeof networkId !== 'string' ||
    networkId.length === 0 ||
    UTF8.encode(networkId).byteLength > MAX_NETWORK_ID_BYTES_V1 ||
    !NETWORK_ID_PATTERN_V1.test(networkId)
  ) {
    throw new Error('system-record lane activation networkId is not canonical');
  }

  let kinds: readonly unknown[];
  try {
    kinds = snapshotSystemRecordDenseArrayV1(record.kinds, {
      label: 'system-record lane activation kinds',
      minLength: 1,
      maxLength: 1,
    });
  } catch {
    throw new Error('system-record lane activation kinds must be the closed [agents] tuple');
  }
  if (kinds[0] !== 'agents') {
    throw new Error('system-record lane activation kinds must be the closed [agents] tuple');
  }

  const mode = record.mode;
  if (mode !== 'shadow' && mode !== 'authoritative') {
    throw new Error('system-record lane activation mode is invalid');
  }

  return Object.freeze({ networkId, kind: 'agents', mode });
};

const descriptorOf = (activation: SystemRecordLaneActivationSnapshotV1): string =>
  `${activation.networkId}|${activation.kind}|${activation.mode}`;

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

/**
 * Controller -> session, module-private and keyed by identity.
 *
 * Same construction as the ownership lease's own table, and for the same
 * reason: `releaseSystemRecordLaneControllerV1` must be able to reach the
 * session behind a controller without putting a mutable back-reference on the
 * frozen public object, where any holder could reach it.
 */
const CONTROLLER_SESSIONS = new WeakMap<
  SystemRecordLaneControllerV1,
  SystemRecordLaneSession
>();

/** Test-only reset. Never called from production code. */
export function __resetSystemRecordControllerRegistrationForTests(): void {
  registeredController = null;
}

/**
 * Production disposal, called by the store that obtained the controller.
 *
 * Two separately-scoped effects, and keeping them separate is the whole
 * correctness argument:
 *
 * 1. The SESSION is detached unconditionally. Its owner is disposing of it, so
 *    it must stop being usable whether or not it still holds the global.
 * 2. The GLOBAL registration is released only if this controller still holds
 *    it. That identity check is the "exactly its own" guarantee. An
 *    unconditional clear was measured to hand a THIRD store a second live
 *    controller over the same child: store B probes, is refused, and its
 *    `close()` then releases store A's registration although B never held it.
 *
 * Detach, not shutdown: a shutdown runs `stopAndProveOwnedChildDead` on a child
 * the daemon supervisor owns and is about to stop itself, and runs it under a
 * control barrier whose failure would make `store.close()` reject. The adapter
 * never owned the child, so it makes no claim about it.
 */
export async function releaseSystemRecordLaneControllerV1(
  controller: SystemRecordLaneControllerV1,
  quiesceOwner: () => Promise<void> = () => Promise.resolve(),
): Promise<void> {
  const session = CONTROLLER_SESSIONS.get(controller);
  const recoverySettlement = session?.detach() ?? Promise.resolve();
  // Detach is synchronous up to its first return: new lane work is refused
  // before owner quiescence starts. The global slot remains claimed until BOTH
  // the store is drained and any already-owned uncertain-write recovery has
  // physically settled. Promise.all also observes the recovery if quiescence
  // fails, while deliberately retaining the registration on either failure.
  await Promise.all([quiesceOwner(), recoverySettlement]);
  if (registeredController === controller) registeredController = null;
  CONTROLLER_SESSIONS.delete(controller);
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
  CONTROLLER_SESSIONS.set(controller, session);
  registeredController = controller;
  return controller;
}

/* ------------------------------------------------------------------ *
 * The one aggregate session
 * ------------------------------------------------------------------ */

interface SystemRecordLaneFacadeBindingV1 {
  readonly descriptor: string;
  readonly activationGeneration: string;
  readonly networkId: string;
  readonly kind: 'agents';
  readonly mode: 'shadow' | 'authoritative';
  readonly sessionIdentity: object;
  readonly childGeneration: string;
  readonly materializationEpoch: string;
}

interface SystemRecordPendingRecoveryV1 {
  readonly request: SystemRecordAtomicRecoveryRequestV1;
  readonly absoluteDeadlineMs: number;
  readonly settlement: SystemRecordOwnedRecoverySettlementV1<
    SystemRecordAtomicRecoveryResolutionV1
  >;
  readonly exactReadAbort: AbortController;
  readonly physicalSettlement: SystemRecordPhysicalSettlementV1;
}

interface SystemRecordPhysicalSettlementV1 {
  state:
    | 'unsettled'
    | 'owned-child-dead'
    | 'old-generation-dead'
    | 'replacement-live'
    | 'all-generations-dead';
}

type SystemRecordLaneTransitionV1 =
  | {
      readonly kind: 'open';
      readonly descriptor: string;
      readonly work: Promise<void>;
    }
  | {
      readonly kind: 'disable';
      readonly descriptor: null;
      readonly work: Promise<void>;
      readonly settlement: Promise<void>;
      physicalWork: Promise<void> | null;
      physicalSettled: boolean;
      reportedSettled: boolean;
      recovery: SystemRecordPendingRecoveryV1 | null;
    }
  | {
      readonly kind: 'shutdown';
      readonly descriptor: null;
      readonly work: Promise<void>;
      readonly settlement: Promise<void>;
      physicalWork: Promise<void> | null;
      physicalSettled: boolean;
      physicalSucceeded: boolean;
      reportedSettled: boolean;
      recovery: SystemRecordPendingRecoveryV1 | null;
    }
  | {
      readonly kind: 'recovery';
      readonly descriptor: null;
      readonly work: Promise<void>;
      physicalWork: Promise<void> | null;
      physicalSettled: boolean;
      readonly recovery: SystemRecordPendingRecoveryV1;
      shutdownTeardownComplete: boolean;
    };

interface SystemRecordDeferredV1<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function createSystemRecordDeferredV1<T>(): SystemRecordDeferredV1<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return Object.freeze({ promise, resolve, reject });
}

/** The lane-specific owner of transition publication and detach settlements. */
class SystemRecordLaneTransitionsV1 {
  private active: SystemRecordLaneTransitionV1 | null = null;
  private recoverySequence = 0n;
  private settlementVersion = 0;
  private readonly ownedSettlements = new Map<
    SystemRecordLaneTransitionV1,
    Readonly<{ settlement: Promise<void>; assertSettled?: () => void }>
  >();

  get current(): SystemRecordLaneTransitionV1 | null {
    return this.active;
  }

  startOpen(entry: Extract<SystemRecordLaneTransitionV1, { kind: 'open' }>): void {
    this.start(entry, entry.work);
  }

  startDisable(entry: Extract<SystemRecordLaneTransitionV1, { kind: 'disable' }>): void {
    this.start(entry, entry.settlement, () => this.assertRecoverySettled(entry));
  }

  startShutdown(entry: Extract<SystemRecordLaneTransitionV1, { kind: 'shutdown' }>): void {
    this.start(entry, entry.settlement, () => this.assertRecoverySettled(entry));
  }

  startRecovery(entry: Extract<SystemRecordLaneTransitionV1, { kind: 'recovery' }>): void {
    this.start(entry, entry.work, () => this.assertRecoverySettled(entry));
  }

  release(entry: SystemRecordLaneTransitionV1): void {
    if (this.active === entry) this.active = null;
    if (this.ownedSettlements.delete(entry)) this.settlementVersion += 1;
  }

  createRecoverySettlement<Resolution>(): SystemRecordOwnedRecoverySettlementV1<Resolution> {
    this.recoverySequence += 1n;
    const recoveryGeneration = this.recoverySequence.toString(10);
    let settled = false;
    let resolve!: (resolution: Resolution) => void;
    const completion = new Promise<Resolution>((settle) => { resolve = settle; });
    return Object.freeze({
      recoveryGeneration,
      completion,
      get settled() { return settled; },
      settle: (resolution: Resolution) => {
        if (settled) return;
        settled = true;
        resolve(resolution);
      },
    });
  }

  async drainForDetach(): Promise<void> {
    for (;;) {
      const version = this.settlementVersion;
      const owned = [...this.ownedSettlements.entries()];
      const results = await Promise.allSettled(owned.map(([, value]) => value.settlement));
      if (version !== this.settlementVersion) continue;
      for (const [index, [entry, value]] of owned.entries()) {
        if (!this.ownedSettlements.has(entry)) continue;
        const result = results[index];
        if (result?.status === 'rejected') throw result.reason;
        value.assertSettled?.();
      }
      return;
    }
  }

  private start(
    entry: SystemRecordLaneTransitionV1,
    settlement: Promise<void>,
    assertSettled?: () => void,
  ): void {
    if (this.ownedSettlements.has(entry)) {
      throw new Error('system-record transition settlement is already owned');
    }
    // One current transition plus one shutdown-superseded predecessor is the
    // complete lane state space. This is not a general-purpose work queue.
    if (this.ownedSettlements.size >= 2) {
      throw new Error('system-record transition settlement ownership exceeded its bound');
    }
    this.active = entry;
    this.ownedSettlements.set(entry, Object.freeze({ settlement, assertSettled }));
    this.settlementVersion += 1;
    void settlement.catch(() => undefined);
  }

  private assertRecoverySettled(
    entry: Exclude<SystemRecordLaneTransitionV1, { kind: 'open' }>,
  ): void {
    if (entry.recovery !== null && !entry.recovery.settlement.settled) {
      throw new Error(
        'system-record controller detach could not prove uncertain-write recovery settled',
      );
    }
  }
}

const SYSTEM_RECORD_RECOVERY_DEADLINE_MS_V1 = 30_000;

// B2 exposed neither an epoch binding nor a settlement-bound executor. Keep
// its absent epoch distinguishable from every canonical decimal V1 epoch while
// the facade/session identity and lease generation retain admission authority.
const INTERNAL_B2_MATERIALIZATION_EPOCH_SENTINEL_V1 =
  'internal:b2-materialization-epoch-unavailable';

/**
 * An immutable view of one successful activation.
 *
 * Lifecycle remains aggregate: closing any facade still disables or shuts
 * down the one physical lane. Admission is activation-scoped: applying through
 * a facade from before a disable/reopen is refused even when the descriptor is
 * unchanged and the aggregate is enabled again.
 */
class SystemRecordLaneFacade implements SystemRecordLaneSessionV1 {
  constructor(
    private readonly aggregate: SystemRecordLaneSession,
    private readonly binding: SystemRecordLaneFacadeBindingV1,
  ) {
    Object.freeze(this);
  }

  get state(): SystemRecordLaneStateV1 {
    return this.aggregate.state;
  }

  get activationGeneration(): string {
    return this.binding.activationGeneration;
  }

  applyVerified(proof: unknown): Promise<SystemRecordApplyOutcomeV1> {
    return this.aggregate.applyVerifiedForBinding(proof, this.binding);
  }

  close(mode: 'disable' | 'shutdown'): Promise<void> {
    return this.aggregate.close(mode);
  }
}

class SystemRecordLaneSession {
  private current: SystemRecordLaneStateV1 = 'disabled';
  private activation = 0n;
  private descriptor: string | null = null;
  private activeNetworkId: string | null = null;
  private activeSessionIdentity: object | null = null;
  private activeChildGeneration: string | null = null;
  private activeMaterializationEpoch: string | null = null;
  /** One facade per activation binding; a new generation gets a new facade. */
  private activeFacade: SystemRecordLaneSessionV1 | null = null;
  private readonly admissions = new SystemRecordApplyAdmissionTrackerV1();
  private readonly transitions = new SystemRecordLaneTransitionsV1();
  /** Concurrent disposal callers join one ownership decision. */
  private detachSettlement: Promise<void> | null = null;

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

  async open(activation: SystemRecordLaneActivationV1): Promise<SystemRecordLaneSessionV1> {
    const activationSnapshot = snapshotActivation(activation);
    const wanted = descriptorOf(activationSnapshot);

    this.assertNotTerminal();

    // Same-descriptor concurrent opens coalesce; a different descriptor is a
    // caller error rather than an implicit reconfiguration, because switching
    // the enabled set silently would strand rows charged under the old one.
    const activeTransition = this.transitions.current;
    if (activeTransition) {
      if (activeTransition.kind === 'open' && activeTransition.descriptor === wanted) {
        await activeTransition.work;
        // Re-check: the joined open may itself have failed into `unavailable`.
        this.assertNotTerminal();
        return this.createFacade(wanted, activationSnapshot);
      }
      if (activeTransition.kind !== 'open') {
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
        await this.transitionSettlement(activeTransition).catch(() => undefined);
        this.assertNotTerminal();
      } else {
        throw new SystemRecordLaneActivationConflictError(
          activeTransition.descriptor ?? 'unknown',
          wanted,
        );
      }
    }

    if (this.current === 'enabled') {
      if (this.descriptor === wanted) return this.createFacade(wanted, activationSnapshot);
      throw new SystemRecordLaneActivationConflictError(this.descriptor ?? 'unknown', wanted);
    }

    const entry = {
      kind: 'open' as const,
      descriptor: wanted,
      work: this.runEnable(wanted, activationSnapshot),
    };
    this.transitions.startOpen(entry);
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
    return this.createFacade(wanted, activationSnapshot);
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
  private async runEnable(
    descriptor: string,
    activation: SystemRecordLaneActivationSnapshotV1,
  ): Promise<void> {
    this.assertLeaseLive();
    this.commitState('enabling');
    let rotated: void | { readonly epoch: string; readonly childGeneration: string };
    try {
      // Under the barrier: admission is sealed and both tagged and untagged
      // work is drained before the child is touched, and not resumed until the
      // replacement generation is bound.
      rotated = await this.deps.barrier('system-record.enable', async () => {
        await this.deps.handoff.destroyClient();
        await this.deps.handoff.stopAndProveOwnedChildDead();
        await this.deps.handoff.awaitRetiredWork();
        await this.deps.handoff.startAndProveCleanGeneration();
        return this.deps.handoff.rotateMaterializationEpoch(activation.networkId);
      });
    } catch (error) {
      this.failManagedMutationsClosed('enable transition did not physically settle');
      this.commitState('unavailable');
      this.descriptor = null;
      this.clearActiveBinding();
      throw error;
    }
    if (
      (!rotated && this.deps.executor.applyVerifiedSettlementBound) ||
      (rotated && (
        typeof rotated.epoch !== 'string' ||
        typeof rotated.childGeneration !== 'string'
      ))
    ) {
      this.failManagedMutationsClosed(
        'enable transition did not return a materialization epoch binding',
      );
      this.commitState('unavailable');
      this.descriptor = null;
      this.clearActiveBinding();
      throw new Error(
        'system-record lane enable did not return a materialization epoch binding',
      );
    }
    // POST-CONDITION: the handoff claims to have started and proved a clean
    // generation, so verify that rather than assume it. Without this,
    // `runEnable` moved to `enabled` purely because no step threw, and a
    // handoff that resolved without binding a ready generation produced an
    // "enabled" lane over a child that was not the proven listener.
    const bound = readManagedOxigraphOwnershipSnapshotV1(this.deps.lease);
    const activationBinding = rotated ?? (bound && !bound.terminal && bound.ready
      ? Object.freeze({
          epoch: INTERNAL_B2_MATERIALIZATION_EPOCH_SENTINEL_V1,
          childGeneration: bound.childGeneration,
        })
      : undefined);
    if (
      !bound ||
      bound.terminal ||
      !bound.ready ||
      !activationBinding ||
      bound.childGeneration !== activationBinding.childGeneration
    ) {
      this.failManagedMutationsClosed('enable transition did not prove replacement ownership');
      this.commitState('unavailable');
      this.descriptor = null;
      this.clearActiveBinding();
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
    this.activeNetworkId = activation.networkId;
    this.activeSessionIdentity = Object.freeze(Object.create(null) as object);
    this.activeChildGeneration = activationBinding.childGeneration;
    this.activeMaterializationEpoch = activationBinding.epoch;
  }

  /* -------------------------------------------------------------- */

  async close(mode: 'disable' | 'shutdown'): Promise<void> {
    if (mode === 'shutdown') return this.runShutdown();

    if (this.current === 'shutdown' || this.current === 'detached') return;
    if (this.current === 'disabled' || this.current === 'unavailable') return;

    const activeTransition = this.transitions.current;
    if (activeTransition) {
      if (activeTransition.kind === 'disable') {
        return activeTransition.reportedSettled
          ? activeTransition.settlement
          : activeTransition.work;
      }
      // A `kind === 'shutdown'` branch used to sit here. Under the latch it is
      // unreachable: a shutdown makes `current` terminal at intent, so the
      // `current === 'shutdown'` check above has already returned. Deleted
      // rather than kept, because a branch that can no longer change an outcome
      // reads as protection.
      //
      // Disable outranks recovery at INTENT. Latch `disabling` before joining
      // so the recovery continuation cannot briefly republish `enabled` and
      // admit legacy/V1 work between settlement and this close.
      if (activeTransition.kind === 'recovery') this.commitState('disabling');
      // Disable outranks an in-flight open/recovery: join it, then disable the
      // resulting clean generation. The recovery itself cannot be skipped;
      // physical ambiguity must settle before legacy can bypass.
      await this.transitionSettlement(activeTransition).catch(() => undefined);
      // The joined open may have ended terminal, or a shutdown may have latched
      // while we waited. Re-read rather than acting on stale state.
      const after = this.readState();
      if (
        after === 'shutdown' ||
        after === 'detached' ||
        after === 'disabled' ||
        after === 'unavailable'
      ) return;
      // Another disable that joined the SAME open may have resumed first and
      // already installed itself. `current` is then `disabling`, which none of
      // the three states above excludes, so installing anyway opened a SECOND
      // `system-record.disable` section and rotated the materialization epoch
      // twice for one disable.
      const raced = this.readTransition();
      if (raced?.kind === 'disable') {
        return raced.reportedSettled ? raced.settlement : raced.work;
      }
    }

    const publicWork = createSystemRecordDeferredV1<void>();
    const physicalSettlement = createSystemRecordDeferredV1<void>();
    const entry: Extract<SystemRecordLaneTransitionV1, { kind: 'disable' }> = {
      kind: 'disable',
      descriptor: null,
      recovery: null,
      work: publicWork.promise,
      settlement: physicalSettlement.promise,
      physicalWork: null,
      physicalSettled: false,
      reportedSettled: false,
    };
    this.transitions.startDisable(entry);
    const operation = this.runDisable(entry);
    void operation.then(publicWork.resolve, publicWork.reject);
    const settlement = (async () => {
      try {
        await operation;
      } catch (reportedError) {
        if (entry.physicalWork) await entry.physicalWork;
        else throw reportedError;
      }
    })().finally(() => {
      // Preserve an unresolved recovery token for a later shutdown attempt.
      // Its executor reservation remains charged, and losing this pointer would
      // make a subsequently successful physical teardown unable to settle it.
      if (entry.recovery === null || entry.recovery.settlement.settled) this.release(entry);
    });
    void settlement.then(physicalSettlement.resolve, physicalSettlement.reject);
    return entry.work;
  }

  /**
   * Disable wins over open and over V1 recovery admission, but it cannot
   * shortcut physical settlement: an uncertain old write must still be resolved
   * before legacy callers are allowed to bypass, or a retired request could
   * commit after legacy work has already read around it.
   */
  private runDisable(
    entry: Extract<SystemRecordLaneTransitionV1, { kind: 'disable' }>,
  ): Promise<void> {
    this.commitState('disabling');
    const networkId = this.activeNetworkId;
    if (networkId === null) {
      this.commitState('unavailable');
      const failure = Promise.reject<void>(
        new Error('system-record lane has no active network binding to disable'),
      );
      entry.reportedSettled = true;
      void failure.catch(() => undefined);
      this.release(entry);
      return failure;
    }

    const work = (async () => {
      try {
        await this.deps.barrier('system-record.disable', () => {
          // Keep the callback promise separately from the barrier's public
          // promise. A transition timeout reports to this caller while the
          // callback remains the exclusive physical owner.
          const physicalWork = (async () => {
            try {
              // If an already-running apply transferred uncertainty after disable
              // sealed admission, the request attaches to THIS barrier. Enqueueing a
              // second recovery barrier behind it would let this close rotate/return
              // before physical settlement and reopen the legacy bypass window.
              if (entry.recovery) {
                const recovered = await this.recoverInsideBarrier(entry.recovery, 'disable');
                if (recovered.resolution === 'unavailable') {
                  throw new Error(
                    'system-record uncertain write could not be settled during disable',
                  );
                }
              } else {
                await this.deps.handoff.awaitRetiredWork();
              }
              await this.deps.handoff.rotateMaterializationEpoch(networkId);
              this.descriptor = null;
              this.clearActiveBinding();
              this.commitState('disabled');
            } catch (error) {
              this.failManagedMutationsClosed('disable transition did not physically settle');
              this.commitState('unavailable');
              throw error;
            } finally {
              entry.physicalSettled = true;
            }
          })();
          entry.physicalWork = physicalWork;
          return physicalWork;
        });
      } catch (error) {
        // A wait timeout never invoked the callback. Once it has started, the
        // callback itself owns the fail-closed state and retained settlement.
        if (entry.physicalWork === null) {
          this.failManagedMutationsClosed('disable transition did not physically settle');
          this.commitState('unavailable');
          this.descriptor = null;
          this.clearActiveBinding();
        }
        throw error;
      } finally {
        entry.reportedSettled = true;
        if (
          entry.physicalWork === null &&
          (entry.recovery === null || entry.recovery.settlement.settled)
        ) this.release(entry);
      }
    })();

    return work;
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
    const activeTransition = this.transitions.current;
    if (activeTransition?.kind === 'shutdown') {
      return activeTransition.reportedSettled
        ? activeTransition.settlement
        : activeTransition.work;
    }
    if (this.readState() === 'shutdown') return Promise.resolve();
    // A DETACHED lane has no store behind it and no claim on the child: its
    // adapter closed, and the supervisor stops the child itself. Running the
    // teardown here would signal a process the daemon is already stopping.
    if (this.readState() === 'detached') return Promise.resolve();

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

    const superseded = activeTransition;
    // If exact settlement is already reading the replacement generation, make
    // shutdown cancel that owned request NOW. The transition below still joins
    // the superseded work before touching the child, so cancellation cannot
    // leave an HTTP promise running after the control barrier releases.
    const supersededRecovery = this.recoveryOf(superseded);
    supersededRecovery?.exactReadAbort.abort(
      new Error('system-record exact recovery cancelled by shutdown'),
    );
    const publicWork = createSystemRecordDeferredV1<void>();
    const physicalSettlement = createSystemRecordDeferredV1<void>();
    const entry: Extract<SystemRecordLaneTransitionV1, { kind: 'shutdown' }> = {
      kind: 'shutdown',
      descriptor: null,
      recovery: supersededRecovery,
      work: publicWork.promise,
      settlement: physicalSettlement.promise,
      physicalWork: null,
      physicalSettled: false,
      physicalSucceeded: false,
      reportedSettled: false,
    };
    this.transitions.startShutdown(entry);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      this.descriptor = null;
      this.clearActiveBinding();
      // A callback failure OR a wait-phase timeout leaves the process unable
      // to prove the child/client boundary. Keep both the transition and
      // process-global registration claimed so later closes join the same
      // failure and no replacement controller can be created in this process.
      if (!entry.physicalSucceeded) return;
      cleaned = true;
      this.deps.setAdmissionActive?.(false);
      this.release(entry);
      // A replacement controller is safe only after the physical transition
      // callback has settled. A scheduler transition timeout rejects its
      // public promise early but deliberately retains the seal and callback.
      if (registeredController === this.owner) registeredController = null;
      if (this.owner) CONTROLLER_SESSIONS.delete(this.owner);
    };

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
      const inFlight = superseded && this.transitionSettlement(superseded);
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
        // A recovery that shutdown superseded may already have performed the
        // one physical stop/drain. Joining it is sufficient; repeating the
        // process-tree signal and port proof is not an idempotency assumption
        // this lifecycle is allowed to make.
        const recoveryAlreadySettled =
          supersededRecovery?.physicalSettlement.state === 'all-generations-dead';
        if (recoveryAlreadySettled) {
          entry.physicalSucceeded = true;
        } else {
          await this.deps.barrier('system-record.shutdown', () => {
            // Keep the callback promise separately from the barrier's public
            // promise. The scheduler may reject the latter at its transition
            // timeout while deliberately leaving this callback and its seal
            // alive until the physical teardown settles.
            const physicalWork = (async () => {
              try {
                // An apply that was active when shutdown sealed admission
                // attaches its uncertainty to this already-enqueued transition.
                // Shutdown proves physical settlement but deliberately never
                // starts a replacement child or performs a post-read.
                if (entry.recovery) {
                  const recovered = await this.recoverInsideBarrier(entry.recovery, 'shutdown');
                  if (!recovered.physicallySettled) {
                    throw new Error(
                      'system-record shutdown could not prove uncertain write settled',
                    );
                  }
                } else {
                  await this.deps.handoff.destroyClient();
                  await this.deps.handoff.stopAndProveOwnedChildDead();
                  await this.deps.handoff.awaitRetiredWork();
                }
                entry.physicalSucceeded = true;
              } finally {
                entry.physicalSettled = true;
              }
            })();
            entry.physicalWork = physicalWork;
            return physicalWork;
          });
        }
      } catch (error) {
        this.failManagedMutationsClosed('shutdown transition did not physically settle');
        throw error;
      } finally {
        // `this.current = 'shutdown'` used to be here. The latch already
        // committed it and `commitState` refuses to move off it, so a second
        // write would be a redundant mechanism for the same fact.
        entry.reportedSettled = true;
        // Neither timeout is physical proof. A wait-phase timeout never invoked
        // the callback; a transition timeout leaves it running under the
        // scheduler's exclusive seal. Retain ownership in both cases unless a
        // callback actually completed the teardown.
        if (entry.physicalWork === null || entry.physicalSettled) cleanup();
      }
    })();

    // THE fix is the publication placement: the transition and the exact
    // settlement detach owns are published synchronously, before any await, so a second
    // shutdown caller sees `kind === 'shutdown'` at the top and joins instead
    // of building its own teardown. Previously this method was `async` and the
    // assignment landed AFTER the join, so both callers passed the check while
    // the in-flight transition was still the OPEN and both ran a teardown —
    // 4 destroy / 4 stop where 3 of each were expected.
    //
    // It also makes the shutdown visible to `open()` and `close('disable')`,
    // which join `this.transition.work` and then re-check terminal state.
    //
    void work.then(publicWork.resolve, publicWork.reject);
    const settlement = (async () => {
      try {
        await work;
      } catch (reportedError) {
        // Once a scheduler callback has started, its promise is the physical
        // truth. Later shutdown callers join it rather than replaying the
        // already-reported barrier timeout.
        if (entry.physicalWork) await entry.physicalWork;
        else throw reportedError;
      }
    })().finally(cleanup);
    void settlement.then(physicalSettlement.resolve, physicalSettlement.reject);
    return entry.work;
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
  async applyVerifiedForBinding(
    proof: unknown,
    facade: SystemRecordLaneFacadeBindingV1,
  ): Promise<SystemRecordApplyOutcomeV1> {
    if (
      this.current === 'shutdown' ||
      this.current === 'unavailable' ||
      this.current === 'detached'
    ) {
      return this.refuseVerifiedBeforeDispatch(proof, { outcome: 'capability-lost' });
    }
    if (this.current !== 'enabled') {
      // enabling / disabling / reconciling are all "not admitting work now".
      return this.refuseVerifiedBeforeDispatch(proof, {
        outcome: 'deferred',
        reason: 'generation-changed',
      });
    }

    // A facade names exactly one activation. Descriptor equality alone is not
    // sufficient: disabling and reopening the same descriptor creates a new
    // physical child/epoch, and an old facade must not quietly inherit it.
    if (
      facade.descriptor !== this.descriptor ||
      facade.activationGeneration !== this.activation.toString(10) ||
      facade.sessionIdentity !== this.activeSessionIdentity ||
      facade.childGeneration !== this.activeChildGeneration ||
      facade.materializationEpoch !== this.activeMaterializationEpoch
    ) {
      return this.refuseVerifiedBeforeDispatch(proof, {
        outcome: 'deferred',
        reason: 'generation-changed',
      });
    }

    const snapshot = readManagedOxigraphOwnershipSnapshotV1(this.deps.lease);
    if (!snapshot || snapshot.terminal) {
      return this.refuseVerifiedBeforeDispatch(proof, { outcome: 'capability-lost' });
    }
    if (!snapshot.ready || snapshot.childGeneration !== facade.childGeneration) {
      return this.refuseVerifiedBeforeDispatch(proof, {
        outcome: 'deferred',
        reason: 'generation-changed',
      });
    }

    const boundGeneration = snapshot.childGeneration;
    const executionBinding: SystemRecordLaneExecutionBindingV1 = Object.freeze({
      activationGeneration: facade.activationGeneration,
      networkId: facade.networkId,
      kind: facade.kind,
      mode: facade.mode,
      sessionIdentity: facade.sessionIdentity,
      childGeneration: boundGeneration,
      materializationEpoch: facade.materializationEpoch,
    });
    return this.admissions.run(
      (request) => this.registerRecoveryForInvocation(request, executionBinding),
      async (registerForInvocation) => {
      if (this.deps.executor.applyVerifiedSettlementBound) {
        const settlement = await this.deps.executor.applyVerifiedSettlementBound(
          proof,
          executionBinding,
          registerForInvocation,
        );
        // The internal carrier is authoritative. In particular, a public
        // `root-collision` may eventually include a settled quarantine mutation,
        // while an `applied` result has already been exact-postread. Neither fact
        // may be reconstructed from the public outcome spelling here.
        return settlement.outcome;
      }

      const result = this.deps.executor.applyVerifiedBound
        ? await this.deps.executor.applyVerifiedBound(proof, executionBinding)
        : await this.deps.executor.applyVerified(proof, boundGeneration);

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
        after.childGeneration === boundGeneration &&
        this.current === 'enabled' &&
        this.descriptor === facade.descriptor &&
        this.activation.toString(10) === facade.activationGeneration &&
        this.activeSessionIdentity === facade.sessionIdentity &&
        this.activeChildGeneration === facade.childGeneration &&
        this.activeMaterializationEpoch === facade.materializationEpoch;

      // Compatibility-only B2 fallback. Production B3 composition uses the
      // explicit settlement carrier above; an older injected executor can only
      // mutate on these two success outcomes. Do not extend this inference to a
      // future mutating outcome such as quarantine.
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
      },
    );
  }

  private refuseVerifiedBeforeDispatch(
    proof: unknown,
    outcome: SystemRecordApplyOutcomeV1,
  ): SystemRecordApplyOutcomeV1 {
    try {
      this.deps.executor.discardVerified?.(proof);
    } catch {
      // Discard is a reservation-release hook, not part of lifecycle outcome
      // selection. A broken implementation must not turn a fail-closed refusal
      // into an exception or admit the proof to an executor path.
    }
    return outcome;
  }

  /**
   * Transfer one ambiguous write to lifecycle recovery.
   *
   * The executor receives a separate wrapper for each invocation and calls it
   * synchronously from inside its exclusive permit. Calling `barrier` below
   * synchronously installs the scheduler seal before this method returns, even
   * though the transition itself cannot begin until that permit drains.
   */
  private registerRecoveryForInvocation(
    request: SystemRecordAtomicRecoveryRequestV1,
    executionBinding: SystemRecordLaneExecutionBindingV1,
  ): ReturnType<SystemRecordAtomicRecoveryRegistrarV1> {
    this.assertRecoveryRequestBound(request, executionBinding);
    const settlement = this.transitions.createRecoverySettlement<
      SystemRecordAtomicRecoveryResolutionV1
    >();
    const recovery: SystemRecordPendingRecoveryV1 = {
      request,
      absoluteDeadlineMs: performance.now() + SYSTEM_RECORD_RECOVERY_DEADLINE_MS_V1,
      settlement,
      exactReadAbort: new AbortController(),
      physicalSettlement: { state: 'unsettled' },
    };

    const active = this.transitions.current;
    if (active?.kind === 'disable' || active?.kind === 'shutdown') {
      if (active.recovery !== null) {
        throw new Error('system-record lifecycle already owns an uncertain write');
      }
      active.recovery = recovery;
    } else {
      if (active !== null) {
        throw new Error(`system-record ${active.kind} transition cannot accept recovery ownership`);
      }
      const state = this.readState();
      if (
        state !== 'detached' &&
        state !== 'unavailable' &&
        !this.commitState('reconciling')
      ) {
        throw new Error('system-record terminal lane cannot enqueue recovery');
      }
      const work = createSystemRecordDeferredV1<void>();
      const entry: Extract<SystemRecordLaneTransitionV1, { kind: 'recovery' }> = {
        kind: 'recovery',
        descriptor: null,
        recovery,
        shutdownTeardownComplete: false,
        work: work.promise,
        physicalWork: null,
        physicalSettled: false,
      };
      this.transitions.startRecovery(entry);
      const operation = this.runRecovery(entry);
      void operation.then(work.resolve, work.reject);
      // Recovery is intentionally detached from the original sync call after
      // ownership transfer, but never allowed to reject unobserved.
      void entry.work.finally(() => {
        if (entry.recovery.settlement.settled) this.release(entry);
      }).catch(() => undefined);
    }

    return Object.freeze({
      ownership: request.ownership,
      recoveryGeneration: settlement.recoveryGeneration,
      completion: settlement.completion,
    });
  }

  private async runRecovery(
    entry: Extract<SystemRecordLaneTransitionV1, { kind: 'recovery' }>,
  ): Promise<void> {
    try {
      await this.deps.barrier('system-record.recovery', () => {
        const physicalWork = (async () => {
          try {
            const result = await this.recoverInsideBarrier(entry.recovery, 'resume');
            entry.shutdownTeardownComplete = result.shutdownTeardownComplete;
            if (result.resolution === 'unavailable') {
              this.failManagedMutationsClosed('uncertain write recovery did not settle exactly');
              if (this.readState() !== 'shutdown') {
                this.commitState('unavailable');
                this.descriptor = null;
                this.clearActiveBinding();
              }
              return;
            }

            // Disable/shutdown intent may latch under any await above. It owns the
            // tail and must never be overwritten by a recovery continuation.
            if (this.readState() !== 'reconciling') return;
            // Publish the replacement binding BEFORE this barrier releases its
            // scheduler seal. No await separates these writes, so no admission can
            // observe a proven replacement listener with the retired binding.
            // Epoch/activation stay unchanged because exact settlement was read at
            // that epoch; a fresh identity + child makes old facades stale.
            this.activeSessionIdentity = Object.freeze(Object.create(null) as object);
            this.activeChildGeneration = result.childGeneration;
            this.activeFacade = null;
            this.commitState('enabled');
          } finally {
            entry.physicalSettled = true;
          }
        })();
        entry.physicalWork = physicalWork;
        return physicalWork;
      });
    } catch {
      // A transition timeout reports before the scheduler callback settles.
      // Retain its ownership and the executor's proof reservation until that
      // callback reaches a physical result. A callback that ignores abort can
      // therefore keep this promise pending until process exit by design.
      if (entry.physicalWork) {
        try {
          await entry.physicalWork;
          return;
        } catch {
          // Fall through only after the physical callback itself rejected.
        }
      }
      this.failManagedMutationsClosed('uncertain write recovery transition failed');
      if (entry.recovery.physicalSettlement.state === 'all-generations-dead') {
        this.settleRecovery(entry.recovery, Object.freeze({ resolution: 'unavailable' }));
      }
      if (this.readState() !== 'shutdown') {
        this.commitState('unavailable');
        this.descriptor = null;
        this.clearActiveBinding();
      }
    }
  }

  private async recoverInsideBarrier(
    recovery: SystemRecordPendingRecoveryV1,
    intent: 'resume' | 'disable' | 'shutdown',
  ): Promise<{
    readonly resolution: SystemRecordAtomicRecoveryResolutionV1['resolution'];
    readonly childGeneration: string;
    readonly physicallySettled: boolean;
    readonly shutdownTeardownComplete: boolean;
  }> {
    let childGeneration = recovery.request.binding.childGeneration;
    try {
      // The old request has already left its scheduler permit. Prove its child
      // dead first, then destroy/drain the generation-owned client and every
      // retained promise before a replacement listener can bind the port.
      await this.retireRecoveryGeneration(recovery);

      if (intent === 'shutdown' || this.readState() === 'shutdown') {
        recovery.physicalSettlement.state = 'all-generations-dead';
        const unavailable = Object.freeze({ resolution: 'unavailable' as const });
        this.settleRecovery(recovery, unavailable);
        return {
          resolution: 'unavailable',
          childGeneration,
          physicallySettled: true,
          shutdownTeardownComplete: true,
        };
      }

      this.assertRecoveryDeadline(recovery, 'replacement start');
      // Starting is a physical side effect before its promise can settle. Mark
      // it conservatively live first so a synchronous spawn error, readiness
      // timeout, or ownership-proof failure still drives stop/prove cleanup.
      recovery.physicalSettlement.state = 'replacement-live';
      await this.deps.handoff.startAndProveCleanGeneration(recovery.absoluteDeadlineMs);
      const owned = readManagedOxigraphOwnershipSnapshotV1(this.deps.lease);
      if (!owned || owned.terminal || !owned.ready) {
        throw new Error('system-record recovery did not bind a proven-ready child');
      }
      childGeneration = owned.childGeneration;
      const createRuntime = this.deps.handoff.createRecoveryRuntime;
      if (!createRuntime) {
        throw new Error('system-record exact recovery runtime is unavailable');
      }
      const binding = Object.freeze({
        ...recovery.request.binding,
        childGeneration,
      });
      const supplied = createRuntime(
        binding,
        recovery.absoluteDeadlineMs,
        recovery.exactReadAbort.signal,
      );
      if (
        supplied.client.childGeneration !== childGeneration ||
        supplied.absoluteDeadlineMs !== recovery.absoluteDeadlineMs ||
        supplied.signal !== recovery.exactReadAbort.signal
      ) {
        throw new Error(
          'system-record recovery runtime is bound to the wrong generation/deadline/signal',
        );
      }
      const runtime: SystemRecordAtomicRecoveryRuntimeV1 = Object.freeze({
        ...supplied,
        assertAttributable: () => {
          const current = readManagedOxigraphOwnershipSnapshotV1(this.deps.lease);
          return (
            this.readState() !== 'shutdown' &&
            current !== null &&
            !current.terminal &&
            current.ready &&
            current.childGeneration === childGeneration &&
            supplied.assertAttributable()
          );
        },
      });
      this.assertRecoveryDeadline(recovery, 'exact reconciliation');
      const resolution = await recovery.request.reconcile(runtime);
      if (this.readState() === 'shutdown' || resolution.resolution === 'unavailable') {
        // A replacement was made externally reachable, so an unsuccessful
        // exact read cannot merely mark the lane unavailable and return. Reap
        // that replacement under the SAME deadline before the barrier seal is
        // released; otherwise ordinary writes can hit a child whose reserved
        // state has not been classified as prior or next.
        await this.settleRecoveryPhysicalDead(recovery);
        const unavailable = Object.freeze({ resolution: 'unavailable' as const });
        this.settleRecovery(recovery, unavailable);
        return {
          resolution: 'unavailable',
          childGeneration,
          physicallySettled: true,
          shutdownTeardownComplete: this.readState() === 'shutdown',
        };
      }
      this.settleRecovery(recovery, resolution);
      return {
        resolution: resolution.resolution,
        childGeneration,
        physicallySettled: true,
        shutdownTeardownComplete: false,
      };
    } catch {
      recovery.exactReadAbort.abort(new Error('system-record exact recovery failed'));
      try {
        await this.settleRecoveryPhysicalDead(recovery);
      } catch {
        this.failManagedMutationsClosed('recovery child could not be proven dead');
      }
      const unavailable = Object.freeze({ resolution: 'unavailable' as const });
      // An executor may release its charged proof only after exact attribution
      // or proof that every possibly-addressed generation is dead. If teardown
      // itself fails, leave completion pending and the charge terminally owned
      // until process exit.
      if (recovery.physicalSettlement.state === 'all-generations-dead') {
        this.settleRecovery(recovery, unavailable);
      }
      return {
        resolution: 'unavailable',
        childGeneration,
        physicallySettled:
          recovery.physicalSettlement.state === 'all-generations-dead',
        shutdownTeardownComplete:
          this.readState() === 'shutdown' &&
          recovery.physicalSettlement.state === 'all-generations-dead',
      };
    }
  }

  private async retireRecoveryGeneration(
    recovery: SystemRecordPendingRecoveryV1,
    terminalCleanup = false,
  ): Promise<void> {
    const deadline = terminalCleanup ? undefined : recovery.absoluteDeadlineMs;
    if (recovery.physicalSettlement.state === 'unsettled'
        || recovery.physicalSettlement.state === 'replacement-live') {
      if (!terminalCleanup) this.assertRecoveryDeadline(recovery, 'owned child stop');
      await this.deps.handoff.stopAndProveOwnedChildDead(deadline);
      recovery.physicalSettlement.state = 'owned-child-dead';
    }
    if (recovery.physicalSettlement.state === 'owned-child-dead') {
      if (!terminalCleanup) this.assertRecoveryDeadline(recovery, 'retired client destroy');
      await this.deps.handoff.destroyClient(deadline);
      if (!terminalCleanup) this.assertRecoveryDeadline(recovery, 'retired work drain');
      await this.deps.handoff.awaitRetiredWork(deadline);
      recovery.physicalSettlement.state = 'old-generation-dead';
    }
  }

  private async settleRecoveryPhysicalDead(
    recovery: SystemRecordPendingRecoveryV1,
  ): Promise<void> {
    if (recovery.physicalSettlement.state === 'all-generations-dead') return;
    // The operational deadline may already have expired while an attributable
    // exact read was in flight. Terminal teardown is safety work, not a retry:
    // retain the barrier and run it to physical settlement without passing an
    // already-expired deadline that would skip the stop/drain proof.
    await this.retireRecoveryGeneration(recovery, true);
    if (recovery.physicalSettlement.state !== 'old-generation-dead') {
      throw new Error('system-record recovery could not prove every child generation dead');
    }
    recovery.physicalSettlement.state = 'all-generations-dead';
  }

  private assertRecoveryDeadline(
    recovery: SystemRecordPendingRecoveryV1,
    phase: string,
  ): void {
    if (performance.now() >= recovery.absoluteDeadlineMs) {
      throw new Error(`system-record recovery deadline expired before ${phase}`);
    }
  }

  private recoveryOf(
    transition: SystemRecordLaneTransitionV1 | null,
  ): SystemRecordPendingRecoveryV1 | null {
    if (transition === null || transition.kind === 'open') return null;
    return transition.recovery;
  }

  private transitionSettlement(transition: SystemRecordLaneTransitionV1): Promise<void> {
    return transition.kind === 'disable' || transition.kind === 'shutdown'
      ? transition.settlement
      : transition.work;
  }

  private failManagedMutationsClosed(reason: string): void {
    try {
      this.deps.handoff.failManagedMutationsClosed?.(reason);
    } catch {
      // The callback is specified as a synchronous latch. A broken adapter must
      // not replace the original lifecycle failure or make the lane look less
      // terminal; `unavailable`/`shutdown` still deny the structured path.
    }
  }

  private settleRecovery(
    recovery: SystemRecordPendingRecoveryV1,
    resolution: SystemRecordAtomicRecoveryResolutionV1,
  ): void {
    recovery.settlement.settle(Object.freeze(resolution));
  }

  private assertRecoveryRequestBound(
    request: SystemRecordAtomicRecoveryRequestV1,
    executionBinding: SystemRecordLaneExecutionBindingV1,
  ): void {
    if (
      request === null ||
      typeof request !== 'object' ||
      request.ownership === null ||
      typeof request.ownership !== 'object' ||
      typeof request.reconcile !== 'function' ||
      request.binding !== executionBinding
    ) {
      throw new Error('system-record recovery request is not bound to the admitted apply invocation');
    }
  }

  private createFacade(
    descriptor: string,
    activation: Readonly<{
      networkId: string;
      kind: 'agents';
      mode: 'shadow' | 'authoritative';
    }>,
  ): SystemRecordLaneSessionV1 {
    if (
      this.current !== 'enabled' ||
      this.descriptor !== descriptor ||
      this.activeSessionIdentity === null ||
      this.activeChildGeneration === null ||
      this.activeMaterializationEpoch === null
    ) {
      throw new Error('system-record lane activation changed before facade publication');
    }
    if (this.activeFacade !== null) return this.activeFacade;
    this.activeFacade = new SystemRecordLaneFacade(this, Object.freeze({
      descriptor,
      activationGeneration: this.activation.toString(10),
      ...activation,
      sessionIdentity: this.activeSessionIdentity,
      childGeneration: this.activeChildGeneration,
      materializationEpoch: this.activeMaterializationEpoch,
    }));
    return this.activeFacade;
  }

  private clearActiveBinding(): void {
    this.activeNetworkId = null;
    this.activeSessionIdentity = null;
    this.activeChildGeneration = null;
    this.activeMaterializationEpoch = null;
    this.activeFacade = null;
  }

  /**
   * The owning store closed. Latch terminal WITHOUT touching the child.
   *
   * Synchronous, for the same reason `runShutdown` is not `async`: an intent
   * that only becomes visible after an await is an intent every concurrent
   * caller gets to race. A store can close at ANY point of ANY transition, so
   * `commitState` refuses every continuation that resumes afterwards — a
   * `runEnable` about to publish `enabled`, a `runDisable` about to publish
   * `disabled`, an `applyVerified` about to seal `reconciling`.
   *
   * It asserts nothing physical. It does not destroy the client, stop the child
   * or prove a port released: the adapter never owned the child, and the daemon
   * supervisor that does stops it itself. A second stop-and-prove from here is
   * the double process signal `runShutdown` documents as unsafe — which is why
   * the committed state is `detached` and not `shutdown`. Only `shutdown`
   * claims the child was proven dead, and a detach cannot make that claim.
   *
   * It joins every transition that can still manipulate the managed child, and
   * follows a successor installed by a continuation that was already suspended
   * when detach latched. Releasing the process-global writer slot before those
   * transitions physically settle would admit a second writer over that child.
   */
  detach(): Promise<void> {
    // A completed or in-flight shutdown made the STRONGER claim; overwriting it
    // with `detached` would downgrade the record of what was established.
    if (this.readState() !== 'shutdown') this.current = 'detached';
    if (this.detachSettlement) return this.detachSettlement;
    this.detachSettlement = this.finishDetach();
    // A caller can abandon disposal after a sibling failure. Keep the shared
    // settlement observed without changing what present or later callers join.
    void this.detachSettlement.catch(() => undefined);
    return this.detachSettlement;
  }

  private async finishDetach(): Promise<void> {
    await this.admissions.drain();

    // Recovery registration is synchronous inside the executor permit. Once
    // the admitted cohort drains, every transition capable of touching the
    // child is owned by this explicit settlement chain, including successors
    // published while an earlier transition was suspended.
    await this.transitions.drainForDetach();

    this.descriptor = null;
    this.clearActiveBinding();
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
  private release(entry: SystemRecordLaneTransitionV1): void {
    this.transitions.release(entry);
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
    if (
      this.readState() === 'shutdown' ||
      this.readState() === 'unavailable' ||
      this.readState() === 'detached'
    ) return false;
    this.current = next;
    if (next === 'enabling') this.deps.setAdmissionActive?.(true);
    if (next === 'disabled' || next === 'unavailable') {
      this.deps.setAdmissionActive?.(false);
    }
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
    if (state === 'shutdown' || state === 'unavailable' || state === 'detached') {
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
  private readTransition(): SystemRecordLaneTransitionV1 | null {
    return this.transitions.current;
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
