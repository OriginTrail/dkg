import { describe, expect, it } from 'vitest';
import { VmRecoverySlotRegistry } from '../src/internal/vm-recovery-slot-registry.js';
import type { OrdinalRecoveryTarget } from '../src/chain-reconciler.js';

const target = (ordinal: number): OrdinalRecoveryTarget => ({
  localCgId: 'cg-a',
  onChainCgId: '1',
  ordinal,
  kaId: String(ordinal),
  reason: 'no-swm',
  ual: `ka-${ordinal}`,
  merkleRoot: `root-${ordinal}`,
});

describe('VM recovery batch plan', () => {
  it.each(['existing', 'reserved'] as const)('commits an authoritative replacement roster for a %s target', kind => {
    const registry = new VmRecoverySlotRegistry(1);
    const selected = target(0);
    if (kind === 'existing') {
      const prepared = registry.prepare(selected, {
        candidatePeerIds: ['old-peer'], curatorRosterConfirmed: false, collectionDeadlineAt: 100,
      }, 0);
      expect(prepared.record).toBeDefined();
      registry.settleAttempt(selected, 'old-peer', 'incomplete', ['old-peer'], prepared.record!, {
        now: 1, getLocalPeerId: () => 'local', baseBackoffMs: 10, maxBackoffMs: 100,
      });
    }
    const scope = registry.begin();
    const plan = registry.prepareBatch({
      targets: [selected], admissionCursor: 0, observedCandidatePeerIds: ['old-peer'],
      now: 2, collectionDeadlineAt: 102, scope,
    });
    const committed = plan.commit({
      candidatePeerIds: ['new-peer'], curatorRosterConfirmed: true,
      now: 3, collectionDeadlineAt: 103, isCurrent: () => !scope.signal.aborted,
    });
    expect(committed.eligible).toHaveLength(1);
    expect(committed.eligible[0]!.prepared.record).toMatchObject({
      phase: 'collecting', candidatePeerIds: new Set(['new-peer']),
      attemptedPeerIds: new Set(), cleanAbsentPeerIds: new Set(),
      curatorRosterConfirmed: true, collectionDeadlineAt: 103, failures: 0, nextRetryAt: 0,
    });
    scope.release();
  });

  it.each(['existing', 'reserved'] as const)('leaves an empty roster without evidence for a %s target', kind => {
    const registry = new VmRecoverySlotRegistry(1);
    const selected = target(0);
    if (kind === 'existing') registry.prepare(selected, {
      candidatePeerIds: ['old-peer'], curatorRosterConfirmed: true, collectionDeadlineAt: 100,
    }, 0);
    const scope = registry.begin();
    const plan = registry.prepareBatch({
      targets: [selected], admissionCursor: 0, observedCandidatePeerIds: ['old-peer'],
      now: 1, collectionDeadlineAt: 101, scope,
    });
    const committed = plan.commit({
      candidatePeerIds: [], curatorRosterConfirmed: true, now: 2,
      collectionDeadlineAt: 102, isCurrent: () => !scope.signal.aborted,
    });
    expect(committed.eligible).toEqual([{ index: 0, target: selected, prepared: { suppressed: false } }]);
    expect(registry.recordCount).toBe(0);
    expect(registry.peekRecord(selected)).toBeUndefined();
    scope.release();
  });

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
    const plan = registry.prepareBatch({
      targets: [donor, waiting],
      admissionCursor: 1,
      observedCandidatePeerIds: ['old-peer'],
      now: 20,
      scope,
      collectionDeadlineAt: 120,
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
