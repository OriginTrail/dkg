import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createManagedOxigraphOwnershipControllerV1,
  readManagedOxigraphOwnershipSnapshotV1,
  type ManagedOxigraphOwnershipControllerV1,
} from '../src/managed-oxigraph-ownership-v1-internal.js';
import {
  SystemRecordControllerRegistrationError,
  SystemRecordLaneActivationConflictError,
  __resetSystemRecordControllerRegistrationForTests,
  createSystemRecordLaneControllerV1,
  releaseSystemRecordLaneControllerV1,
  type SystemRecordApplyOutcomeV1,
  type SystemRecordChildHandoffV1,
  type SystemRecordLaneActivationV1,
  type SystemRecordLaneExecutionBindingV1,
  type SystemRecordLaneSessionV1,
} from '../src/system-record-materializer-v1.js';
import type {
  SystemRecordAtomicApplySettlementV1,
  SystemRecordAtomicRecoveryRegistrarV1,
  SystemRecordAtomicRecoveryRegistrationV1,
  SystemRecordAtomicRecoveryResolutionV1,
  SystemRecordAtomicRecoveryRuntimeV1,
} from '../src/system-record-atomic-apply-executor-v1-internal.js';
import {
  expectSystemRecordControllerSlotRetainedV1,
  nextSystemRecordLifecycleTurnV1,
  releaseReplacementSystemRecordControllerV1,
  trackSystemRecordControllerReleaseV1,
} from './helpers/system-record-lifecycle-race-v1.js';

const ACTIVATION: SystemRecordLaneActivationV1 = {
  networkId: 'testnet',
  kinds: ['agents'],
  mode: 'shadow',
};

const OWNERSHIP_QUERY_ENDPOINT = 'http://127.0.0.1:7878/query';
const OWNERSHIP_UPDATE_ENDPOINT = 'http://127.0.0.1:7878/update';

/** Records the exact handoff order so the ordering invariant is observable. */
class RecordingHandoff implements SystemRecordChildHandoffV1 {
  readonly calls: string[] = [];
  failAt: string | null = null;
  barrier: RecordingBarrier | null = null;

  protected async step(name: string): Promise<void> {
    this.calls.push(name);
    this.barrier?.note(name);
    if (this.failAt === name) throw new Error(`handoff failed at ${name}`);
  }

  destroyClient = () => this.step('destroyClient');
  stopAndProveOwnedChildDead = () => this.step('stopAndProveOwnedChildDead');
  awaitRetiredWork = () => this.step('awaitRetiredWork');
  startAndProveCleanGeneration = () => this.step('startAndProveCleanGeneration');
  failManagedMutationsClosed = (reason: string) => {
    this.calls.push(`failManagedMutationsClosed:${reason}`);
  };
  private epoch = 0;
  rotateMaterializationEpoch = async (_networkId?: string) => {
    await this.step('rotateMaterializationEpoch');
    this.epoch += 1;
    return Object.freeze({ epoch: String(this.epoch), childGeneration: '1' });
  };
}

/**
 * Pass-through stand-in for the scheduler's control barrier.
 *
 * It records the purpose of every transition AND brackets it, so a test can
 * assert that a handoff step ran INSIDE an exclusive section rather than merely
 * that a barrier was requested somewhere. `sections` holds one entry per
 * transition; `depth` catches a nested barrier, which the scheduler refcounts
 * but which the lane must never need.
 */
class RecordingBarrier {
  readonly sections: Array<{ purpose: string; inside: string[] }> = [];
  depth = 0;
  maxDepth = 0;
  failWith: Error | null = null;

  private active: { purpose: string; inside: string[] } | null = null;

  /** Called by the handoff stub so each step lands in its enclosing section. */
  note(step: string): void {
    this.active?.inside.push(step);
  }

  run = async <T>(purpose: string, transition: () => Promise<T>): Promise<T> => {
    if (this.failWith) throw this.failWith;
    const section = { purpose, inside: [] as string[] };
    this.sections.push(section);
    const previous = this.active;
    this.active = section;
    this.depth += 1;
    this.maxDepth = Math.max(this.maxDepth, this.depth);
    try {
      return await transition();
    } finally {
      this.depth -= 1;
      this.active = previous;
    }
  };

  get purposes(): string[] {
    return this.sections.map((s) => s.purpose);
  }
}

class StubExecutor {
  outcome: SystemRecordApplyOutcomeV1 = {
    outcome: 'applied',
    stateRevision: '1',
    appliedStateDigest: `0x${'a'.repeat(64)}`,
  };

  calls: SystemRecordLaneExecutionBindingV1[] = [];
  discarded: unknown[] = [];
  onDispatch?: () => void;

  discardVerified = (proof: unknown): void => {
    this.discarded.push(proof);
  };

  /** Park the dispatch so a whole lifecycle transition can run underneath it. */
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;
  private reachedGate: (() => void) | null = null;
  dispatched: Promise<void> = Promise.resolve();

  park(): void {
    this.gate = new Promise<void>((r) => { this.releaseGate = r; });
    this.dispatched = new Promise<void>((r) => { this.reachedGate = r; });
  }

  release(): void {
    this.releaseGate?.();
  }

  async applyVerified(_proof: unknown, childGeneration: string): Promise<SystemRecordApplyOutcomeV1> {
    return this.dispatch({
      activationGeneration: 'legacy',
      networkId: 'legacy',
      kind: 'agents',
      mode: 'shadow',
      sessionIdentity: Object.freeze(Object.create(null) as object),
      childGeneration,
      materializationEpoch: '0',
    });
  }

  async applyVerifiedBound(
    _proof: unknown,
    binding: SystemRecordLaneExecutionBindingV1,
  ): Promise<SystemRecordApplyOutcomeV1> {
    return this.dispatch(binding);
  }

  private async dispatch(
    binding: SystemRecordLaneExecutionBindingV1,
  ): Promise<SystemRecordApplyOutcomeV1> {
    this.calls.push(binding);
    this.onDispatch?.();
    if (this.gate) {
      this.reachedGate?.();
      await this.gate;
    }
    return this.outcome;
  }
}

class AtomicRecoveryExecutor extends StubExecutor {
  settlement: 'uncertain' | 'no-mutation' = 'uncertain';
  noMutationOutcome: SystemRecordApplyOutcomeV1 = { outcome: 'stale' };
  recoveryResolution: SystemRecordAtomicRecoveryResolutionV1 = {
    resolution: 'applied',
    stateRevision: '2',
    appliedStateDigest: `0x${'2'.repeat(64)}`,
  };
  registration: SystemRecordAtomicRecoveryRegistrationV1 | null = null;
  recoveredRuntime: SystemRecordAtomicRecoveryRuntimeV1 | null = null;

  private beforeRegistrationGate: Promise<void> | null = null;
  private releaseBeforeRegistration: (() => void) | null = null;
  private reachedBeforeRegistration: (() => void) | null = null;
  registrationReached: Promise<void> = Promise.resolve();
  private reconcileGate: Promise<void> | null = null;
  private releaseReconcileGate: (() => void) | null = null;
  private reachedReconcile: (() => void) | null = null;
  reconcileReached: Promise<void> = Promise.resolve();
  private waitForReconcileAbort = false;

  parkBeforeRegistration(): void {
    this.beforeRegistrationGate = new Promise<void>((resolve) => {
      this.releaseBeforeRegistration = resolve;
    });
    this.registrationReached = new Promise<void>((resolve) => {
      this.reachedBeforeRegistration = resolve;
    });
  }

  releaseRegistration(): void {
    this.releaseBeforeRegistration?.();
  }

  parkReconcile(): void {
    this.reconcileGate = new Promise<void>((resolve) => {
      this.releaseReconcileGate = resolve;
    });
    this.reconcileReached = new Promise<void>((resolve) => {
      this.reachedReconcile = resolve;
    });
  }

  releaseReconcile(): void {
    this.releaseReconcileGate?.();
  }

  parkReconcileUntilAbort(): void {
    this.waitForReconcileAbort = true;
    this.reconcileReached = new Promise<void>((resolve) => {
      this.reachedReconcile = resolve;
    });
  }

  async applyVerifiedSettlementBound(
    _proof: unknown,
    binding: SystemRecordLaneExecutionBindingV1,
    registerRecovery: SystemRecordAtomicRecoveryRegistrarV1,
  ): Promise<SystemRecordAtomicApplySettlementV1> {
    this.calls.push(binding);
    this.onDispatch?.();
    if (this.settlement === 'no-mutation') {
      return Object.freeze({ settlement: 'no-mutation', outcome: this.noMutationOutcome }) as never;
    }
    if (this.beforeRegistrationGate) {
      this.reachedBeforeRegistration?.();
      await this.beforeRegistrationGate;
    }
    const ownership = Object.freeze(Object.create(null) as object);
    const registration = registerRecovery(Object.freeze({
      ownership,
      binding,
      reconcile: async (runtime: SystemRecordAtomicRecoveryRuntimeV1) => {
        this.recoveredRuntime = runtime;
        if (this.waitForReconcileAbort) {
          this.reachedReconcile?.();
          if (!runtime.signal.aborted) {
            await new Promise<void>((resolve) => {
              runtime.signal.addEventListener('abort', () => resolve(), { once: true });
            });
          }
          return { resolution: 'unavailable' };
        }
        if (this.reconcileGate) {
          this.reachedReconcile?.();
          await this.reconcileGate;
        }
        return this.recoveryResolution;
      },
    }));
    this.registration = registration;
    return Object.freeze({
      settlement: 'recovery-owned',
      outcome: Object.freeze({
        outcome: 'indeterminate',
        recoveryGeneration: registration.recoveryGeneration,
      }),
      recovery: registration,
    });
  }
}

class CapturingSettlementExecutor extends StubExecutor {
  registrar: SystemRecordAtomicRecoveryRegistrarV1 | null = null;
  binding: SystemRecordLaneExecutionBindingV1 | null = null;

  async applyVerifiedSettlementBound(
    _proof: unknown,
    binding: SystemRecordLaneExecutionBindingV1,
    registerRecovery: SystemRecordAtomicRecoveryRegistrarV1,
  ): Promise<SystemRecordAtomicApplySettlementV1> {
    this.calls.push(binding);
    this.binding = binding;
    this.registrar = registerRecovery;
    return Object.freeze({
      settlement: 'no-mutation',
      outcome: Object.freeze({ outcome: 'stale' }),
    });
  }
}

class MismatchedBindingExecutor extends StubExecutor {
  registrationError: unknown = null;
  retryError: unknown = null;

  async applyVerifiedSettlementBound(
    _proof: unknown,
    binding: SystemRecordLaneExecutionBindingV1,
    registerRecovery: SystemRecordAtomicRecoveryRegistrarV1,
  ): Promise<SystemRecordAtomicApplySettlementV1> {
    this.calls.push(binding);
    try {
      registerRecovery(Object.freeze({
        ownership: Object.freeze(Object.create(null) as object),
        binding: Object.freeze({ ...binding }),
        reconcile: async () => Object.freeze({ resolution: 'unavailable' as const }),
      }));
    } catch (error) {
      this.registrationError = error;
    }
    try {
      registerRecovery(Object.freeze({
        ownership: Object.freeze(Object.create(null) as object),
        binding,
        reconcile: async () => Object.freeze({ resolution: 'unavailable' as const }),
      }));
    } catch (error) {
      this.retryError = error;
    }
    return Object.freeze({
      settlement: 'no-mutation',
      outcome: Object.freeze({ outcome: 'stale' }),
    });
  }
}

class RejectingSettlementExecutor extends StubExecutor {
  registration: SystemRecordAtomicRecoveryRegistrationV1 | null = null;

  constructor(private readonly registerBeforeReject: boolean) {
    super();
  }

  async applyVerifiedSettlementBound(
    _proof: unknown,
    binding: SystemRecordLaneExecutionBindingV1,
    registerRecovery: SystemRecordAtomicRecoveryRegistrarV1,
  ): Promise<SystemRecordAtomicApplySettlementV1> {
    this.calls.push(binding);
    if (this.registerBeforeReject) {
      this.registration = registerRecovery(Object.freeze({
        ownership: Object.freeze(Object.create(null) as object),
        binding,
        reconcile: async () => Object.freeze({
          resolution: 'applied' as const,
          stateRevision: '2',
          appliedStateDigest: `0x${'2'.repeat(64)}`,
        }),
      }));
    }
    throw new Error('settlement executor rejected');
  }
}

class RecoveryHandoff extends RecordingHandoff {
  private epoch = 0;
  readonly recoveryDeadlines: Array<{ phase: string; value: number | undefined }> = [];

  constructor(private readonly ownership: ManagedOxigraphOwnershipControllerV1) {
    super();
  }

  override stopAndProveOwnedChildDead = async (absoluteDeadlineMs?: number): Promise<void> => {
    this.recoveryDeadlines.push({ phase: 'stop', value: absoluteDeadlineMs });
    await this.step('stopAndProveOwnedChildDead');
  };

  override destroyClient = async (absoluteDeadlineMs?: number): Promise<void> => {
    this.recoveryDeadlines.push({ phase: 'destroy', value: absoluteDeadlineMs });
    await this.step('destroyClient');
  };

  override awaitRetiredWork = async (absoluteDeadlineMs?: number): Promise<void> => {
    this.recoveryDeadlines.push({ phase: 'drain', value: absoluteDeadlineMs });
    await this.step('awaitRetiredWork');
  };

  override startAndProveCleanGeneration = async (absoluteDeadlineMs?: number): Promise<void> => {
    this.recoveryDeadlines.push({ phase: 'start', value: absoluteDeadlineMs });
    await this.step('startAndProveCleanGeneration');
    // Initial enable already has generation 1. Every later start is a
    // controlled recovery/re-enable and must bind a genuinely new listener.
    if (this.epoch > 0) {
      this.ownership.invalidate('child-exit');
      this.ownership.bindReadyGeneration();
    }
  };

  override rotateMaterializationEpoch = async (_networkId?: string) => {
    await this.step('rotateMaterializationEpoch');
    this.epoch += 1;
    const snapshot = readManagedOxigraphOwnershipSnapshotV1(this.ownership.lease);
    if (!snapshot?.ready) throw new Error('test ownership is not ready');
    return Object.freeze({ epoch: String(this.epoch), childGeneration: snapshot.childGeneration });
  };

  override createRecoveryRuntime = (
    binding: SystemRecordLaneExecutionBindingV1,
    absoluteDeadlineMs: number,
    signal: AbortSignal,
  ): SystemRecordAtomicRecoveryRuntimeV1 => {
    this.recoveryDeadlines.push({ phase: 'exact-read', value: absoluteDeadlineMs });
    this.calls.push('createRecoveryRuntime');
    this.barrier?.note('createRecoveryRuntime');
    if (this.failAt === 'createRecoveryRuntime') {
      throw new Error('handoff failed at createRecoveryRuntime');
    }
    return Object.freeze({
      client: {
        childGeneration: binding.childGeneration,
        isDestroyed: false,
        post: async () => { throw new Error('test recovery callback owns the read'); },
      },
      queryEndpoint: OWNERSHIP_QUERY_ENDPOINT,
      absoluteDeadlineMs,
      signal,
      assertAttributable: () => {
        const snapshot = readManagedOxigraphOwnershipSnapshotV1(this.ownership.lease);
        return Boolean(snapshot?.ready && snapshot.childGeneration === binding.childGeneration);
      },
    });
  };
}

class GateBarrier extends RecordingBarrier {
  private readonly gates = new Map<string, Promise<void>>();
  private readonly releases = new Map<string, () => void>();
  private readonly arrivals = new Map<string, Promise<void>>();
  private readonly arrived = new Map<string, () => void>();

  constructor() {
    super();
    const recordAndRun = this.run;
    this.run = async <T>(purpose: string, transition: () => Promise<T>): Promise<T> => {
      const gate = this.gates.get(purpose);
      if (gate) {
        this.arrived.get(purpose)?.();
        await gate;
      }
      return recordAndRun(purpose, transition);
    };
  }

  gate(purpose: string): void {
    let release!: () => void;
    this.gates.set(purpose, new Promise<void>((resolve) => { release = resolve; }));
    this.releases.set(purpose, release);
    let arrive!: () => void;
    this.arrivals.set(purpose, new Promise<void>((resolve) => { arrive = resolve; }));
    this.arrived.set(purpose, arrive);
  }

  reached(purpose: string): Promise<void> {
    return this.arrivals.get(purpose) ?? Promise.resolve();
  }

  release(purpose: string): void {
    this.releases.get(purpose)?.();
  }

}

/** Parks after a transition callback settles but before its barrier releases. */
class SettlementTailGateBarrier extends RecordingBarrier {
  private releaseTail!: () => void;
  private readonly tail = new Promise<void>((resolve) => { this.releaseTail = resolve; });
  private reachedTail!: () => void;
  readonly tailReached = new Promise<void>((resolve) => { this.reachedTail = resolve; });

  constructor(private readonly gatedPurpose: string) {
    super();
    const recordAndRun = this.run;
    this.run = async <T>(purpose: string, transition: () => Promise<T>): Promise<T> => {
      const result = await recordAndRun(purpose, transition);
      if (purpose === this.gatedPurpose) {
        this.reachedTail();
        await this.tail;
      }
      return result;
    };
  }

  release(): void {
    this.releaseTail();
  }
}

/**
 * Scheduler-faithful transition-timeout model.
 *
 * Like `StorePriorityScheduler.runControlBarrier`, the public promise can
 * reject after the callback started while the callback and exclusive section
 * remain alive until their own promise settles.
 */
class TransitionTimeoutBarrier extends RecordingBarrier {
  physicalSettled = false;
  private readonly rejects = new Map<string, (reason: unknown) => void>();

  constructor() {
    super();
    const recordAndRun = this.run;
    this.run = <T>(purpose: string, transition: () => Promise<T>): Promise<T> => {
      if (
        purpose !== 'system-record.shutdown' &&
        purpose !== 'system-record.disable' &&
        purpose !== 'system-record.recovery'
      ) return recordAndRun(purpose, transition);

      const physical = recordAndRun(purpose, transition);
      void physical.finally(() => { this.physicalSettled = true; }).catch(() => undefined);
      return new Promise<T>((resolve, reject) => {
        this.rejects.set(purpose, reject);
        physical.then(resolve, reject);
      });
    };
  }

  timeoutShutdown(): void {
    this.timeout('system-record.shutdown');
  }

  timeout(purpose: string): void {
    this.rejects.get(purpose)?.(new Error('STORE_CONTROL_BARRIER_TRANSITION_TIMEOUT'));
  }
}

/** Models the scheduler rejecting before a selected callback is admitted. */
class WaitPhaseTimeoutBarrier extends RecordingBarrier {
  constructor(private readonly rejectedPurpose = 'system-record.shutdown') {
    super();
    const recordAndRun = this.run;
    this.run = <T>(purpose: string, transition: () => Promise<T>): Promise<T> => {
      if (purpose === this.rejectedPurpose) {
        return Promise.reject(new Error('STORE_CONTROL_BARRIER_WAIT_TIMEOUT'));
      }
      return recordAndRun(purpose, transition);
    };
  }
}

/** Holds the wait phase so recovery can attach before the timeout is reported. */
class ControlledWaitPhaseTimeoutBarrier extends RecordingBarrier {
  private rejectWait!: (reason: unknown) => void;
  private reachedWait!: () => void;
  readonly waitReached = new Promise<void>((resolve) => { this.reachedWait = resolve; });

  constructor(private readonly rejectedPurpose: string) {
    super();
    const recordAndRun = this.run;
    this.run = <T>(purpose: string, transition: () => Promise<T>): Promise<T> => {
      if (purpose !== this.rejectedPurpose) return recordAndRun(purpose, transition);
      this.reachedWait();
      return new Promise<T>((_resolve, reject) => { this.rejectWait = reject; });
    };
  }

  timeout(): void {
    this.rejectWait(new Error('STORE_CONTROL_BARRIER_WAIT_TIMEOUT'));
  }
}

describe('system-record lane session lifecycle V1', () => {
  let ownership: ManagedOxigraphOwnershipControllerV1;
  let handoff: RecordingHandoff;
  let executor: StubExecutor;
  let barrier: RecordingBarrier;

  const build = () => {
    const controller = createSystemRecordLaneControllerV1({
      lease: ownership.lease,
      handoff,
      executor,
      barrier: barrier.run,
    });
    return controller;
  };

  beforeEach(() => {
    __resetSystemRecordControllerRegistrationForTests();
    ownership = createManagedOxigraphOwnershipControllerV1(
      OWNERSHIP_QUERY_ENDPOINT,
      OWNERSHIP_UPDATE_ENDPOINT,
    );
    ownership.bindReadyGeneration();
    barrier = new RecordingBarrier();
    handoff = new RecordingHandoff();
    handoff.barrier = barrier;
    executor = new StubExecutor();
  });

  afterEach(() => {
    __resetSystemRecordControllerRegistrationForTests();
  });

  describe('default-off', () => {
    it('performs no handoff, epoch or dispatch work merely by existing', async () => {
      build();
      expect(handoff.calls).toEqual([]);
      expect(executor.calls).toEqual([]);
    });
  });

  describe('enable', () => {
    it('proves the old generation dead before starting a clean one', async () => {
      const session = await build().open(ACTIVATION);

      // Order is the invariant, not merely the set: a replacement started
      // before the old child is proven dead would allow a retired request to
      // reach the new listener.
      expect(handoff.calls).toEqual([
        'destroyClient',
        'stopAndProveOwnedChildDead',
        'awaitRetiredWork',
        'startAndProveCleanGeneration',
        'rotateMaterializationEpoch',
      ]);
      expect(session.state).toBe('enabled');
      expect(session.activationGeneration).toBe('1');
    });

    it('coalesces concurrent same-descriptor opens into one handoff', async () => {
      const controller = build();
      const [a, b, c] = await Promise.all([
        controller.open(ACTIVATION),
        controller.open(ACTIVATION),
        controller.open(ACTIVATION),
      ]);

      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(handoff.calls.filter((s) => s === 'startAndProveCleanGeneration')).toHaveLength(1);
      expect(a.activationGeneration).toBe('1');
      expect(b.activationGeneration).toBe('1');
      expect(c.activationGeneration).toBe('1');
      expect((await a.applyVerified({})).outcome).toBe('applied');
      expect((await b.applyVerified({})).outcome).toBe('applied');
      expect(executor.calls.map((call) => call.activationGeneration)).toEqual(['1', '1']);
    });

    it('is idempotent for a repeated same-descriptor open', async () => {
      const controller = build();
      const first = await controller.open(ACTIVATION);
      const second = await controller.open(ACTIVATION);
      expect(second).toBe(first);
      expect(second.activationGeneration).toBe('1');
      expect(handoff.calls.filter((s) => s === 'rotateMaterializationEpoch')).toHaveLength(1);
    });

    it('refuses an incompatible descriptor instead of silently reconfiguring', async () => {
      const controller = build();
      await controller.open(ACTIVATION);
      await expect(
        controller.open({ ...ACTIVATION, mode: 'authoritative' }),
      ).rejects.toThrow(SystemRecordLaneActivationConflictError);
    });

    it('snapshots a closed activation without invoking caller accessors or iterators', async () => {
      let accessorCalls = 0;
      const accessorBacked = Object.create(null) as Record<string, unknown>;
      Object.defineProperties(accessorBacked, {
        networkId: {
          enumerable: true,
          get: () => { accessorCalls += 1; return 'testnet'; },
        },
        kinds: { enumerable: true, value: ['agents'] },
        mode: { enumerable: true, value: 'shadow' },
      });

      await expect(build().open(accessorBacked as never)).rejects.toThrow(/data properties/);
      expect(accessorCalls).toBe(0);
      expect(handoff.calls).toEqual([]);
    });

    it('rejects proxied activation records and kinds before invoking traps', async () => {
      const controller = build();
      let objectTrapCalls = 0;
      const activation = new Proxy({ ...ACTIVATION }, {
        getPrototypeOf: () => {
          objectTrapCalls += 1;
          throw new Error('activation proxy trap ran');
        },
      });
      await expect(controller.open(activation)).rejects.toThrow(/plain data object/);
      expect(objectTrapCalls).toBe(0);

      let kindsTrapCalls = 0;
      const kinds = new Proxy(['agents'], {
        ownKeys: () => {
          kindsTrapCalls += 1;
          throw new Error('kinds proxy trap ran');
        },
      });
      await expect(controller.open({ ...ACTIVATION, kinds } as never)).rejects.toThrow(
        /closed \[agents\] tuple/,
      );
      expect(kindsTrapCalls).toBe(0);
      expect(handoff.calls).toEqual([]);
    });

    it('rejects unknown activation fields and a non-closed kinds tuple', async () => {
      const controller = build();
      await expect(controller.open({ ...ACTIVATION, extra: true } as never)).rejects.toThrow(
        /unknown or missing fields/,
      );

      const kinds = ['agents'] as string[] & { extra?: boolean };
      kinds.extra = true;
      await expect(controller.open({ ...ACTIVATION, kinds } as never)).rejects.toThrow(
        /closed \[agents\] tuple/,
      );
      expect(handoff.calls).toEqual([]);
    });

    it('rejects a non-canonical network and invalid mode before handoff', async () => {
      const controller = build();
      await expect(controller.open({ ...ACTIVATION, networkId: 'not a network' })).rejects.toThrow(
        /networkId is not canonical/,
      );
      await expect(controller.open({ ...ACTIVATION, mode: 'observe' } as never)).rejects.toThrow(
        /mode is invalid/,
      );
      expect(handoff.calls).toEqual([]);
    });

    for (const failAt of [
      'destroyClient',
      'stopAndProveOwnedChildDead',
      'awaitRetiredWork',
      'startAndProveCleanGeneration',
      'rotateMaterializationEpoch',
    ] as const) {
      it(`becomes terminally unavailable when the handoff fails at ${failAt}`, async () => {
        handoff.failAt = failAt;
        const controller = build();
        await expect(controller.open(ACTIVATION)).rejects.toThrow(/handoff failed/);

        // Fail-closed: no replacement is bound, and the lane never reopens.
        await expect(controller.open(ACTIVATION)).rejects.toThrow(/terminal/);
      });
    }

    it('refuses to enable without a supervisor-issued lease', async () => {
      __resetSystemRecordControllerRegistrationForTests();
      const controller = createSystemRecordLaneControllerV1({
        lease: {} as never,
        handoff,
        executor,
        barrier: barrier.run,
      });
      await expect(controller.open(ACTIVATION)).rejects.toThrow(/ownership lease/);
      expect(handoff.calls).toEqual([]);
    });

    it('fails managed mutations closed when the epoch binding is MALFORMED', async () => {
      // The barrier result is `unknown` — coalescing means a later same-key
      // caller cannot soundly type another caller's shared promise — so the
      // lane re-validates with `isMaterializationEpochBindingV1`. That guard
      // shipped without a test, which is the shape worth pinning: a rotation
      // that returns something plausible-but-wrong must fail CLOSED, not be
      // read as "no binding" and quietly enable.
      handoff.rotateMaterializationEpoch = (async () => ({
        epoch: 1,
        childGeneration: null,
      })) as unknown as RecordingHandoff['rotateMaterializationEpoch'];

      await expect(build().open(ACTIVATION)).rejects.toThrow(
        /materialization epoch binding/,
      );
    });

    it('refuses to enable on terminal ownership', async () => {
      ownership.invalidate('port-release-unproven');
      await expect(build().open(ACTIVATION)).rejects.toThrow(/terminal/);
      expect(handoff.calls).toEqual([]);
    });

    it('keeps a B2 void epoch rotation compatible with the legacy executor', async () => {
      const legacyHandoff: SystemRecordChildHandoffV1 = {
        destroyClient: async () => undefined,
        stopAndProveOwnedChildDead: async () => undefined,
        awaitRetiredWork: async () => undefined,
        startAndProveCleanGeneration: async () => undefined,
        rotateMaterializationEpoch: async () => undefined,
      };
      const legacyCalls: string[] = [];
      const controller = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff: legacyHandoff,
        executor: {
          applyVerified: async (_proof, childGeneration) => {
            legacyCalls.push(childGeneration);
            return {
              outcome: 'applied',
              stateRevision: '1',
              appliedStateDigest: `0x${'e'.repeat(64)}`,
            };
          },
        },
        barrier: barrier.run,
      });

      const session = await controller.open(ACTIVATION);
      expect(session.state).toBe('enabled');
      expect((await session.applyVerified({})).outcome).toBe('applied');
      expect(legacyCalls).toEqual(['1']);
    });

    it('fails closed when a B3 settlement executor receives no epoch binding', async () => {
      const legacyHandoff: SystemRecordChildHandoffV1 = {
        destroyClient: async () => undefined,
        stopAndProveOwnedChildDead: async () => undefined,
        awaitRetiredWork: async () => undefined,
        startAndProveCleanGeneration: async () => undefined,
        rotateMaterializationEpoch: async () => undefined,
      };
      const controller = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff: legacyHandoff,
        executor: new AtomicRecoveryExecutor(),
        barrier: barrier.run,
      });

      await expect(controller.open(ACTIVATION)).rejects.toThrow(/materialization epoch binding/);
      await expect(controller.open(ACTIVATION)).rejects.toThrow(/terminal/);
    });
  });

  describe('registration invariant', () => {
    it('refuses a second owned-store controller before capability exposure', () => {
      build();
      expect(() => build()).toThrow(SystemRecordControllerRegistrationError);
    });
  });

  describe('transition precedence', () => {
    it('disable rotates the epoch and returns to disabled', async () => {
      const session = await build().open(ACTIVATION);
      handoff.calls.length = 0;

      await session.close('disable');
      expect(session.state).toBe('disabled');
      expect(handoff.calls).toEqual(['awaitRetiredWork', 'rotateMaterializationEpoch']);
    });

    it('re-enable performs a full clean handoff and a new activation generation', async () => {
      const controller = build();
      const session = await controller.open(ACTIVATION);
      await session.close('disable');
      handoff.calls.length = 0;

      const reopened = await controller.open(ACTIVATION);
      expect(reopened).not.toBe(session);
      expect(reopened.state).toBe('enabled');
      expect(reopened.activationGeneration).toBe('2');
      expect(handoff.calls).toEqual([
        'destroyClient',
        'stopAndProveOwnedChildDead',
        'awaitRetiredWork',
        'startAndProveCleanGeneration',
        'rotateMaterializationEpoch',
      ]);
    });

    it('shutdown supersedes disable and never restarts', async () => {
      const session = await build().open(ACTIVATION);
      handoff.calls.length = 0;

      await session.close('shutdown');
      expect(session.state).toBe('shutdown');
      expect(handoff.calls).not.toContain('startAndProveCleanGeneration');

      // A later disable is a no-op; shutdown outranks it.
      await session.close('disable');
      expect(session.state).toBe('shutdown');
    });

    it('reaches terminal shutdown even when a teardown step throws', async () => {
      const session = await build().open(ACTIVATION);
      handoff.failAt = 'stopAndProveOwnedChildDead';

      await expect(session.close('shutdown')).rejects.toThrow(/handoff failed/);
      // A process that is going away must never believe the lane is still live.
      expect(session.state).toBe('shutdown');
    });

    for (const failAt of ['destroyClient', 'stopAndProveOwnedChildDead'] as const) {
      it(`keeps registration claimed after physical shutdown fails at ${failAt}`, async () => {
        const session = await build().open(ACTIVATION);
        handoff.failAt = failAt;

        await expect(session.close('shutdown')).rejects.toThrow(/handoff failed/);
        const callsAfterFailure = handoff.calls.length;
        await expect(session.close('shutdown')).rejects.toThrow(/handoff failed/);
        expect(handoff.calls).toHaveLength(callsAfterFailure);
        expect(() =>
          createSystemRecordLaneControllerV1({
            lease: ownership.lease,
            handoff: new RecordingHandoff(),
            executor,
            barrier: barrier.run,
          }),
        ).toThrow(SystemRecordControllerRegistrationError);
      });
    }

    it('is idempotent for a repeated shutdown', async () => {
      const session = await build().open(ACTIVATION);
      await session.close('shutdown');
      handoff.calls.length = 0;
      await session.close('shutdown');
      expect(handoff.calls).toEqual([]);
    });

    it('never reopens after shutdown', async () => {
      const controller = build();
      const session = await controller.open(ACTIVATION);
      await session.close('shutdown');
      await expect(controller.open(ACTIVATION)).rejects.toThrow(/terminal/);
    });

    it('disable on a disabled lane is a no-op', async () => {
      const controller = build();
      const session = await controller.open(ACTIVATION);
      await session.close('disable');
      handoff.calls.length = 0;
      await session.close('disable');
      expect(handoff.calls).toEqual([]);
    });
  });

  describe('transition precedence UNDER CONCURRENCY', () => {
    /**
     * The suite previously drove this machine only SEQUENTIALLY, which is the
     * single reason both of the defects below shipped. An independent review
     * executed them as working exploits: a shut-down lane that spawned a fresh
     * child after shutdown had proved the old one dead, and — worse — one that
     * then accepted and applied a record write.
     */
    class StallingHandoff extends RecordingHandoff {
      private releaseGate!: () => void;
      private reachedGate!: () => void;
      readonly reachedStart: Promise<void>;
      private readonly gate: Promise<void>;

      constructor() {
        super();
        let r!: () => void;
        this.reachedStart = new Promise<void>((resolve) => {
          r = resolve;
        });
        this.reachedGate = r;
        let g!: () => void;
        this.gate = new Promise<void>((resolve) => {
          g = resolve;
        });
        this.releaseGate = g;
      }

      release(): void {
        this.releaseGate();
      }

      override startAndProveCleanGeneration = async (): Promise<void> => {
        this.calls.push('startAndProveCleanGeneration');
        this.reachedGate();
        await this.gate;
      };
    }

    /**
     * A handoff that can be paused at ANY named step, with several gates live
     * at once.
     *
     * `StallingHandoff` above can only stall `startAndProveCleanGeneration`, and
     * only one at a time. That limitation is not cosmetic — it is why the suite
     * could express "shutdown behind a stalled open" but not "a second caller
     * arrives while the TEARDOWN is stalled", and the second shape is where both
     * review rounds found their blockers. Every test below needs a gate on a
     * step `StallingHandoff` cannot reach.
     */
    class GatedHandoff extends RecordingHandoff {
      private readonly gates = new Map<string, Promise<void>>();
      private readonly releases = new Map<string, () => void>();
      private readonly arrivals = new Map<string, Promise<void>>();
      private readonly arrived = new Map<string, () => void>();

      /** Arm a gate on `step`; the handoff blocks there until `release(step)`. */
      gate(step: string): void {
        let release!: () => void;
        this.gates.set(step, new Promise<void>((r) => { release = r; }));
        this.releases.set(step, release);
        let arrive!: () => void;
        this.arrivals.set(step, new Promise<void>((r) => { arrive = r; }));
        this.arrived.set(step, arrive);
      }

      /** Resolves once the handoff has ENTERED `step` and is parked there. */
      reached(step: string): Promise<void> {
        return this.arrivals.get(step) ?? Promise.resolve();
      }

      release(step: string): void {
        this.releases.get(step)?.();
      }

      protected override async step(name: string): Promise<void> {
        this.calls.push(name);
        this.barrier?.note(name);
        if (this.failAt === name) throw new Error(`handoff failed at ${name}`);
        const gate = this.gates.get(name);
        if (gate) {
          this.arrived.get(name)?.();
          await gate;
        }
      }
    }

    const buildGated = () => {
      const gated = new GatedHandoff();
      gated.barrier = barrier;
      __resetSystemRecordControllerRegistrationForTests();
      const controller = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff: gated,
        executor,
        barrier: barrier.run,
      });
      return { gated, controller };
    };

    /**
     * "Has not resolved yet" as an ASSERTION rather than a timing hope.
     *
     * A test that merely awaits and finds the right answer cannot distinguish
     * "correctly blocked" from "resolved early and happened to look the same".
     */
    const track = <T>(p: Promise<T>) => {
      const state = { settled: false, rejected: false, value: undefined as unknown };
      const done = p.then(
        (v) => { state.settled = true; state.value = v; },
        (e) => { state.settled = true; state.rejected = true; state.value = e; },
      );
      return { state, done };
    };

    const drain = async (turns = 25) => {
      for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
    };

    const buildStalling = () => {
      const stalling = new StallingHandoff();
      stalling.barrier = barrier;
      __resetSystemRecordControllerRegistrationForTests();
      const controller = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff: stalling,
        executor,
        barrier: barrier.run,
      });
      return { stalling, controller };
    };

    /**
     * Terminality is committed at INTENT, not at completion.
     *
     * Round 1 of the review found concurrent shutdowns each running a teardown;
     * the fix made the `transition` pointer install synchronously. Round 2 then
     * found that an older transition's `finally` erases that pointer, so a later
     * `disable` revived the terminal session — executed, ending `disabled` after
     * `close('shutdown')` had resolved, with a fresh child spawned and a record
     * write dispatched.
     *
     * Two blockers from one root: the pointer was the only carrier of shutdown
     * intent, and any transition could erase it. These tests pin the carrier
     * change — `current` goes terminal synchronously and refuses to move — and
     * every one of them fails against the shipped model.
     */
    it('commits terminal state SYNCHRONOUSLY, before the teardown can suspend', async () => {
      const { gated, controller } = buildGated();
      const session = await controller.open(ACTIVATION);
      gated.gate('destroyClient');

      const shutdown = track(session.close('shutdown'));
      // No await between the call and this read: the latch must already be
      // visible. Under the shipped model `current` was written only in the
      // teardown's `finally`, so this read returned `enabled`.
      expect(session.state).toBe('shutdown');

      await gated.reached('destroyClient');
      expect(session.state).toBe('shutdown');
      expect(shutdown.state.settled).toBe(false);

      gated.release('destroyClient');
      await shutdown.done;
      expect(session.state).toBe('shutdown');
    });

    it('refuses a dispatch issued while the teardown is stopping the child', async () => {
      const { gated, controller } = buildGated();
      const session = await controller.open(ACTIVATION);
      gated.gate('stopAndProveOwnedChildDead');

      const shutdown = track(session.close('shutdown'));
      await gated.reached('stopAndProveOwnedChildDead');

      // The child is being signalled RIGHT NOW. Shipped, this returned
      // `{outcome:'applied'}` — a record write admitted mid-teardown, because
      // the admission ladder reads `current` and `current` still said `enabled`.
      const before = executor.calls.length;
      expect(await session.applyVerified({})).toEqual({ outcome: 'capability-lost' });
      expect(executor.calls.length).toBe(before);

      gated.release('stopAndProveOwnedChildDead');
      await shutdown.done;
    });

    it('refuses to publish an enable that a shutdown superseded mid-handoff', async () => {
      const { gated, controller } = buildGated();
      const first = await controller.open(ACTIVATION);
      await first.close('disable');
      const generationBefore = first.activationGeneration;

      gated.gate('startAndProveCleanGeneration');
      const reopen = track(controller.open(ACTIVATION));
      await gated.reached('startAndProveCleanGeneration');

      const shutdown = track(first.close('shutdown'));
      gated.release('startAndProveCleanGeneration');
      await shutdown.done;
      await reopen.done;

      // The superseded open must REJECT, not resolve with a terminal session.
      expect(reopen.state.rejected).toBe(true);
      expect(String((reopen.state.value as Error).message)).toMatch(/terminal/);
      expect(first.state).toBe('shutdown');
      // And it must not publish its activation: a terminal lane advertising a
      // fresh generation is the resurrection the latch exists to prevent.
      expect(first.activationGeneration).toBe(generationBefore);
    });

    it('refuses to publish a disable that a shutdown superseded mid-section', async () => {
      const { gated, controller } = buildGated();
      const session = await controller.open(ACTIVATION);

      gated.gate('rotateMaterializationEpoch');
      const disable = track(session.close('disable'));
      await gated.reached('rotateMaterializationEpoch');

      const shutdown = track(session.close('shutdown'));
      gated.release('rotateMaterializationEpoch');
      await disable.done;
      await shutdown.done;

      // Shipped, `runDisable`'s tail wrote `disabled` over the terminal state.
      expect(session.state).toBe('shutdown');
      await expect(controller.open(ACTIVATION)).rejects.toThrow(/terminal/);
    });

    it('opens NO disable section for a disable requested after shutdown latched', async () => {
      const { gated, controller } = buildGated();
      const first = await controller.open(ACTIVATION);
      await first.close('disable');

      gated.gate('startAndProveCleanGeneration');
      const reopen = track(controller.open(ACTIVATION));
      await gated.reached('startAndProveCleanGeneration');

      const shutdown = track(first.close('shutdown'));
      const disable = track(first.close('disable'));

      gated.release('startAndProveCleanGeneration');
      await shutdown.done;
      await disable.done;
      await reopen.done;

      expect(first.state).toBe('shutdown');
      // Shipped: ['…enable', '…shutdown', '…disable'] — a scheduler control
      // barrier ran, and committed, after shutdown was terminal.
      expect(barrier.purposes).toEqual([
        'system-record.enable',
        'system-record.disable',
        'system-record.enable',
        'system-record.shutdown',
      ]);
    });

    it('makes a second shutdown JOIN the teardown rather than resolve early', async () => {
      const { gated, controller } = buildGated();
      const session = await controller.open(ACTIVATION);
      gated.gate('destroyClient');
      gated.failAt = 'stopAndProveOwnedChildDead';

      const first = track(session.close('shutdown'));
      await gated.reached('destroyClient');

      // The latch makes `current` terminal already. If `runShutdown` checked
      // state before joining, this caller would get a RESOLVED promise while
      // the child was still being stopped, and would never learn the teardown
      // failed.
      const second = track(session.close('shutdown'));
      await drain();
      expect(second.state.settled).toBe(false);

      gated.release('destroyClient');
      await Promise.allSettled([first.done, second.done]);
      expect(first.state.rejected).toBe(true);
      expect(second.state.rejected).toBe(true);
      expect(String((second.state.value as Error).message)).toMatch(/handoff failed/);
      expect(gated.calls.filter((c) => c === 'stopAndProveOwnedChildDead')).toHaveLength(2);
    });

    it('retains a timed-out shutdown until the scheduler callback physically settles', async () => {
      const timeoutBarrier = new TransitionTimeoutBarrier();
      const gated = new GatedHandoff();
      gated.barrier = timeoutBarrier;
      __resetSystemRecordControllerRegistrationForTests();
      const controller = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff: gated,
        executor,
        barrier: timeoutBarrier.run,
      });
      const session = await controller.open(ACTIVATION);
      gated.gate('destroyClient');

      const first = track(session.close('shutdown'));
      await gated.reached('destroyClient');
      timeoutBarrier.timeoutShutdown();
      await first.done;

      expect(first.state.rejected).toBe(true);
      expect(String((first.state.value as Error).message)).toMatch(/TRANSITION_TIMEOUT/);
      expect(session.state).toBe('shutdown');
      expect(timeoutBarrier.physicalSettled).toBe(false);

      // The first close reports the scheduler timeout, but ownership remains
      // with the callback still parked under the scheduler's exclusive seal.
      const second = track(session.close('shutdown'));
      await drain();
      expect(second.state.settled).toBe(false);
      expect(() =>
        createSystemRecordLaneControllerV1({
          lease: ownership.lease,
          handoff: new RecordingHandoff(),
          executor,
          barrier: barrier.run,
        }),
      ).toThrow(SystemRecordControllerRegistrationError);

      gated.release('destroyClient');
      await second.done;
      expect(second.state.rejected).toBe(false);
      expect(timeoutBarrier.physicalSettled).toBe(true);
      expect(gated.calls.filter((c) => c === 'destroyClient')).toHaveLength(2);
      expect(() =>
        createSystemRecordLaneControllerV1({
          lease: ownership.lease,
          handoff: new RecordingHandoff(),
          executor,
          barrier: barrier.run,
        }),
      ).not.toThrow();
    });

    it('retains a wait-phase timed-out shutdown without claiming physical teardown', async () => {
      const timeoutBarrier = new WaitPhaseTimeoutBarrier();
      const gated = new GatedHandoff();
      gated.barrier = timeoutBarrier;
      __resetSystemRecordControllerRegistrationForTests();
      const controller = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff: gated,
        executor,
        barrier: timeoutBarrier.run,
      });
      const session = await controller.open(ACTIVATION);
      gated.calls.length = 0;

      await expect(session.close('shutdown')).rejects.toThrow(/WAIT_TIMEOUT/);
      expect(session.state).toBe('shutdown');
      expect(gated.calls).toEqual([
        'failManagedMutationsClosed:shutdown transition did not physically settle',
      ]);

      // No callback ran, so no physical child/client proof exists. Replaying a
      // teardown outside the rejected scheduler request would violate the
      // control boundary; retain and report the same failure instead.
      await expect(session.close('shutdown')).rejects.toThrow(/WAIT_TIMEOUT/);
      expect(gated.calls).toEqual([
        'failManagedMutationsClosed:shutdown transition did not physically settle',
      ]);
      expect(() =>
        createSystemRecordLaneControllerV1({
          lease: ownership.lease,
          handoff: new RecordingHandoff(),
          executor,
          barrier: barrier.run,
        }),
      ).toThrow(SystemRecordControllerRegistrationError);
    });

    it('retains a timed-out disable until its scheduler callback settles', async () => {
      const timeoutBarrier = new TransitionTimeoutBarrier();
      const gated = new GatedHandoff();
      gated.barrier = timeoutBarrier;
      __resetSystemRecordControllerRegistrationForTests();
      const admissionStates: boolean[] = [];
      const controller = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff: gated,
        executor,
        barrier: timeoutBarrier.run,
        setAdmissionActive: (active) => admissionStates.push(active),
      });
      const session = await controller.open(ACTIVATION);
      expect(admissionStates).toEqual([true]);
      gated.gate('awaitRetiredWork');

      const first = track(session.close('disable'));
      await gated.reached('awaitRetiredWork');
      timeoutBarrier.timeout('system-record.disable');
      await first.done;
      expect(first.state.rejected).toBe(true);
      expect(session.state).toBe('disabling');
      expect(admissionStates).toEqual([true]);

      const second = track(session.close('disable'));
      await drain();
      expect(second.state.settled).toBe(false);

      gated.release('awaitRetiredWork');
      await second.done;
      expect(second.state.rejected).toBe(false);
      expect(session.state).toBe('disabled');
      expect(admissionStates).toEqual([true, false]);
      expect(gated.calls.filter((call) => call === 'rotateMaterializationEpoch'))
        .toHaveLength(2);
    });

    it('keeps detach waiting for a timed-out disable physical settlement', async () => {
      const timeoutBarrier = new TransitionTimeoutBarrier();
      const gated = new GatedHandoff();
      gated.barrier = timeoutBarrier;
      __resetSystemRecordControllerRegistrationForTests();
      const controller = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff: gated,
        executor,
        barrier: timeoutBarrier.run,
      });
      const session = await controller.open(ACTIVATION);
      gated.gate('awaitRetiredWork');

      const disable = track(session.close('disable'));
      await gated.reached('awaitRetiredWork');
      timeoutBarrier.timeout('system-record.disable');
      await disable.done;
      expect(disable.state.rejected).toBe(true);

      const detach = track(releaseSystemRecordLaneControllerV1(controller));
      await drain();
      expect(detach.state.settled).toBe(false);

      gated.release('awaitRetiredWork');
      await detach.done;
      expect(detach.state.rejected).toBe(false);
      expect(session.state).toBe('detached');

      const replacement = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff: new RecordingHandoff(),
        executor: new StubExecutor(),
        barrier: barrier.run,
      });
      await releaseSystemRecordLaneControllerV1(replacement);
    });

    it('retains the controller when a rejecting transition self-releases during detach', async () => {
      const { gated, controller } = buildGated();
      gated.gate('destroyClient');
      const open = track(controller.open(ACTIVATION));
      await gated.reached('destroyClient');
      gated.failAt = 'stopAndProveOwnedChildDead';

      const detach = track(releaseSystemRecordLaneControllerV1(controller));
      gated.release('destroyClient');
      await Promise.all([open.done, detach.done]);

      expect(open.state.rejected).toBe(true);
      expect(detach.state.rejected).toBe(true);
      expect(String((detach.state.value as Error).message)).toMatch(/handoff failed/);
      expect(() =>
        createSystemRecordLaneControllerV1({
          lease: ownership.lease,
          handoff: new RecordingHandoff(),
          executor: new StubExecutor(),
          barrier: barrier.run,
        }),
      ).toThrow(SystemRecordControllerRegistrationError);
    });

    it('runs ONE teardown when a superseded open settles under a stalled shutdown', async () => {
      const { gated, controller } = buildGated();
      const first = await controller.open(ACTIVATION);
      await first.close('disable');

      gated.gate('startAndProveCleanGeneration');
      const reopen = track(controller.open(ACTIVATION));
      await gated.reached('startAndProveCleanGeneration');

      gated.gate('destroyClient');
      const shutdownA = track(first.close('shutdown'));
      // Release the open: its `finally` runs here. Unconditionally clearing the
      // pointer erased the shutdown entry, and the next caller built a SECOND
      // teardown — 4 destroy / 4 stop where 3 of each were expected.
      gated.release('startAndProveCleanGeneration');
      await gated.reached('destroyClient');

      const stopsBefore = gated.calls.filter((c) => c === 'stopAndProveOwnedChildDead').length;
      const shutdownB = track(first.close('shutdown'));
      await drain();
      expect(shutdownB.state.settled).toBe(false);

      gated.release('destroyClient');
      await Promise.allSettled([shutdownA.done, shutdownB.done, reopen.done]);

      expect(gated.calls.filter((c) => c === 'stopAndProveOwnedChildDead').length).toBe(
        stopsBefore + 1,
      );
      expect(first.state).toBe('shutdown');
    });

    it('keeps the terminal state when a parked dispatch resolves indeterminate', async () => {
      const { gated, controller } = buildGated();
      const session = await controller.open(ACTIVATION);

      executor.park();
      executor.outcome = {
        outcome: 'indeterminate',
        recoveryGeneration: '1',
      } as SystemRecordApplyOutcomeV1;
      const apply = track(session.applyVerified({}));
      await executor.dispatched;

      // A COMPLETE shutdown runs underneath the parked dispatch.
      await session.close('shutdown');
      expect(session.state).toBe('shutdown');

      executor.release();
      await apply.done;
      // The seal is the fourth writer of `current` and the only one that never
      // touches `this.transition`, so no pointer discipline can reach it.
      // Shipped, it wrote `reconciling` over the terminal state.
      expect((apply.state.value as SystemRecordApplyOutcomeV1).outcome).toBe('indeterminate');
      expect(session.state).toBe('shutdown');
    });

    it('runs ONE disable section for two disables queued behind one open', async () => {
      const { gated, controller } = buildGated();
      const first = await controller.open(ACTIVATION);
      await first.close('disable');

      gated.gate('startAndProveCleanGeneration');
      const reopen = track(controller.open(ACTIVATION));
      await gated.reached('startAndProveCleanGeneration');

      const a = track(first.close('disable'));
      const b = track(first.close('disable'));
      gated.release('startAndProveCleanGeneration');
      await Promise.allSettled([a.done, b.done, reopen.done]);

      // Both joined the same open, both re-read `enabled`, and both installed:
      // two disable sections and two epoch rotations for one disable.
      expect(barrier.purposes.slice(2)).toEqual([
        'system-record.enable',
        'system-record.disable',
      ]);
      expect(barrier.maxDepth).toBe(1);
      expect(first.state).toBe('disabled');
    });

    it('does not re-run a disable on an already-unavailable lane', async () => {
      const { gated, controller } = buildGated();
      const session = await controller.open(ACTIVATION);

      gated.failAt = 'rotateMaterializationEpoch';
      await expect(session.close('disable')).rejects.toThrow(/handoff failed/);
      expect(session.state).toBe('unavailable');

      gated.failAt = null;
      const callsBefore = gated.calls.length;
      const sectionsBefore = barrier.purposes.length;
      await session.close('disable');
      expect(gated.calls.length).toBe(callsBefore);
      expect(barrier.purposes.length).toBe(sectionsBefore);
      expect(session.state).toBe('unavailable');
    });

    it('rejects an open that joined a disable when a shutdown latched under the join', async () => {
      // This one exists because its guard's solo mutant SURVIVED the first
      // sweep. Removing the post-join `assertNotTerminal()` in `open()` left
      // every test green while a superseded open ran a FULL generation handoff
      // — destroy, stop, start — on an already-terminal lane. The guard was
      // load-bearing and the suite simply could not see the path.
      const { gated, controller } = buildGated();
      const session = await controller.open(ACTIVATION);

      gated.gate('rotateMaterializationEpoch');
      const disable = track(session.close('disable'));
      await gated.reached('rotateMaterializationEpoch');

      const reopen = track(controller.open(ACTIVATION));
      await drain(3);

      const shutdown = track(session.close('shutdown'));
      const startsBefore = gated.calls.filter((c) => c === 'startAndProveCleanGeneration').length;

      gated.release('rotateMaterializationEpoch');
      await Promise.allSettled([disable.done, reopen.done, shutdown.done]);

      expect(reopen.state.rejected).toBe(true);
      expect(String((reopen.state.value as Error).message)).toMatch(/terminal/);
      // The decisive assertion: no replacement child was started for an open
      // the shutdown had already superseded.
      expect(gated.calls.filter((c) => c === 'startAndProveCleanGeneration').length).toBe(
        startsBefore,
      );
      expect(session.state).toBe('shutdown');
    });

    it('rejects an open issued while the teardown is still running', async () => {
      const { gated, controller } = buildGated();
      const session = await controller.open(ACTIVATION);
      gated.gate('destroyClient');

      const shutdown = track(session.close('shutdown'));
      await gated.reached('destroyClient');

      // Shipped, this HUNG on the teardown and then resolved with a live lane.
      const reopen = track(controller.open(ACTIVATION));
      await drain();
      expect(reopen.state.settled).toBe(true);
      expect(reopen.state.rejected).toBe(true);
      expect(String((reopen.state.value as Error).message)).toMatch(/terminal/);

      gated.release('destroyClient');
      await shutdown.done;
    });

    it('shutdown outlives a stalled re-open instead of being overwritten by it', async () => {
      const { stalling, controller } = buildStalling();
      // Get a session handle from a completed open, then disable so the next
      // open must run the full handoff — where it will stall.
      stalling.release();
      const session = await controller.open(ACTIVATION);
      await session.close('disable');

      const reopened = new StallingHandoff();
      // Re-arm the stall on the same session by swapping the handoff's start.
      (stalling as unknown as { startAndProveCleanGeneration: () => Promise<void> })
        .startAndProveCleanGeneration = reopened.startAndProveCleanGeneration;

      const opening = controller.open(ACTIVATION).then(
        () => 'resolved',
        (e: Error) => `rejected: ${e.message}`,
      );
      await reopened.reachedStart;

      const shutdown = session.close('shutdown');
      reopened.release();
      await shutdown;
      await opening;

      // The property that matters is NOT whether the stalled open resolves —
      // shutdown now JOINS it, so it may legitimately complete first. What must
      // hold is that the resuming enable cannot leave the lane live afterwards,
      // and that teardown ran AFTER the start rather than being overtaken by
      // it. Previously shutdown clobbered the transition and the enable
      // resurrected the lane to `enabled` with a fresh child already spawned.
      expect(session.state).toBe('shutdown');
      const startedAt = stalling.calls.lastIndexOf('startAndProveCleanGeneration');
      const stoppedAt = stalling.calls.lastIndexOf('stopAndProveOwnedChildDead');
      expect(stoppedAt).toBeGreaterThan(startedAt);

      // And nothing can dispatch on it.
      const before = executor.calls.length;
      expect(await session.applyVerified({})).toEqual({ outcome: 'capability-lost' });
      expect(executor.calls.length).toBe(before);
    });

    it('a shut-down lane never dispatches, even if an open was awaiting the shutdown', async () => {
      const { stalling, controller } = buildStalling();
      stalling.release();
      const session = await controller.open(ACTIVATION);

      // Shutdown in flight; a concurrent open joins it and must NOT proceed.
      const shutdown = session.close('shutdown');
      const opening = controller.open(ACTIVATION).then(
        () => 'resolved',
        (e: Error) => `rejected: ${e.message}`,
      );
      await shutdown;
      expect(await opening).toMatch(/rejected: .*terminal/);

      expect(session.state).toBe('shutdown');
      const before = executor.calls.length;
      expect(await session.applyVerified({})).toEqual({ outcome: 'capability-lost' });
      // The exploit's step 5: a lane the process had shut down applied a write.
      expect(executor.calls.length).toBe(before);
    });

    it('seals admission on a SYNTHESIZED indeterminate, not just an executor one', async () => {
      // Review repro: the lane sealed only when the EXECUTOR returned
      // indeterminate. A success whose generation changed under the dispatch
      // was synthesized into indeterminate and returned while the lane stayed
      // `enabled`, so a second apply was admitted — two dispatches, both
      // ambiguous. The second must never have been admitted.
      const { stalling, controller } = buildStalling();
      stalling.release();
      const session = await controller.open(ACTIVATION);

      executor.outcome = { outcome: 'applied', stateRevision: '1', appliedStateDigest: `0x${'c'.repeat(64)}` };
      executor.onDispatch = () => {
        ownership.invalidate('child-exit');
        ownership.bindReadyGeneration();
      };

      const first = await session.applyVerified({});
      expect(first.outcome).toBe('indeterminate');
      expect(session.state).toBe('reconciling');

      const callsAfterFirst = executor.calls.length;
      const second = await session.applyVerified({});
      expect(second).toEqual({ outcome: 'deferred', reason: 'generation-changed' });
      expect(executor.calls.length).toBe(callsAfterFirst);
    });

    it('treats a not-ready lease under dispatch as unattributable, not just a changed generation', async () => {
      const { stalling, controller } = buildStalling();
      stalling.release();
      const session = await controller.open(ACTIVATION);

      executor.outcome = { outcome: 'applied', stateRevision: '1', appliedStateDigest: `0x${'d'.repeat(64)}` };
      // Generation string is UNCHANGED; only readiness is lost. Reading just
      // `childGeneration` would have called this attributable and returned a
      // success for a write it cannot account for.
      executor.onDispatch = () => ownership.invalidate('listener-ownership-lost');

      expect((await session.applyVerified({})).outcome).toBe('indeterminate');
      expect(session.state).toBe('reconciling');
    });

    it('coalesces concurrent shutdowns into ONE teardown', async () => {
      // Review repro: both callers passed the "already shutting down?" check
      // before awaiting the in-flight open, then both ran a teardown —
      // 4 destroy / 4 stop where 3 of each were expected. Double
      // stop-and-prove-release is not harmless at a process-ownership
      // boundary; each one signals a child and asserts a port fact.
      const { stalling, controller } = buildStalling();
      stalling.release();
      const session = await controller.open(ACTIVATION);
      const baseline = {
        destroy: stalling.calls.filter((c) => c === 'destroyClient').length,
        stop: stalling.calls.filter((c) => c === 'stopAndProveOwnedChildDead').length,
      };

      await Promise.all([session.close('shutdown'), session.close('shutdown'), session.close('shutdown')]);

      expect(stalling.calls.filter((c) => c === 'destroyClient').length).toBe(baseline.destroy + 1);
      expect(stalling.calls.filter((c) => c === 'stopAndProveOwnedChildDead').length).toBe(baseline.stop + 1);
      expect(session.state).toBe('shutdown');
    });

    it('coalesces concurrent shutdowns issued behind a STALLED open', async () => {
      // This is the reviewer's exact shape, and it is the one that produced
      // 4 destroy / 4 stop: both callers passed the "already shutting down?"
      // check while the in-flight transition was still the OPEN, both awaited
      // it, and both then ran a teardown. Coalescing only matters here — with
      // the open already finished, the state re-check alone suffices, which is
      // why a weaker test could not discriminate.
      const { stalling, controller } = buildStalling();
      stalling.release();
      const session = await controller.open(ACTIVATION);
      await session.close('disable');

      const reopened = new StallingHandoff();
      (stalling as unknown as { startAndProveCleanGeneration: () => Promise<void> })
        .startAndProveCleanGeneration = reopened.startAndProveCleanGeneration;

      const opening = controller.open(ACTIVATION).catch(() => undefined);
      await reopened.reachedStart;

      const baseline = {
        destroy: stalling.calls.filter((c) => c === 'destroyClient').length,
        stop: stalling.calls.filter((c) => c === 'stopAndProveOwnedChildDead').length,
      };
      const shutdowns = Promise.all([session.close('shutdown'), session.close('shutdown')]);
      reopened.release();
      await shutdowns;
      await opening;

      expect(stalling.calls.filter((c) => c === 'destroyClient').length).toBe(baseline.destroy + 1);
      expect(stalling.calls.filter((c) => c === 'stopAndProveOwnedChildDead').length).toBe(
        baseline.stop + 1,
      );
      expect(session.state).toBe('shutdown');
    });

    it('releases the process-global registration on shutdown', async () => {
      const { stalling, controller } = buildStalling();
      stalling.release();
      const session = await controller.open(ACTIVATION);
      await session.close('shutdown');

      // Holding the registration past shutdown made a replacement controller
      // unconstructable for the process lifetime — and the adapter surfaces
      // that as a throw from a capability PROBE.
      expect(() =>
        createSystemRecordLaneControllerV1({
          lease: ownership.lease,
          handoff: new RecordingHandoff(),
          executor,
          barrier: barrier.run,
        }),
      ).not.toThrow();
    });

    it('refuses to report enabled when the handoff bound no ready generation', async () => {
      // The handoff resolves every step but never binds a proven-ready child.
      const silent = createManagedOxigraphOwnershipControllerV1(
        OWNERSHIP_QUERY_ENDPOINT,
        OWNERSHIP_UPDATE_ENDPOINT,
      );
      __resetSystemRecordControllerRegistrationForTests();
      const controller = createSystemRecordLaneControllerV1({
        lease: silent.lease,
        handoff: new RecordingHandoff(),
        executor,
        barrier: barrier.run,
      });
      await expect(controller.open(ACTIVATION)).rejects.toThrow(/proven-ready/);
    });
  });

  /**
   * The exclusive section is the whole point of the handoff: stopping the owned
   * child is only safe when nothing is talking to it. The scheduler's control
   * barrier shipped exported and unit-tested with ZERO production callers, so
   * these assert the WIRING — that each transition actually opens a section and
   * that the child-touching steps happen inside it — not the barrier's own
   * semantics, which `store-scheduler-system-record-admission.test.ts` covers.
   */
  describe('control barrier', () => {
    it('runs the whole enable handoff inside one exclusive section', async () => {
      await build().open(ACTIVATION);

      expect(barrier.purposes).toEqual(['system-record.enable']);
      // Every step, not just the stop: a replacement started outside the
      // section could be reached by work admitted before the section closed.
      expect(barrier.sections[0]?.inside).toEqual([
        'destroyClient',
        'stopAndProveOwnedChildDead',
        'awaitRetiredWork',
        'startAndProveCleanGeneration',
        'rotateMaterializationEpoch',
      ]);
      expect(barrier.maxDepth).toBe(1);
    });

    it('runs disable inside its own exclusive section', async () => {
      const session = await build().open(ACTIVATION);
      await session.close('disable');

      expect(barrier.purposes).toEqual(['system-record.enable', 'system-record.disable']);
      expect(barrier.sections[1]?.inside).toEqual([
        'awaitRetiredWork',
        'rotateMaterializationEpoch',
      ]);
      expect(barrier.maxDepth).toBe(1);
    });

    it('runs shutdown inside its own exclusive section', async () => {
      const session = await build().open(ACTIVATION);
      await session.close('shutdown');

      expect(barrier.purposes).toEqual(['system-record.enable', 'system-record.shutdown']);
      expect(barrier.sections[1]?.inside).toEqual([
        'destroyClient',
        'stopAndProveOwnedChildDead',
        'awaitRetiredWork',
      ]);
      expect(barrier.maxDepth).toBe(1);
    });

    it('touches the child not at all when the section cannot be acquired', async () => {
      // A barrier that times out means the store did NOT quiesce. Proceeding
      // anyway is the exact failure the barrier exists to prevent, so enable
      // must fail terminally with the handoff untouched.
      barrier.failWith = new Error('STORE_CONTROL_BARRIER_TIMEOUT');
      const controller = build();

      await expect(controller.open(ACTIVATION)).rejects.toThrow(/BARRIER_TIMEOUT/);
      expect(handoff.calls).toEqual([
        'failManagedMutationsClosed:enable transition did not physically settle',
      ]);
      await expect(controller.open(ACTIVATION)).rejects.toThrow(/terminal/);
    });

    it('still reaches terminal shutdown when the section cannot be acquired', async () => {
      const session = await build().open(ACTIVATION);
      const beforeStops = handoff.calls.filter((c) => c === 'stopAndProveOwnedChildDead').length;
      barrier.failWith = new Error('STORE_CONTROL_BARRIER_TIMEOUT');

      // The failure is REPORTED — a shutdown that could not quiesce the store
      // is not a clean one, and the caller has to be able to tell.
      await expect(session.close('shutdown')).rejects.toThrow(/BARRIER_TIMEOUT/);

      // ...but the lane still reaches terminal, and the child is left ALIVE
      // rather than stopped outside a section. That is the safe side of this
      // failure: an unstopped child under a terminal lane serves reads and
      // accepts nothing through the lane, whereas stopping it while requests
      // are in flight is the exact hazard the barrier exists to prevent. The
      // daemon supervisor still owns the child and stops it at process exit.
      expect(session.state).toBe('shutdown');
      expect(handoff.calls.filter((c) => c === 'stopAndProveOwnedChildDead').length).toBe(
        beforeStops,
      );
    });
  });

  describe('applyVerified admission', () => {
    it('dispatches bound to the current child generation', async () => {
      const session = await build().open(ACTIVATION);
      const result = await session.applyVerified({});
      expect(result.outcome).toBe('applied');
      expect(executor.calls).toEqual([{
        activationGeneration: '1',
        networkId: 'testnet',
        kind: 'agents',
        mode: 'shadow',
        sessionIdentity: expect.any(Object),
        childGeneration: '1',
        materializationEpoch: '1',
      }]);
      expect(Object.getPrototypeOf(executor.calls[0]?.sessionIdentity)).toBeNull();
      expect(Reflect.ownKeys(executor.calls[0]?.sessionIdentity ?? {})).toHaveLength(0);
      expect(Object.isFrozen(executor.calls[0]?.sessionIdentity)).toBe(true);
      expect(Object.isFrozen(executor.calls[0])).toBe(true);
    });

    it('keeps an explicit child-generation fallback for the current adapter', async () => {
      const legacyCalls: string[] = [];
      const controller = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff,
        barrier: barrier.run,
        executor: {
          applyVerified: async (_proof, childGeneration) => {
            legacyCalls.push(childGeneration);
            return {
              outcome: 'applied',
              stateRevision: '1',
              appliedStateDigest: `0x${'e'.repeat(64)}`,
            };
          },
        },
      });

      const session = await controller.open(ACTIVATION);
      expect((await session.applyVerified({})).outcome).toBe('applied');
      expect(legacyCalls).toEqual(['1']);
    });

    it('refuses a facade from before disable/reopen even for the same descriptor', async () => {
      const controller = build();
      const stale = await controller.open(ACTIVATION);
      await stale.close('disable');
      const current = await controller.open(ACTIVATION);

      expect(stale.activationGeneration).toBe('1');
      expect(current.activationGeneration).toBe('2');
      const refusedProof = Object.freeze({ proof: 'stale-facade' });
      expect(await stale.applyVerified(refusedProof)).toEqual({
        outcome: 'deferred',
        reason: 'generation-changed',
      });
      expect(executor.calls).toHaveLength(0);
      expect(executor.discarded).toEqual([refusedProof]);

      expect((await current.applyVerified({})).outcome).toBe('applied');
      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0]?.activationGeneration).toBe('2');
      expect(executor.calls[0]?.materializationEpoch).toBe('3');
    });

    it('does not let a shadow facade inherit a later authoritative activation', async () => {
      const controller = build();
      const shadow = await controller.open(ACTIVATION);
      await shadow.close('disable');
      const authoritative = await controller.open({ ...ACTIVATION, mode: 'authoritative' });

      expect(await shadow.applyVerified({})).toEqual({
        outcome: 'deferred',
        reason: 'generation-changed',
      });
      expect((await authoritative.applyVerified({})).outcome).toBe('applied');
      expect(executor.calls).toEqual([expect.objectContaining({
        activationGeneration: '2',
        networkId: 'testnet',
        mode: 'authoritative',
      })]);
    });

    it('does not let a facade cross into a later network activation', async () => {
      const controller = build();
      const testnet = await controller.open(ACTIVATION);
      await testnet.close('disable');
      const mainnet = await controller.open({ ...ACTIVATION, networkId: 'mainnet-gnosis' });

      expect(await testnet.applyVerified({})).toEqual({
        outcome: 'deferred',
        reason: 'generation-changed',
      });
      expect((await mainnet.applyVerified({})).outcome).toBe('applied');
      expect(executor.calls).toEqual([expect.objectContaining({
        activationGeneration: '2',
        networkId: 'mainnet-gnosis',
        mode: 'shadow',
      })]);
    });

    it('keeps close aggregate while apply remains activation-scoped', async () => {
      const controller = build();
      const stale = await controller.open(ACTIVATION);
      await stale.close('disable');
      const current = await controller.open(ACTIVATION);

      // A facade is not an independently owned lane. Its close still controls
      // the one aggregate session, even though its apply authority is stale.
      await stale.close('disable');
      expect(current.state).toBe('disabled');
      expect(await current.applyVerified({})).toEqual({
        outcome: 'deferred',
        reason: 'generation-changed',
      });
      expect(executor.calls).toHaveLength(0);
    });

    it('refuses before enable without dispatching', async () => {
      __resetSystemRecordControllerRegistrationForTests();
      const controller = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff,
        executor,
        barrier: barrier.run,
      });
      const session = (await controller.open(ACTIVATION)) as SystemRecordLaneSessionV1;
      await session.close('disable');

      const refusedProof = Object.freeze({ proof: 'disabled' });
      const result = await session.applyVerified(refusedProof);
      expect(result).toEqual({ outcome: 'deferred', reason: 'generation-changed' });
      expect(executor.calls).toHaveLength(0);
      expect(executor.discarded).toEqual([refusedProof]);
    });

    it('returns capability-lost after shutdown with zero dispatch', async () => {
      const session = await build().open(ACTIVATION);
      await session.close('shutdown');
      const refusedProof = Object.freeze({ proof: 'shutdown' });
      expect(await session.applyVerified(refusedProof)).toEqual({ outcome: 'capability-lost' });
      expect(executor.calls).toHaveLength(0);
      expect(executor.discarded).toEqual([refusedProof]);
    });

    it('defers without dispatch while ownership is not ready', async () => {
      const session = await build().open(ACTIVATION);
      ownership.invalidate('child-exit');
      const refusedProof = Object.freeze({ proof: 'not-ready' });

      expect(await session.applyVerified(refusedProof)).toEqual({
        outcome: 'deferred',
        reason: 'generation-changed',
      });
      expect(executor.calls).toHaveLength(0);
      expect(executor.discarded).toEqual([refusedProof]);
    });

    it('returns capability-lost without dispatch on terminal ownership', async () => {
      const session = await build().open(ACTIVATION);
      ownership.invalidate('shutdown');
      const refusedProof = Object.freeze({ proof: 'terminal-lease' });
      expect(await session.applyVerified(refusedProof)).toEqual({ outcome: 'capability-lost' });
      expect(executor.calls).toHaveLength(0);
      expect(executor.discarded).toEqual([refusedProof]);
    });

    it('seals admission into reconciling after an indeterminate dispatch', async () => {
      const session = await build().open(ACTIVATION);
      executor.outcome = { outcome: 'indeterminate', recoveryGeneration: '1' };

      expect((await session.applyVerified({})).outcome).toBe('indeterminate');
      expect(session.state).toBe('reconciling');

      // No further work is admitted against a generation whose last write may
      // or may not have committed.
      executor.outcome = { outcome: 'applied', stateRevision: '2', appliedStateDigest: `0x${'b'.repeat(64)}` };
      const refusedProof = Object.freeze({ proof: 'reconciling' });
      expect(await session.applyVerified(refusedProof)).toEqual({
        outcome: 'deferred',
        reason: 'generation-changed',
      });
      expect(executor.calls).toHaveLength(1);
      expect(executor.discarded).toEqual([refusedProof]);
    });

    it('downgrades a success to indeterminate when the child changed under dispatch', async () => {
      const session = await build().open(ACTIVATION);
      // The child is replaced WHILE the request is in flight, so the 204 we
      // read cannot be attributed to the child we addressed.
      executor.onDispatch = () => {
        ownership.invalidate('child-exit');
        ownership.bindReadyGeneration();
      };

      const result = await session.applyVerified({});
      expect(result).toEqual({ outcome: 'indeterminate', recoveryGeneration: '2' });
    });

    it('does not downgrade a non-success outcome on a generation change', async () => {
      const session = await build().open(ACTIVATION);
      executor.outcome = { outcome: 'stale' };
      executor.onDispatch = () => {
        ownership.invalidate('child-exit');
        ownership.bindReadyGeneration();
      };

      // `stale` means the CAS did not match; it carries no uncertainty about
      // whether bytes were written, so it must not be inflated to indeterminate.
      expect(await session.applyVerified({})).toEqual({ outcome: 'stale' });
    });
  });

  describe('atomic uncertain-write recovery', () => {
    const buildRecovery = (chosenBarrier: RecordingBarrier = barrier) => {
      __resetSystemRecordControllerRegistrationForTests();
      const recoveryHandoff = new RecoveryHandoff(ownership);
      recoveryHandoff.barrier = chosenBarrier;
      const recoveryExecutor = new AtomicRecoveryExecutor();
      const controller = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff: recoveryHandoff,
        executor: recoveryExecutor,
        barrier: chosenBarrier.run,
      });
      return { controller, recoveryHandoff, recoveryExecutor, chosenBarrier };
    };

    it('settles on a clean child at the existing epoch, then requires a fresh facade', async () => {
      const { controller, recoveryHandoff, recoveryExecutor, chosenBarrier } = buildRecovery();
      const staleFacade = await controller.open(ACTIVATION);
      recoveryHandoff.calls.length = 0;
      recoveryHandoff.recoveryDeadlines.length = 0;
      const recoveryStartedAt = performance.now();

      const result = await staleFacade.applyVerified({});
      expect(result).toEqual({ outcome: 'indeterminate', recoveryGeneration: '1' });
      expect(recoveryExecutor.registration?.ownership).toBeTruthy();
      await expect(recoveryExecutor.registration?.completion).resolves.toEqual({
        resolution: 'applied',
        stateRevision: '2',
        appliedStateDigest: `0x${'2'.repeat(64)}`,
      });

      expect(recoveryHandoff.calls).toEqual([
        'stopAndProveOwnedChildDead',
        'destroyClient',
        'awaitRetiredWork',
        'startAndProveCleanGeneration',
        'createRecoveryRuntime',
      ]);
      expect(chosenBarrier.purposes).toEqual([
        'system-record.enable',
        'system-record.recovery',
      ]);
      expect(recoveryExecutor.recoveredRuntime?.client.childGeneration).toBe('2');
      const deadlines = recoveryHandoff.recoveryDeadlines.map(({ value }) => value);
      expect(recoveryHandoff.recoveryDeadlines.map(({ phase }) => phase)).toEqual([
        'stop', 'destroy', 'drain', 'start', 'exact-read',
      ]);
      expect(new Set(deadlines).size).toBe(1);
      expect(deadlines[0]).toBeGreaterThan(recoveryStartedAt);
      expect(deadlines[0]).toBeLessThanOrEqual(recoveryStartedAt + 30_100);
      // Receipt/state reconciliation MUST precede any epoch rotation. Rotating
      // first would make the exact old-epoch receipt unobservable.
      expect(recoveryHandoff.calls).not.toContain('rotateMaterializationEpoch');
      expect(staleFacade.state).toBe('enabled');
      expect(staleFacade.activationGeneration).toBe('1');
      expect(await staleFacade.applyVerified({})).toEqual({
        outcome: 'deferred',
        reason: 'generation-changed',
      });

      const freshFacade = await controller.open(ACTIVATION);
      expect(freshFacade.activationGeneration).toBe('1');
      recoveryExecutor.settlement = 'no-mutation';
      expect(await freshFacade.applyVerified({})).toEqual({ outcome: 'stale' });
      expect(recoveryExecutor.calls.at(-1)).toEqual(expect.objectContaining({
        childGeneration: '2',
        materializationEpoch: '1',
      }));
    });

    it('retains the single-writer registration until detached recovery settles', async () => {
      const { controller, recoveryExecutor } = buildRecovery();
      const session = await controller.open(ACTIVATION);
      recoveryExecutor.parkReconcile();

      await expect(session.applyVerified({})).resolves.toEqual({
        outcome: 'indeterminate',
        recoveryGeneration: '1',
      });
      await recoveryExecutor.reconcileReached;

      const release = trackSystemRecordControllerReleaseV1(controller);
      await nextSystemRecordLifecycleTurnV1();

      expect(release.hasSettled()).toBe(false);
      expectSystemRecordControllerSlotRetainedV1(() =>
        createSystemRecordLaneControllerV1({
          lease: ownership.lease,
          handoff: new RecordingHandoff(),
          executor: new StubExecutor(),
          barrier: barrier.run,
        }));

      recoveryExecutor.releaseReconcile();
      await release.completion;

      await releaseReplacementSystemRecordControllerV1(() =>
        createSystemRecordLaneControllerV1({
          lease: ownership.lease,
          handoff: new RecordingHandoff(),
          executor: new StubExecutor(),
          barrier: barrier.run,
        }));
    });

    it('retains the single-writer registration when release wins before recovery registration', async () => {
      const gatedBarrier = new GateBarrier();
      gatedBarrier.gate('system-record.recovery');
      const { controller, recoveryExecutor } = buildRecovery(gatedBarrier);
      const session = await controller.open(ACTIVATION);
      recoveryExecutor.parkBeforeRegistration();

      const apply = session.applyVerified({});
      await recoveryExecutor.registrationReached;

      let released = false;
      const release = releaseSystemRecordLaneControllerV1(controller).then(() => {
        released = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      const releasedBeforeRegistration = released;

      recoveryExecutor.releaseRegistration();
      const applyResult = await apply.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      );
      let releasedBeforePhysicalSettlement = released;
      if (applyResult.status === 'fulfilled') {
        await gatedBarrier.reached('system-record.recovery');
        await new Promise((resolve) => setImmediate(resolve));
        releasedBeforePhysicalSettlement = released;
      }

      gatedBarrier.release('system-record.recovery');
      await release;

      expect(releasedBeforeRegistration).toBe(false);
      expect(releasedBeforePhysicalSettlement).toBe(false);
      expect(applyResult).toEqual({
        status: 'fulfilled',
        value: { outcome: 'indeterminate', recoveryGeneration: '1' },
      });

      const replacement = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff: new RecordingHandoff(),
        executor: new StubExecutor(),
        barrier: barrier.run,
      });
      await releaseSystemRecordLaneControllerV1(replacement);
    });

    it('waits for every admitted compatibility call and coalesces concurrent release', async () => {
      const controller = build();
      const session = await controller.open(ACTIVATION);
      executor.park();

      const first = session.applyVerified({ call: 1 });
      const second = session.applyVerified({ call: 2 });
      await executor.dispatched;
      expect(executor.calls).toHaveLength(2);

      let releases = 0;
      const releaseA = releaseSystemRecordLaneControllerV1(controller).then(() => {
        releases += 1;
      });
      const releaseB = releaseSystemRecordLaneControllerV1(controller).then(() => {
        releases += 1;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(releases).toBe(0);
      await expect(session.applyVerified({ call: 3 })).resolves.toEqual({
        outcome: 'capability-lost',
      });
      expect(executor.calls).toHaveLength(2);
      expect(() => build()).toThrow(SystemRecordControllerRegistrationError);

      executor.release();
      await Promise.all([first, second, releaseA, releaseB]);
      expect(releases).toBe(2);

      const replacement = build();
      await releaseSystemRecordLaneControllerV1(replacement);
    });

    it('rejects a recovery registrar retained after its apply invocation settled', async () => {
      const recoveryHandoff = new RecoveryHandoff(ownership);
      const capturingExecutor = new CapturingSettlementExecutor();
      const controller = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff: recoveryHandoff,
        executor: capturingExecutor,
        barrier: barrier.run,
      });
      const session = await controller.open(ACTIVATION);

      await expect(session.applyVerified({})).resolves.toEqual({ outcome: 'stale' });
      const binding = capturingExecutor.binding;
      const registrar = capturingExecutor.registrar;
      expect(binding).not.toBeNull();
      expect(registrar).not.toBeNull();
      expect(() => registrar?.(Object.freeze({
        ownership: Object.freeze(Object.create(null) as object),
        binding: binding!,
        reconcile: async () => Object.freeze({ resolution: 'unavailable' as const }),
      }))).toThrow(/no longer live for this apply invocation/);

      await releaseSystemRecordLaneControllerV1(controller);
    });

    it('rejects a copied binding from the live invocation registrar', async () => {
      const recoveryHandoff = new RecoveryHandoff(ownership);
      const mismatchedExecutor = new MismatchedBindingExecutor();
      const controller = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff: recoveryHandoff,
        executor: mismatchedExecutor,
        barrier: barrier.run,
      });
      const session = await controller.open(ACTIVATION);

      await expect(session.applyVerified({})).resolves.toEqual({ outcome: 'stale' });
      expect(mismatchedExecutor.registrationError).toEqual(expect.objectContaining({
        message: expect.stringMatching(/not bound to the admitted apply invocation/),
      }));
      expect(mismatchedExecutor.retryError).toEqual(expect.objectContaining({
        message: expect.stringMatching(/no longer live for this apply invocation/),
      }));
      await releaseSystemRecordLaneControllerV1(controller);
    });

    it.each([
      ['before recovery registration', false],
      ['after recovery registration', true],
    ] as const)('drains an executor rejection %s', async (_label, registerBeforeReject) => {
      const recoveryHandoff = new RecoveryHandoff(ownership);
      const rejectingExecutor = new RejectingSettlementExecutor(registerBeforeReject);
      const controller = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff: recoveryHandoff,
        executor: rejectingExecutor,
        barrier: barrier.run,
      });
      const session = await controller.open(ACTIVATION);

      await expect(session.applyVerified({})).rejects.toThrow(/settlement executor rejected/);
      if (registerBeforeReject) {
        await expect(rejectingExecutor.registration?.completion).resolves.toEqual({
          resolution: 'applied',
          stateRevision: '2',
          appliedStateDigest: `0x${'2'.repeat(64)}`,
        });
      }
      await expect(releaseSystemRecordLaneControllerV1(controller)).resolves.toBeUndefined();

      const replacement = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff: new RecordingHandoff(),
        executor: new StubExecutor(),
        barrier: barrier.run,
      });
      await releaseSystemRecordLaneControllerV1(replacement);
    });

    it('waits for the recovery barrier tail after the recovery token settles', async () => {
      const tailBarrier = new SettlementTailGateBarrier('system-record.recovery');
      const { controller, recoveryExecutor } = buildRecovery(tailBarrier);
      const session = await controller.open(ACTIVATION);

      await expect(session.applyVerified({})).resolves.toEqual({
        outcome: 'indeterminate',
        recoveryGeneration: '1',
      });
      await expect(recoveryExecutor.registration?.completion).resolves.toEqual({
        resolution: 'applied',
        stateRevision: '2',
        appliedStateDigest: `0x${'2'.repeat(64)}`,
      });
      await tailBarrier.tailReached;

      const release = trackSystemRecordControllerReleaseV1(controller);
      await nextSystemRecordLifecycleTurnV1();
      expect(release.hasSettled()).toBe(false);
      expectSystemRecordControllerSlotRetainedV1(() =>
        createSystemRecordLaneControllerV1({
          lease: ownership.lease,
          handoff: new RecordingHandoff(),
          executor: new StubExecutor(),
          barrier: barrier.run,
        }));

      tailBarrier.release();
      await release.completion;
      await releaseReplacementSystemRecordControllerV1(() =>
        createSystemRecordLaneControllerV1({
          lease: ownership.lease,
          handoff: new RecordingHandoff(),
          executor: new StubExecutor(),
          barrier: barrier.run,
        }));
    });

    it('accepts late bound recovery after a disable wait timeout clears the active binding', async () => {
      const waitTimeout = new WaitPhaseTimeoutBarrier('system-record.disable');
      const { controller, recoveryExecutor } = buildRecovery(waitTimeout);
      const session = await controller.open(ACTIVATION);
      recoveryExecutor.parkBeforeRegistration();

      const apply = session.applyVerified({});
      await recoveryExecutor.registrationReached;
      const disable = session.close('disable');
      const release = trackSystemRecordControllerReleaseV1(controller);
      await expect(disable).rejects.toThrow(/WAIT_TIMEOUT/);
      await nextSystemRecordLifecycleTurnV1();
      expect(release.hasSettled()).toBe(false);

      recoveryExecutor.releaseRegistration();
      await expect(apply).resolves.toEqual({
        outcome: 'indeterminate',
        recoveryGeneration: '1',
      });
      await release.completion;
      expect(release.hasSettled()).toBe(true);

      await releaseReplacementSystemRecordControllerV1(() =>
        createSystemRecordLaneControllerV1({
          lease: ownership.lease,
          handoff: new RecordingHandoff(),
          executor: new StubExecutor(),
          barrier: barrier.run,
        }));
    });

    it('keeps unavailable terminal when recovery registers after a disable wait timeout', async () => {
      const waitTimeout = new WaitPhaseTimeoutBarrier('system-record.disable');
      const { controller, recoveryExecutor } = buildRecovery(waitTimeout);
      const session = await controller.open(ACTIVATION);
      recoveryExecutor.parkBeforeRegistration();

      const apply = session.applyVerified({});
      await recoveryExecutor.registrationReached;
      await expect(session.close('disable')).rejects.toThrow(/WAIT_TIMEOUT/);
      expect(session.state).toBe('unavailable');

      recoveryExecutor.releaseRegistration();
      await expect(apply).resolves.toEqual({
        outcome: 'indeterminate',
        recoveryGeneration: '1',
      });
      await expect(recoveryExecutor.registration?.completion).resolves.toEqual({
        resolution: 'applied',
        stateRevision: '2',
        appliedStateDigest: `0x${'2'.repeat(64)}`,
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(session.state).toBe('unavailable');
      await expect(controller.open(ACTIVATION)).rejects.toThrow(/terminal \(unavailable\)/);
    });

    it('retains recovery attached before a disable wait timeout reports', async () => {
      const waitTimeout = new ControlledWaitPhaseTimeoutBarrier('system-record.disable');
      const { controller, recoveryExecutor } = buildRecovery(waitTimeout);
      const session = await controller.open(ACTIVATION);
      recoveryExecutor.parkBeforeRegistration();

      const apply = session.applyVerified({});
      await recoveryExecutor.registrationReached;
      const disable = session.close('disable');
      await waitTimeout.waitReached;

      recoveryExecutor.releaseRegistration();
      await expect(apply).resolves.toEqual({
        outcome: 'indeterminate',
        recoveryGeneration: '1',
      });
      const release = releaseSystemRecordLaneControllerV1(controller);
      waitTimeout.timeout();

      await expect(disable).rejects.toThrow(/WAIT_TIMEOUT/);
      await expect(release).rejects.toThrow(/WAIT_TIMEOUT/);
      expect(() =>
        createSystemRecordLaneControllerV1({
          lease: ownership.lease,
          handoff: new RecordingHandoff(),
          executor: new StubExecutor(),
          barrier: barrier.run,
        }),
      ).toThrow(SystemRecordControllerRegistrationError);
      let recoverySettled = false;
      void recoveryExecutor.registration?.completion.then(() => { recoverySettled = true; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(recoverySettled).toBe(false);
    });

    it('blocks a disable successor that was waiting behind recovery when detach latches', async () => {
      const { controller, recoveryHandoff, recoveryExecutor } = buildRecovery();
      const session = await controller.open(ACTIVATION);
      recoveryHandoff.calls.length = 0;
      recoveryExecutor.parkReconcile();

      await expect(session.applyVerified({})).resolves.toEqual({
        outcome: 'indeterminate',
        recoveryGeneration: '1',
      });
      await recoveryExecutor.reconcileReached;
      const disable = session.close('disable');
      const release = releaseSystemRecordLaneControllerV1(controller);

      recoveryExecutor.releaseReconcile();
      await Promise.all([disable, release]);
      expect(recoveryHandoff.calls).not.toContain('rotateMaterializationEpoch');
      expect(session.state).toBe('detached');

      const replacement = createSystemRecordLaneControllerV1({
        lease: ownership.lease,
        handoff: new RecordingHandoff(),
        executor: new StubExecutor(),
        barrier: barrier.run,
      });
      await releaseSystemRecordLaneControllerV1(replacement);
    });

    it('keeps a failed shutdown and late recovery globally claimed', async () => {
      const waitTimeout = new WaitPhaseTimeoutBarrier();
      const { controller, recoveryExecutor } = buildRecovery(waitTimeout);
      const session = await controller.open(ACTIVATION);
      recoveryExecutor.parkBeforeRegistration();

      const apply = session.applyVerified({});
      await recoveryExecutor.registrationReached;
      const shutdown = session.close('shutdown');
      const release = releaseSystemRecordLaneControllerV1(controller);
      await expect(shutdown).rejects.toThrow(/WAIT_TIMEOUT/);

      recoveryExecutor.releaseRegistration();
      await expect(apply).resolves.toEqual({
        outcome: 'indeterminate',
        recoveryGeneration: '1',
      });
      await expect(release).rejects.toThrow(/WAIT_TIMEOUT/);
      expect(session.state).toBe('shutdown');
      expect(() =>
        createSystemRecordLaneControllerV1({
          lease: ownership.lease,
          handoff: new RecordingHandoff(),
          executor: new StubExecutor(),
          barrier: barrier.run,
        }),
      ).toThrow(SystemRecordControllerRegistrationError);
    });

    it('retries owner quiescence without rerunning the detach decision', async () => {
      const controller = build();
      await controller.open(ACTIVATION);

      await expect(releaseSystemRecordLaneControllerV1(
        controller,
        () => Promise.reject(new Error('owner quiescence failed')),
      )).rejects.toThrow(/owner quiescence failed/);
      expect(() => build()).toThrow(SystemRecordControllerRegistrationError);

      await releaseSystemRecordLaneControllerV1(controller);
      const replacement = build();
      await releaseSystemRecordLaneControllerV1(replacement);
    });

    it('accepts an attributable exact result that returns after its dispatch deadline', async () => {
      const { controller, recoveryExecutor } = buildRecovery();
      const session = await controller.open(ACTIVATION);
      recoveryExecutor.parkReconcile();

      const apply = session.applyVerified({});
      await recoveryExecutor.reconcileReached;
      const runtime = recoveryExecutor.recoveredRuntime;
      expect(runtime?.assertAttributable()).toBe(true);
      const now = vi.spyOn(performance, 'now')
        .mockReturnValue((runtime?.absoluteDeadlineMs ?? 0) + 1);
      try {
        recoveryExecutor.releaseReconcile();
        await apply;
        await expect(recoveryExecutor.registration?.completion).resolves.toEqual({
          resolution: 'applied',
          stateRevision: '2',
          appliedStateDigest: `0x${'2'.repeat(64)}`,
        });
      } finally {
        now.mockRestore();
      }
      expect(session.state).toBe('enabled');
    });

    it('uses retained terminal cleanup when a late exact result is unavailable', async () => {
      const { controller, recoveryHandoff, recoveryExecutor } = buildRecovery();
      const session = await controller.open(ACTIVATION);
      recoveryExecutor.recoveryResolution = { resolution: 'unavailable' };
      recoveryExecutor.parkReconcile();

      const apply = session.applyVerified({});
      await recoveryExecutor.reconcileReached;
      const runtime = recoveryExecutor.recoveredRuntime;
      const now = vi.spyOn(performance, 'now')
        .mockReturnValue((runtime?.absoluteDeadlineMs ?? 0) + 1);
      try {
        recoveryExecutor.releaseReconcile();
        await apply;
        await expect(recoveryExecutor.registration?.completion).resolves.toEqual({
          resolution: 'unavailable',
        });
      } finally {
        now.mockRestore();
      }

      expect(recoveryHandoff.recoveryDeadlines.slice(-3)).toEqual([
        { phase: 'stop', value: undefined },
        { phase: 'destroy', value: undefined },
        { phase: 'drain', value: undefined },
      ]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(session.state).toBe('unavailable');
    });

    it('retains recovery ownership after a transition timeout until late settlement', async () => {
      const timeoutBarrier = new TransitionTimeoutBarrier();
      const { controller, recoveryExecutor } = buildRecovery(timeoutBarrier);
      const session = await controller.open(ACTIVATION);
      recoveryExecutor.parkReconcile();

      await session.applyVerified({});
      await recoveryExecutor.reconcileReached;
      let settled = false;
      void recoveryExecutor.registration?.completion.then(() => { settled = true; });
      timeoutBarrier.timeout('system-record.recovery');
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(session.state).toBe('reconciling');

      recoveryExecutor.releaseReconcile();
      await expect(recoveryExecutor.registration?.completion).resolves.toEqual({
        resolution: 'applied',
        stateRevision: '2',
        appliedStateDigest: `0x${'2'.repeat(64)}`,
      });
      expect(session.state).toBe('enabled');
    });

    it('keeps a never-settling timed-out recovery and shutdown claimed', async () => {
      const timeoutBarrier = new TransitionTimeoutBarrier();
      const { controller, recoveryExecutor } = buildRecovery(timeoutBarrier);
      const session = await controller.open(ACTIVATION);
      recoveryExecutor.parkReconcile();

      await session.applyVerified({});
      await recoveryExecutor.reconcileReached;
      let recoverySettled = false;
      void recoveryExecutor.registration?.completion.then(() => { recoverySettled = true; });
      timeoutBarrier.timeout('system-record.recovery');
      const shutdownState = { settled: false };
      void session.close('shutdown').then(
        () => { shutdownState.settled = true; },
        () => { shutdownState.settled = true; },
      );
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));

      expect(recoverySettled).toBe(false);
      expect(shutdownState.settled).toBe(false);
      expect(session.state).toBe('shutdown');
      expect(() =>
        createSystemRecordLaneControllerV1({
          lease: ownership.lease,
          handoff: new RecordingHandoff(),
          executor: new StubExecutor(),
          barrier: barrier.run,
        }),
      ).toThrow(SystemRecordControllerRegistrationError);
    });

    it('attaches uncertainty to a disable barrier that already owns the close', async () => {
      const gatedBarrier = new GateBarrier();
      gatedBarrier.gate('system-record.disable');
      const { controller, recoveryHandoff, recoveryExecutor } = buildRecovery(gatedBarrier);
      const session = await controller.open(ACTIVATION);
      recoveryHandoff.calls.length = 0;
      recoveryExecutor.parkBeforeRegistration();

      const apply = session.applyVerified({});
      await recoveryExecutor.registrationReached;
      const disable = session.close('disable');
      expect(session.state).toBe('disabling');
      await gatedBarrier.reached('system-record.disable');

      recoveryExecutor.releaseRegistration();
      await expect(apply).resolves.toEqual({ outcome: 'indeterminate', recoveryGeneration: '1' });
      // Registration joined the already-enqueued close; a second recovery
      // barrier behind disable would return too late and permit legacy bypass.
      expect(gatedBarrier.purposes).toEqual(['system-record.enable']);
      gatedBarrier.release('system-record.disable');
      await disable;

      expect(gatedBarrier.purposes).toEqual([
        'system-record.enable',
        'system-record.disable',
      ]);
      expect(recoveryHandoff.calls).toEqual([
        'stopAndProveOwnedChildDead',
        'destroyClient',
        'awaitRetiredWork',
        'startAndProveCleanGeneration',
        'createRecoveryRuntime',
        'rotateMaterializationEpoch',
      ]);
      expect(session.state).toBe('disabled');
    });

    it('keeps disable intent latched when recovery was registered first', async () => {
      const { controller, recoveryHandoff, recoveryExecutor } = buildRecovery();
      const session = await controller.open(ACTIVATION);
      recoveryHandoff.calls.length = 0;
      recoveryExecutor.parkReconcile();

      const apply = session.applyVerified({});
      await recoveryExecutor.reconcileReached;
      expect(session.state).toBe('reconciling');
      const disable = session.close('disable');
      expect(session.state).toBe('disabling');

      recoveryExecutor.releaseReconcile();
      await apply;
      await disable;
      expect(session.state).toBe('disabled');
      expect(recoveryHandoff.calls.at(-1)).toBe('rotateMaterializationEpoch');
      expect(recoveryHandoff.calls.filter((call) => call === 'startAndProveCleanGeneration'))
        .toHaveLength(1);
    });

    it('attaches uncertainty to shutdown without restart, post-read, or epoch rotation', async () => {
      const gatedBarrier = new GateBarrier();
      gatedBarrier.gate('system-record.shutdown');
      const { controller, recoveryHandoff, recoveryExecutor } = buildRecovery(gatedBarrier);
      const session = await controller.open(ACTIVATION);
      recoveryHandoff.calls.length = 0;
      recoveryExecutor.parkBeforeRegistration();

      const apply = session.applyVerified({});
      await recoveryExecutor.registrationReached;
      const shutdown = session.close('shutdown');
      expect(session.state).toBe('shutdown');
      await gatedBarrier.reached('system-record.shutdown');

      recoveryExecutor.releaseRegistration();
      await apply;
      gatedBarrier.release('system-record.shutdown');
      await shutdown;
      await expect(recoveryExecutor.registration?.completion).resolves.toEqual({
        resolution: 'unavailable',
      });

      expect(recoveryHandoff.calls).toEqual([
        'stopAndProveOwnedChildDead',
        'destroyClient',
        'awaitRetiredWork',
      ]);
      expect(recoveryHandoff.calls).not.toContain('startAndProveCleanGeneration');
      expect(recoveryHandoff.calls).not.toContain('createRecoveryRuntime');
      expect(recoveryHandoff.calls).not.toContain('rotateMaterializationEpoch');
      expect(session.state).toBe('shutdown');
    });

    it('reports an attached shutdown that cannot prove the uncertain child dead', async () => {
      const gatedBarrier = new GateBarrier();
      gatedBarrier.gate('system-record.shutdown');
      const { controller, recoveryHandoff, recoveryExecutor } = buildRecovery(gatedBarrier);
      const session = await controller.open(ACTIVATION);
      recoveryExecutor.parkBeforeRegistration();

      const apply = session.applyVerified({});
      await recoveryExecutor.registrationReached;
      const shutdown = session.close('shutdown');
      await gatedBarrier.reached('system-record.shutdown');
      recoveryHandoff.failAt = 'stopAndProveOwnedChildDead';
      recoveryExecutor.releaseRegistration();
      await apply;
      gatedBarrier.release('system-record.shutdown');

      await expect(shutdown).rejects.toThrow(/could not prove uncertain write settled/);
      let recoverySettled = false;
      void recoveryExecutor.registration?.completion.then(() => { recoverySettled = true; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(recoverySettled).toBe(false);
      expect(session.state).toBe('shutdown');
    });

    it('never republishes enabled when shutdown latches during exact settlement', async () => {
      const { controller, recoveryHandoff, recoveryExecutor } = buildRecovery();
      const session = await controller.open(ACTIVATION);
      recoveryHandoff.calls.length = 0;
      recoveryExecutor.parkReconcile();

      const apply = session.applyVerified({});
      await recoveryExecutor.reconcileReached;
      const shutdown = session.close('shutdown');
      expect(session.state).toBe('shutdown');
      recoveryExecutor.releaseReconcile();

      await apply;
      await shutdown;
      await expect(recoveryExecutor.registration?.completion).resolves.toEqual({
        resolution: 'unavailable',
      });
      expect(session.state).toBe('shutdown');
      await expect(controller.open(ACTIVATION)).rejects.toThrow(/terminal/);
      // The replacement was already started before shutdown intent, so the
      // shutdown transition must perform one additional teardown for it.
      expect(recoveryHandoff.calls.filter((call) => call === 'stopAndProveOwnedChildDead'))
        .toHaveLength(2);
    });

    it('fails terminally closed when exact settlement is unavailable', async () => {
      const { controller, recoveryExecutor } = buildRecovery();
      const session = await controller.open(ACTIVATION);
      recoveryExecutor.recoveryResolution = { resolution: 'unavailable' };

      expect((await session.applyVerified({})).outcome).toBe('indeterminate');
      await expect(recoveryExecutor.registration?.completion).resolves.toEqual({
        resolution: 'unavailable',
      });
      // Completion resolves before the lifecycle tail publishes terminality;
      // yield once to observe the fail-closed state transition.
      await new Promise((resolve) => setImmediate(resolve));
      expect(session.state).toBe('unavailable');
      await expect(controller.open(ACTIVATION)).rejects.toThrow(/terminal/);
    });

    for (const failAt of [
      'stopAndProveOwnedChildDead',
      'destroyClient',
      'awaitRetiredWork',
      'startAndProveCleanGeneration',
      'createRecoveryRuntime',
    ] as const) {
      it(`fails closed and retains ownership safely when recovery fails at ${failAt}`, async () => {
        const { controller, recoveryHandoff, recoveryExecutor } = buildRecovery();
        const session = await controller.open(ACTIVATION);
        recoveryHandoff.calls.length = 0;
        recoveryHandoff.failAt = failAt;

        expect((await session.applyVerified({})).outcome).toBe('indeterminate');
        if (
          failAt === 'stopAndProveOwnedChildDead' ||
          failAt === 'destroyClient' ||
          failAt === 'awaitRetiredWork'
        ) {
          let recoverySettled = false;
          void recoveryExecutor.registration?.completion.then(() => { recoverySettled = true; });
          await new Promise((resolve) => setImmediate(resolve));
          expect(recoverySettled).toBe(false);
        } else {
          await expect(recoveryExecutor.registration?.completion).resolves.toEqual({
            resolution: 'unavailable',
          });
        }
        await new Promise((resolve) => setImmediate(resolve));

        expect(session.state).toBe('unavailable');
        expect(recoveryHandoff.calls.some((call) =>
          call.startsWith('failManagedMutationsClosed:'))).toBe(true);
      });
    }

    it('shutdown cancels and joins disable-attached exact recovery without a second teardown', async () => {
      const gatedBarrier = new GateBarrier();
      gatedBarrier.gate('system-record.disable');
      const { controller, recoveryHandoff, recoveryExecutor } = buildRecovery(gatedBarrier);
      const session = await controller.open(ACTIVATION);
      recoveryHandoff.calls.length = 0;
      recoveryExecutor.parkBeforeRegistration();
      recoveryExecutor.parkReconcileUntilAbort();

      const apply = session.applyVerified({});
      await recoveryExecutor.registrationReached;
      const disable = session.close('disable');
      await gatedBarrier.reached('system-record.disable');
      recoveryExecutor.releaseRegistration();
      await apply;
      gatedBarrier.release('system-record.disable');
      await recoveryExecutor.reconcileReached;

      // No test release exists for the exact read. Shutdown must abort the
      // lifecycle-owned signal, await that rejection, then reuse the recovery's
      // physical-settlement token instead of stopping the replacement twice.
      const shutdown = session.close('shutdown');
      await Promise.allSettled([disable, shutdown]);

      expect(recoveryExecutor.recoveredRuntime?.signal.aborted).toBe(true);
      expect(recoveryHandoff.calls.filter((call) =>
        call === 'stopAndProveOwnedChildDead')).toHaveLength(2);
      expect(gatedBarrier.purposes).toEqual([
        'system-record.enable',
        'system-record.disable',
      ]);
      expect(session.state).toBe('shutdown');
    });
  });
});
