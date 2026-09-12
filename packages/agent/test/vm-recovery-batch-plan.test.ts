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

describe('VM recovery batch transaction', () => {
  it.each(['expired', 'empty-observation'] as const)('cancels a freshly reserved %s target during discovery', reason => {
    const registry = new VmRecoverySlotRegistry(1);
    const selected = target(0);
    registry.prepare(selected, {
      candidatePeerIds: ['peer'], curatorRosterConfirmed: true, collectionDeadlineAt: 10,
    }, 0);
    const transaction = registry.beginBatch();
    try {
      expect(transaction.reserveBatch({
        targets: [selected], admissionCursor: 0,
        observedCandidatePeerIds: reason === 'expired' ? ['peer'] : [],
        now: reason === 'expired' ? 11 : 1, collectionDeadlineAt: 100,
      }).initiallyEligibleTargets).toEqual([selected]);
      registry.invalidate(selected);
      expect(transaction.signal.aborted).toBe(true);
      expect(transaction.commit({
        candidatePeerIds: ['peer'], curatorRosterConfirmed: true, now: 12,
        collectionDeadlineAt: 100, isCurrent: () => true,
      }).eligible).toEqual([]);
      expect(registry.recordCount).toBe(0);
    } finally { transaction.release(); }
  });

  it('releases every pending reservation when retaining a batch entry throws', () => {
    class FailingRegistry extends VmRecoverySlotRegistry {
      protected override onRetention() { throw new Error('retention failed'); }
    }
    const registry = new FailingRegistry(2);
    const transaction = registry.beginBatch();
    transaction.reserveBatch({
      targets: [target(0), target(1)], admissionCursor: 0,
      observedCandidatePeerIds: ['peer'], now: 0, collectionDeadlineAt: 100,
    });
    expect(() => transaction.commit({
      candidatePeerIds: ['peer'], curatorRosterConfirmed: true, now: 1,
      collectionDeadlineAt: 100, isCurrent: () => true,
    })).toThrow('retention failed');
    // Reserve both slots through a different scope before caller cleanup. A
    // leaked second reservation would keep the second claimant at capacity.
    const next = registry.begin();
    try {
      expect(next.reserveAdmission(target(2), 2).kind).toBe('reserved');
      expect(next.reserveAdmission(target(3), 2).kind).toBe('reserved');
      expect(registry.recordCount).toBe(0);
    } finally { next.release(); transaction.release(); }
  });

  it.each(['expired', 'empty-observation'] as const)('readmits its own %s evidence before same-pass discovery', reason => {
    const registry = new VmRecoverySlotRegistry(1);
    const selected = target(0);
    const original = registry.prepare(selected, {
      candidatePeerIds: ['peer'], curatorRosterConfirmed: true, collectionDeadlineAt: 10,
    }, 0).slot!;
    const transaction = registry.beginBatch();
    const plan = transaction.reserveBatch({
      targets: [selected], admissionCursor: 0,
      observedCandidatePeerIds: reason === 'expired' ? ['peer'] : [],
      now: reason === 'expired' ? 11 : 1, collectionDeadlineAt: 100,
    });
    try {
      expect(plan.initiallyEligibleTargets).toEqual([selected]);
      expect(registry.isCurrent(selected, original.handle)).toBe(false);
      const committed = transaction.commit({
        candidatePeerIds: ['peer'], curatorRosterConfirmed: true,
        now: 12, collectionDeadlineAt: 100, isCurrent: () => !transaction.signal.aborted,
      });
      expect(committed.eligible.map(entry => entry.target)).toEqual([selected]);
      expect(committed.eligible[0]!.prepared.slot!.snapshot.candidatePeerIds).toEqual(['peer']);
      expect(committed.eligible[0]!.prepared.slot!.handle).not.toBe(original.handle);
      expect(registry.recordCount).toBe(1);
      expect(transaction.signal.aborted).toBe(false);
    } finally { transaction.release(); }
  });

  it.each(['existing', 'reserved'] as const)('binds a %s target before discovery without caller tracking', kind => {
    const registry = new VmRecoverySlotRegistry(1);
    const selected = target(0);
    if (kind === 'existing') registry.prepare(selected, {
      candidatePeerIds: ['peer'], curatorRosterConfirmed: true, collectionDeadlineAt: 100,
    }, 0);
    const transaction = registry.beginBatch();
    const plan = transaction.reserveBatch({
      targets: [selected], admissionCursor: 0, observedCandidatePeerIds: ['peer'],
      now: 1, collectionDeadlineAt: 101,
    });
    expect(plan.initiallyEligibleTargets).toEqual([selected]);
    registry.invalidate(selected);
    expect(transaction.signal.aborted).toBe(true);
    expect(transaction.commit({
      candidatePeerIds: ['peer'], curatorRosterConfirmed: true,
      now: 2, collectionDeadlineAt: 102, isCurrent: () => true,
    }).eligible).toEqual([]);
    expect(registry.recordCount).toBe(0);
    transaction.release();
  });

  it.each((['expired', 'empty-observation'] as const).flatMap(reason =>
    (['same-fingerprint', 'changed-fingerprint', 'recordless'] as const).map(replacement => ({ reason, replacement })),
  ))('preserves an abort callback replacement during $reason retirement: $replacement', ({ reason, replacement }) => {
    const registry = new VmRecoverySlotRegistry(1);
    const selected = target(0);
    registry.prepare(selected, {
      candidatePeerIds: ['peer'], curatorRosterConfirmed: true, collectionDeadlineAt: 10,
    }, 0);
    const observer = registry.begin();
    const replacementScope = registry.begin();
    observer.track([selected]);
    const replacementTarget = replacement === 'changed-fingerprint'
      ? { ...selected, merkleRoot: 'replacement-root' } : selected;
    observer.signal.addEventListener('abort', () => {
      replacementScope.track([replacementTarget]);
      if (replacement !== 'recordless') registry.prepare(replacementTarget, {
        candidatePeerIds: ['replacement-peer'], curatorRosterConfirmed: true, collectionDeadlineAt: 100,
      }, 12);
    }, { once: true });
    const transaction = registry.beginBatch();
    try {
      const plan = transaction.reserveBatch({
        targets: [selected], admissionCursor: 0,
        observedCandidatePeerIds: reason === 'expired' ? ['peer'] : [],
        now: reason === 'expired' ? 11 : 1, collectionDeadlineAt: 100,
      });
      const replacementRecord = registry.capture(replacementTarget);
      expect(observer.signal.aborted).toBe(true);
      expect(plan.initiallyEligibleTargets).toEqual([]);
      expect(transaction.commit({
        candidatePeerIds: ['peer'], curatorRosterConfirmed: true, now: 12,
        collectionDeadlineAt: 100, isCurrent: () => true,
      }).eligible).toEqual([]);
      expect(replacementScope.signal.aborted).toBe(false);
      expect(registry.capture(replacementTarget)).toEqual(replacementRecord);
      expect(registry.recordCount).toBe(replacement === 'recordless' ? 0 : 1);
    } finally {
      transaction.release();
      observer.release();
      replacementScope.release();
    }
  });

  it('binds an owner newly released from backoff before exposing it for transport', () => {
    const registry = new VmRecoverySlotRegistry(2);
    const suppressed = target(0);
    const waiting = target(1);
    const prepared = registry.prepare(suppressed, {
      candidatePeerIds: ['old-peer'], curatorRosterConfirmed: true, collectionDeadlineAt: 100,
    }, 0);
    registry.settleAttempt(suppressed, 'old-peer', 'clean-absent', ['old-peer'], prepared.slot!.handle, {
      now: 1, getLocalPeerId: () => 'local', baseBackoffMs: 100, maxBackoffMs: 100,
    });
    const transaction = registry.beginBatch();
    const plan = transaction.reserveBatch({
      targets: [suppressed, waiting], admissionCursor: 0, observedCandidatePeerIds: ['old-peer'],
      now: 2, collectionDeadlineAt: 102,
    });
    expect(plan.initiallyEligibleTargets).toEqual([waiting]);
    const committed = transaction.commit({
      candidatePeerIds: ['old-peer', 'new-peer'], curatorRosterConfirmed: true,
      now: 3, collectionDeadlineAt: 103, isCurrent: () => true,
    });
    expect(committed.eligible.map(entry => entry.target)).toEqual([suppressed, waiting]);
    expect(transaction.signal.aborted).toBe(false);
    registry.invalidate(suppressed);
    expect(transaction.signal.aborted).toBe(true);
    transaction.release();
  });

  it.each(['existing', 'reserved'] as const)('commits an authoritative replacement roster for a %s target', kind => {
    const registry = new VmRecoverySlotRegistry(1);
    const selected = target(0);
    if (kind === 'existing') {
      const prepared = registry.prepare(selected, {
        candidatePeerIds: ['old-peer'], curatorRosterConfirmed: false, collectionDeadlineAt: 100,
      }, 0);
      expect(prepared.slot).toBeDefined();
      registry.settleAttempt(selected, 'old-peer', 'clean-absent', ['old-peer'], prepared.slot!.handle, {
        now: 1, getLocalPeerId: () => 'local', baseBackoffMs: 10, maxBackoffMs: 100,
      });
    }
    const transaction = registry.beginBatch();
    transaction.reserveBatch({
      targets: [selected], admissionCursor: 0, observedCandidatePeerIds: ['old-peer'],
      now: 2, collectionDeadlineAt: 102,
    });
    if (kind === 'existing') {
      const retained = registry.peekSnapshot(selected)!;
      expect(retained.attemptedPeerIds).toEqual(['old-peer']);
      expect(retained.cleanAbsentPeerIds).toEqual(['old-peer']);
    }
    const committed = transaction.commit({
      candidatePeerIds: ['new-peer'], curatorRosterConfirmed: true,
      now: 3, collectionDeadlineAt: 103, isCurrent: () => !transaction.signal.aborted,
    });
    expect(committed.eligible).toHaveLength(1);
    const snapshot = committed.eligible[0]!.prepared.slot!.snapshot;
    expect(snapshot.candidatePeerIds).toEqual(['new-peer']);
    expect(snapshot.attemptedPeerIds).toEqual([]);
    expect(snapshot.cleanAbsentPeerIds).toEqual([]);
    expect(snapshot).toMatchObject({
      phase: 'collecting',
      curatorRosterConfirmed: true, collectionDeadlineAt: 103, failures: 0, nextRetryAt: 0,
    });
    transaction.release();
  });

  it.each(['existing', 'reserved'] as const)('leaves an empty roster without evidence for a %s target', kind => {
    const registry = new VmRecoverySlotRegistry(1);
    const selected = target(0);
    if (kind === 'existing') registry.prepare(selected, {
      candidatePeerIds: ['old-peer'], curatorRosterConfirmed: true, collectionDeadlineAt: 100,
    }, 0);
    const transaction = registry.beginBatch();
    transaction.reserveBatch({
      targets: [selected], admissionCursor: 0, observedCandidatePeerIds: ['old-peer'],
      now: 1, collectionDeadlineAt: 101,
    });
    const committed = transaction.commit({
      candidatePeerIds: [], curatorRosterConfirmed: true, now: 2,
      collectionDeadlineAt: 102, isCurrent: () => !transaction.signal.aborted,
    });
    expect(committed.eligible).toEqual([{ index: 0, target: selected, prepared: { suppressed: false } }]);
    expect(registry.recordCount).toBe(0);
    expect(registry.peekSnapshot(selected)).toBeUndefined();
    transaction.release();
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
    const transaction = registry.beginBatch();
    const plan = transaction.reserveBatch({
      targets: [donor, waiting],
      admissionCursor: 1,
      observedCandidatePeerIds: ['old-peer'],
      now: 20,
      collectionDeadlineAt: 120,
    });

    expect(plan.initiallyEligibleTargets).toEqual([donor, waiting]);
    const committed = transaction.commit({
      candidatePeerIds: ['new-peer'],
      curatorRosterConfirmed: true,
      now: 21,
      collectionDeadlineAt: 100,
      isCurrent: () => true,
    });

    expect(committed.eligible.map(({ target: entry }) => entry.ordinal)).toEqual([1]);
    expect(committed.nextAdmissionCursor).toBe(0);
    expect(registry.peekSnapshot(donor)).toBeUndefined();
    expect(registry.peekSnapshot(waiting)?.candidatePeerIds).toEqual(['new-peer']);
    expect(registry.recordCount).toBe(1);
    transaction.release();
  });
});
