import { describe, expect, it } from 'vitest';
import { VmRecoveryBatchPlan } from '../src/internal/vm-recovery-batch-plan.js';
import { VmRecoverySlotRegistry } from '../src/internal/vm-recovery-slot-registry.js';
import type { OrdinalRecoveryTarget } from '../src/chain-reconciler.js';

const target = (ordinal: number): OrdinalRecoveryTarget => ({
  localCgId: 'cg-a',
  onChainCgId: '1',
  ordinal,
  ual: `ka-${ordinal}`,
  merkleRoot: `root-${ordinal}`,
});

describe('VM recovery batch plan', () => {
  it('commits a waiting reservation after discovery and suppresses its donated owner', () => {
    const registry = new VmRecoverySlotRegistry(1);
    const donor = target(0);
    const waiting = target(1);
    expect(registry.admit(donor, {
      candidatePeerIds: ['old-peer'],
      curatorRosterConfirmed: true,
      collectionDeadlineAt: 10,
    }, 0).kind).toBe('admitted');
    const scope = registry.begin();
    const plan = new VmRecoveryBatchPlan({
      targets: [donor, waiting],
      admissionCursor: 1,
      observedCandidatePeerIds: ['old-peer'],
      now: 20,
      registry,
      scope,
      prepare: (candidate) => ({
        record: registry.peekRecord(candidate),
        suppressed: false,
      }),
    });

    expect(plan.initiallyEligibleTargets).toEqual([donor, waiting]);
    const committed = plan.commit({
      candidatePeerIds: ['new-peer'],
      curatorRosterConfirmed: true,
      now: 21,
      collectionDeadlineAt: 100,
      isCurrent: () => true,
    });

    expect(committed.eligible.map(({ target: entry }) => entry.ordinal)).toEqual([1]);
    expect(committed.nextAdmissionCursor).toBe(0);
    expect(registry.peekRecord(donor)).toBeUndefined();
    expect(registry.peekRecord(waiting)?.candidatePeerIds).toEqual(new Set(['new-peer']));
    expect(registry.recordCount).toBe(1);
    scope.release();
  });
});
