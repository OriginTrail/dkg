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

  private async step(name: string): Promise<void> {
    this.calls.push(name);
    if (this.failAt === name) throw new Error(`handoff failed at ${name}`);
  }

  destroyClient = () => this.step('destroyClient');
  stopAndProveOwnedChildDead = () => this.step('stopAndProveOwnedChildDead');
  awaitRetiredWork = () => this.step('awaitRetiredWork');
  startAndProveCleanGeneration = () => this.step('startAndProveCleanGeneration');
  rotateMaterializationEpoch = () => this.step('rotateMaterializationEpoch');
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

  const build = () => {
    const controller = createSystemRecordLaneControllerV1({
      lease: ownership.lease,
      handoff,
      executor,
    });
    return controller;
  };

  beforeEach(() => {
    __resetSystemRecordControllerRegistrationForTests();
    ownership = createManagedOxigraphOwnershipControllerV1();
    ownership.bindReadyGeneration();
    handoff = new RecordingHandoff();
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
