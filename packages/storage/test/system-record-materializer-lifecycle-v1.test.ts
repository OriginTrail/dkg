import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createManagedOxigraphOwnershipControllerV1,
  type ManagedOxigraphOwnershipControllerV1,
} from '../src/managed-oxigraph-ownership-v1-internal.js';
import {
  SystemRecordControllerRegistrationError,
  SystemRecordLaneActivationConflictError,
  __resetSystemRecordControllerRegistrationForTests,
  createSystemRecordLaneControllerV1,
  type SystemRecordApplyOutcomeV1,
  type SystemRecordChildHandoffV1,
  type SystemRecordLaneActivationV1,
  type SystemRecordLaneSessionV1,
} from '../src/system-record-materializer-v1.js';

const ACTIVATION: SystemRecordLaneActivationV1 = {
  networkId: 'testnet',
  kinds: ['agents'],
  mode: 'shadow',
};

/** Records the exact handoff order so the ordering invariant is observable. */
class RecordingHandoff implements SystemRecordChildHandoffV1 {
  readonly calls: string[] = [];
  failAt: string | null = null;
  barrier: RecordingBarrier | null = null;

  private async step(name: string): Promise<void> {
    this.calls.push(name);
    this.barrier?.note(name);
    if (this.failAt === name) throw new Error(`handoff failed at ${name}`);
  }

  destroyClient = () => this.step('destroyClient');
  stopAndProveOwnedChildDead = () => this.step('stopAndProveOwnedChildDead');
  awaitRetiredWork = () => this.step('awaitRetiredWork');
  startAndProveCleanGeneration = () => this.step('startAndProveCleanGeneration');
  rotateMaterializationEpoch = () => this.step('rotateMaterializationEpoch');
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

  calls: Array<{ childGeneration: string }> = [];
  onDispatch?: () => void;

  async applyVerified(_proof: unknown, childGeneration: string): Promise<SystemRecordApplyOutcomeV1> {
    this.calls.push({ childGeneration });
    this.onDispatch?.();
    return this.outcome;
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
    ownership = createManagedOxigraphOwnershipControllerV1();
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

    it('refuses to enable on terminal ownership', async () => {
      ownership.invalidate('port-release-unproven');
      await expect(build().open(ACTIVATION)).rejects.toThrow(/terminal/);
      expect(handoff.calls).toEqual([]);
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
      const silent = createManagedOxigraphOwnershipControllerV1();
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
      expect(handoff.calls).toEqual([]);
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
      expect(executor.calls).toEqual([{ childGeneration: '1' }]);
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

      const result = await session.applyVerified({});
      expect(result).toEqual({ outcome: 'deferred', reason: 'generation-changed' });
      expect(executor.calls).toHaveLength(0);
    });

    it('returns capability-lost after shutdown with zero dispatch', async () => {
      const session = await build().open(ACTIVATION);
      await session.close('shutdown');
      expect(await session.applyVerified({})).toEqual({ outcome: 'capability-lost' });
      expect(executor.calls).toHaveLength(0);
    });

    it('defers without dispatch while ownership is not ready', async () => {
      const session = await build().open(ACTIVATION);
      ownership.invalidate('child-exit');

      expect(await session.applyVerified({})).toEqual({
        outcome: 'deferred',
        reason: 'generation-changed',
      });
      expect(executor.calls).toHaveLength(0);
    });

    it('returns capability-lost without dispatch on terminal ownership', async () => {
      const session = await build().open(ACTIVATION);
      ownership.invalidate('shutdown');
      expect(await session.applyVerified({})).toEqual({ outcome: 'capability-lost' });
      expect(executor.calls).toHaveLength(0);
    });

    it('seals admission into reconciling after an indeterminate dispatch', async () => {
      const session = await build().open(ACTIVATION);
      executor.outcome = { outcome: 'indeterminate', recoveryGeneration: '1' };

      expect((await session.applyVerified({})).outcome).toBe('indeterminate');
      expect(session.state).toBe('reconciling');

      // No further work is admitted against a generation whose last write may
      // or may not have committed.
      executor.outcome = { outcome: 'applied', stateRevision: '2', appliedStateDigest: `0x${'b'.repeat(64)}` };
      expect(await session.applyVerified({})).toEqual({
        outcome: 'deferred',
        reason: 'generation-changed',
      });
      expect(executor.calls).toHaveLength(1);
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
});
