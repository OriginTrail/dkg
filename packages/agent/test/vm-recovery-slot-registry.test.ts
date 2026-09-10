import { describe, expect, it } from 'vitest';
import { VmRecoverySlotRegistry, type VmRecoverySlotScope } from '../src/internal/vm-recovery-slot-registry.js';
import type { VmRecoverySlotCapture, VmRecoveryRotationSnapshot } from '../src/dkg-agent-types.js';

const target = { localCgId: 'cg-a', onChainCgId: '1', ordinal: 0, ual: 'ka-0', merkleRoot: '0xABC' };

function admitFor(
  registry: VmRecoverySlotRegistry,
  value = target,
  now = 0,
): VmRecoverySlotCapture {
  const admission = registry.admit(value, {
    candidatePeerIds: ['peer-a'], curatorRosterConfirmed: true, collectionDeadlineAt: 100,
  }, now);
  if (admission.kind === 'deferred') throw new Error('expected slot admission');
  return admission.slot;
}

describe('active VM recovery slot ownership', () => {
  it.each(['immediate', 'reserved'] as const)('releases an empty %s roster without retiring a donor', kind => {
    const registry = new VmRecoverySlotRegistry(1);
    const original = admitFor(registry);
    const donorScope = registry.begin();
    donorScope.track([target]);
    const waiting = { ...target, ordinal: 1 };
    const scope = registry.begin();
    const reservation = kind === 'reserved' ? scope.reserveAdmission(waiting, 101) : undefined;
    if (kind === 'reserved') expect(reservation?.kind).toBe('reserved');
    expect(registry.prepare(waiting, {
      candidatePeerIds: [], curatorRosterConfirmed: true, collectionDeadlineAt: 201,
    }, 101, reservation?.kind === 'reserved' ? reservation.reservation : undefined)).toEqual({ suppressed: false });
    expect(registry.recordCount).toBe(1);
    expect(registry.capture(waiting)).toBeUndefined();
    expect(registry.capture(target)?.handle).toBe(original?.handle);
    expect(donorScope.signal.aborted).toBe(false);
    expect(registry.prepare(waiting, {
      candidatePeerIds: ['new-peer'], curatorRosterConfirmed: true, collectionDeadlineAt: 201,
    }, 101).slot).toBeDefined();
    scope.release();
    donorScope.release();
  });

  it('keeps captured snapshots stable while an explicit handle authorizes transitions', () => {
    const registry = new VmRecoverySlotRegistry(1);
    const { handle, snapshot } = admitFor(registry);
    const diagnostic = registry.snapshot().values().next().value!;
    expect(() => Object.assign(snapshot, { phase: 'backoff' })).toThrow(TypeError);
    expect(() => (snapshot.candidatePeerIds as string[]).push('forged-peer')).toThrow(TypeError);
    expect(snapshot.candidatePeerIds).toBe(snapshot.candidatePeerIds);
    registry.settleAttempt(target, 'peer-a', 'clean-absent', ['peer-a'], handle, {
      now: 10, getLocalPeerId: () => 'local', baseBackoffMs: 10, maxBackoffMs: 100,
    });
    expect(snapshot).toEqual(diagnostic);
    expect(snapshot).toMatchObject({ phase: 'collecting', failures: 0, attemptedPeerIds: [] });
    expect(registry.read(target, handle)).toMatchObject({
      phase: 'backoff', failures: 1, cleanAbsentPeerIds: ['peer-a'],
    });
    expect(registry.isCurrent(target, handle)).toBe(true);
  });

  it.each(['invalidation', 'same-fingerprint', 'different-fingerprint'] as const)(
    'rejects a stale handle after %s without changing captured snapshots', replacementKind => {
      const registry = new VmRecoverySlotRegistry(1);
      const captured = admitFor(registry);
      const diagnostic = registry.snapshot().values().next().value!;
      registry.invalidate(target);
      const replacementTarget = replacementKind === 'different-fingerprint'
        ? { ...target, merkleRoot: 'new-root' } : target;
      const replacement = replacementKind === 'invalidation' ? undefined : admitFor(registry, replacementTarget);
      expect(registry.isCurrent(target, captured.handle)).toBe(false);
      expect(registry.read(target, captured.handle)).toBeUndefined();
      registry.settleAttempt(target, 'peer-a', 'clean-absent', ['peer-a'], captured.handle, {
        now: 10, getLocalPeerId: () => 'local', baseBackoffMs: 10, maxBackoffMs: 100,
      });
      registry.touch(target, captured.handle);
      expect(captured.snapshot).toEqual(diagnostic);
      expect(captured.snapshot).toMatchObject({ phase: 'collecting', attemptedPeerIds: [] });
      expect(registry.capture(replacementTarget)).toEqual(replacement);
    },
  );

  it('does not retire a replacement installed by an invalidation listener during preparation', () => {
    const registry = new VmRecoverySlotRegistry(1);
    admitFor(registry);
    const originalScope = registry.begin();
    originalScope.track([target]);
    const replacement = { ...target, merkleRoot: 'listener-replacement' };
    let replacementScope: VmRecoverySlotScope | undefined;
    let replacementRecord: VmRecoverySlotCapture | undefined;
    originalScope.signal.addEventListener('abort', () => {
      replacementRecord = admitFor(registry, replacement);
      replacementScope = registry.begin();
      replacementScope.track([replacement]);
    }, { once: true });
    expect(registry.prepare({ ...target, merkleRoot: 'requested-replacement' }, {
      candidatePeerIds: ['peer-a'], curatorRosterConfirmed: true, collectionDeadlineAt: 100,
    }, 0)).toEqual({ suppressed: true });
    expect(registry.capture(replacement)?.handle).toBe(replacementRecord?.handle);
    expect(replacementScope?.signal.aborted).toBe(false);
    originalScope.release();
    replacementScope?.release();
  });

  it.each(['same', 'different'] as const)('preserves a %s-fingerprint replacement when unconfirmed proof is discarded', fingerprint => {
    const registry = new VmRecoverySlotRegistry(1);
    const original = admitFor(registry);
    registry.settleAttempt(target, 'peer-a', 'clean-absent', ['peer-a'], original.handle, {
      now: 0, getLocalPeerId: () => 'local', baseBackoffMs: 100, maxBackoffMs: 100,
    });
    const originalScope = registry.begin();
    originalScope.track([target]);
    const replacement = fingerprint === 'same' ? target : { ...target, merkleRoot: 'new-owner' };
    let replacementRecord: VmRecoverySlotCapture | undefined;
    let replacementScope: VmRecoverySlotScope | undefined;
    originalScope.signal.addEventListener('abort', () => {
      replacementRecord = admitFor(registry, replacement);
      replacementScope = registry.begin();
      replacementScope.track([replacement]);
    }, { once: true });
    expect.soft(registry.prepare(target, {
      candidatePeerIds: ['peer-b'], curatorRosterConfirmed: false, collectionDeadlineAt: 101,
    }, 1)).toEqual({ suppressed: true });
    expect(registry.capture(replacement)?.handle).toBe(replacementRecord?.handle);
    expect(replacementRecord?.snapshot.candidatePeerIds).toEqual(['peer-a']);
    expect(replacementScope?.signal.aborted).toBe(false);
    originalScope.release();
    replacementScope?.release();
  });

  it('binds one validated capacity to every admission path', () => {
    expect(() => new VmRecoverySlotRegistry(0)).toThrow(/positive safe integer/);
    const registry = new VmRecoverySlotRegistry(1);
    admitFor(registry);
    expect(registry.admit({ ...target, ordinal: 1 }, {
      candidatePeerIds: ['peer-a'], curatorRosterConfirmed: false, collectionDeadlineAt: 100,
    }, 0).kind).toBe('deferred');
    const scope = registry.begin();
    expect(scope.reserveAdmission({ ...target, ordinal: 2 }, 0).kind).toBe('deferred');
    scope.release();
  });

  it('preserves one live slot per graph across overlapping fair donations', () => {
    const registry = new VmRecoverySlotRegistry(2);
    admitFor(registry, target, 0);
    admitFor(registry, { ...target, ordinal: 1 }, 0);
    const scope = registry.begin();
    const first = scope.reserveAdmission({ ...target, localCgId: 'cg-b' }, 0);
    expect(first.kind).toBe('reserved');
    expect(scope.reserveAdmission({ ...target, localCgId: 'cg-c' }, 0).kind).toBe('deferred');
    expect(scope.reserveAdmission({ ...target, localCgId: 'cg-b', ordinal: 2 }, 0).kind).toBe('deferred');
    if (first.kind === 'reserved') first.reservation.release();
    const next = scope.reserveAdmission({ ...target, localCgId: 'cg-c' }, 0);
    expect(next.kind).toBe('reserved');
    if (next.kind === 'reserved') expect(next.reservation.commit({
      candidatePeerIds: ['peer-a'], curatorRosterConfirmed: false, collectionDeadlineAt: 100,
    }).kind).toBe('admitted');
    expect([...registry.snapshot().values()].map(record => record.localCgId)).toEqual(['cg-a', 'cg-c']);
    scope.release();
  });

  it.each((['immediate', 'delayed'] as const).flatMap(mode =>
    (['before-write', 'after-write'] as const).map(failure => ({ mode, failure })),
  ))('rolls back $mode donation after $failure failure without aborting its donor', ({ mode, failure }) => {
    class FailingRegistry extends VmRecoverySlotRegistry {
      failing = true;
      protected override onRetention(stage: 'before' | 'after', key: string): void {
        if (this.failing && key.endsWith('\0' + 1) && failure === `${stage}-write`) {
          throw new Error('install failed');
        }
      }
    }
    const registry = new FailingRegistry(1);
    const donorRecord = admitFor(registry, target, 0);
    const donorScope = registry.begin();
    donorScope.track([target]);
    const requesterScope = registry.begin();
    const waiting = { ...target, ordinal: 1 };
    const params = { candidatePeerIds: ['peer-a'], curatorRosterConfirmed: true, collectionDeadlineAt: 200 };
    if (mode === 'immediate') {
      expect(() => registry.admit(waiting, params, 100)).toThrow('install failed');
    } else {
      const admission = requesterScope.reserveAdmission(waiting, 100);
      expect(admission.kind).toBe('reserved');
      if (admission.kind === 'reserved') expect(() => admission.reservation.commit(params)).toThrow('install failed');
    }
    expect([...registry.snapshot().values()]).toEqual([donorRecord.snapshot]);
    expect(donorScope.signal.aborted).toBe(false);
    registry.failing = false;
    expect(registry.admit(waiting, params, 100).kind).toBe('admitted');
    expect(donorScope.signal.aborted).toBe(true);
    expect(registry.recordCount).toBe(1);
    donorScope.release();
    requesterScope.release();
  });

  it.each(['context', 'close'] as const)('preserves a replacement acquired by an abort listener during %s invalidation', kind => {
    const registry = new VmRecoverySlotRegistry(2);
    const other = { ...target, ordinal: 1 };
    const firstScope = registry.begin();
    const oldOtherScope = registry.begin();
    firstScope.track([target]);
    oldOtherScope.track([other]);
    const replacement = { ...other, merkleRoot: 'new-root' };
    let replacementScope: VmRecoverySlotScope | undefined;
    firstScope.signal.addEventListener('abort', () => {
      replacementScope = registry.begin();
      replacementScope.track([replacement]);
      admitFor(registry, replacement);
    }, { once: true });
    if (kind === 'context') registry.invalidateContextGraph(target.localCgId);
    else registry.close();
    expect(oldOtherScope.signal.aborted).toBe(true);
    expect(replacementScope?.signal.aborted).toBe(false);
    expect(registry.capture(replacement)).toBeDefined();
    firstScope.release();
    oldOtherScope.release();
    replacementScope?.release();
    registry.close();
  });

  it('reserves distinct donors and makes released capacity available to the next waiter', () => {
    const registry = new VmRecoverySlotRegistry(2);
    const donorA = admitFor(registry, target, 0);
    const donorB = admitFor(registry, { ...target, ordinal: 1 }, 0);
    const scope = registry.begin();
    const first = scope.reserveAdmission({ ...target, ordinal: 2 }, 100);
    const second = scope.reserveAdmission({ ...target, ordinal: 3 }, 100);
    expect(first.kind).toBe('reserved');
    expect(second.kind).toBe('reserved');
    expect(scope.reserveAdmission({ ...target, ordinal: 4 }, 100).kind).toBe('deferred');
    expect([...registry.snapshot().values()]).toEqual([donorA.snapshot, donorB.snapshot]);
    if (first.kind === 'reserved') first.reservation.release();
    const next = scope.reserveAdmission({ ...target, ordinal: 4 }, 100);
    expect(next.kind).toBe('reserved');
    const params = { candidatePeerIds: ['peer-a'], curatorRosterConfirmed: false, collectionDeadlineAt: 200 };
    if (second.kind === 'reserved') expect(second.reservation.commit(params).kind).toBe('admitted');
    if (next.kind === 'reserved') expect(next.reservation.commit(params).kind).toBe('admitted');
    expect([...registry.snapshot().values()].map(record => record.ordinal)).toEqual([3, 4]);
    expect(registry.recordCount).toBe(2);
    scope.release();
  });

  it.each(['before', 'after'] as const)('observes external donor replacement when tracked %s reservation', order => {
    const registry = new VmRecoverySlotRegistry(1);
    admitFor(registry, target, 0);
    const waiting = { ...target, ordinal: 1 };
    const scope = registry.begin();
    if (order === 'before') scope.track([target, waiting]);
    const admission = scope.reserveAdmission(waiting, 100);
    expect(admission.kind).toBe('reserved');
    if (order === 'after') scope.track([target, waiting]);
    const replacement = { ...target, merkleRoot: 'new-root' };
    const record = admitFor(registry, replacement, 100);
    expect(scope.signal.aborted).toBe(true);
    if (admission.kind === 'reserved') expect(admission.reservation.commit({
      candidatePeerIds: ['peer-a'], curatorRosterConfirmed: false, collectionDeadlineAt: 200,
    }).kind).toBe('deferred');
    expect(registry.capture(replacement)?.handle).toBe(record?.handle);
    scope.release();
  });

  it.each(['before', 'after'] as const)('suppresses only its own donation when tracked %s reservation', order => {
    const registry = new VmRecoverySlotRegistry(1);
    admitFor(registry, target, 0);
    const otherScope = registry.begin();
    otherScope.track([target]);
    const waiting = { ...target, ordinal: 1 };
    const scope = registry.begin();
    if (order === 'before') scope.track([target, waiting]);
    const admission = scope.reserveAdmission(waiting, 100);
    expect(admission.kind).toBe('reserved');
    if (order === 'after') scope.track([target, waiting]);
    if (admission.kind === 'reserved') expect(admission.reservation.commit({
      candidatePeerIds: ['peer-a'], curatorRosterConfirmed: false, collectionDeadlineAt: 200,
    }).kind).toBe('admitted');
    expect(otherScope.signal.aborted).toBe(true);
    expect(scope.signal.aborted).toBe(false);
    expect(registry.capture(target)).toBeUndefined();
    expect(registry.capture(waiting)).toBeDefined();
    registry.invalidate(waiting);
    expect(scope.signal.aborted).toBe(true);
    scope.release();
    otherScope.release();
  });

  it('counts delayed open-capacity reservations during immediate admission', () => {
    const registry = new VmRecoverySlotRegistry(1);
    const scope = registry.begin();
    const admission = scope.reserveAdmission(target, 0);
    expect(admission.kind).toBe('reserved');
    expect(registry.admit({ ...target, ordinal: 1 }, {
      candidatePeerIds: ['peer-a'], curatorRosterConfirmed: false, collectionDeadlineAt: 100,
    }, 0).kind).toBe('deferred');
    if (admission.kind === 'reserved') expect(admission.reservation.commit({
      candidatePeerIds: ['peer-a'], curatorRosterConfirmed: false, collectionDeadlineAt: 100,
    }).kind).toBe('admitted');
    expect(registry.recordCount).toBe(1);
    scope.release();
  });

  it.each(['target', 'context', 'close'] as const)('retires an untracked pending admission on %s invalidation', kind => {
    const registry = new VmRecoverySlotRegistry(1);
    const scope = registry.begin();
    const admission = scope.reserveAdmission(target, 0);
    expect(admission.kind).toBe('reserved');
    if (kind === 'target') registry.observeTarget({ ...target, merkleRoot: 'new-root' });
    else if (kind === 'context') registry.invalidateContextGraph(target.localCgId);
    else registry.close();
    if (admission.kind === 'reserved') expect(admission.reservation.commit({
      candidatePeerIds: ['peer-a'], curatorRosterConfirmed: false, collectionDeadlineAt: 100,
    }).kind).toBe('deferred');
    expect(registry.recordCount).toBe(0);
    expect(admitFor(registry, target, 0)).toBeDefined();
    scope.release();
  });

  it('keeps snapshot membership fixed while later reads reflect slot transitions', () => {
    const registry = new VmRecoverySlotRegistry(2);
    const empty = registry.snapshot();
    const record = admitFor(registry, target, 0);
    const installed = registry.snapshot();
    expect(empty.size).toBe(0);
    expect([...installed.values()]).toEqual([record.snapshot]);
    registry.complete(target);
    expect([...installed.values()]).toEqual([record.snapshot]);
    expect(registry.snapshot().size).toBe(0);
  });

  it('retires evidence on completion while preserving cancellation ownership until physical release', () => {
    const registry = new VmRecoverySlotRegistry(2);
    const record = admitFor(registry);
    const scope = registry.begin();
    scope.track([target]);
    registry.touch(target, record.handle);
    registry.complete(target);
    expect(registry.recordCount).toBe(0);
    expect(scope.signal.aborted).toBe(false);
    registry.invalidateContextGraph(target.localCgId);
    expect(scope.signal.aborted).toBe(true);
    scope.release();
  });

  it('invalidates retained and record-less slots together while isolating other graphs', () => {
    const registry = new VmRecoverySlotRegistry(2);
    const unowned = { ...target, ordinal: 1 };
    const other = { ...target, localCgId: 'cg-b' };
    admitFor(registry);
    const otherRecord = admitFor(registry, other);
    const local = registry.begin();
    const remote = registry.begin();
    local.track([target, unowned]);
    remote.track([other]);
    registry.invalidateContextGraph(target.localCgId);
    expect(local.signal.aborted).toBe(true);
    expect(remote.signal.aborted).toBe(false);
    expect([...registry.snapshot().values()]).toEqual([otherRecord.snapshot]);
    registry.close();
    expect(remote.signal.aborted).toBe(true);
    expect(registry.recordCount).toBe(0);
    local.release();
    remote.release();
  });

  it('keeps reads pure and replaces a fingerprint only at explicit observation', () => {
    const registry = new VmRecoverySlotRegistry(2);
    const oldRecord = admitFor(registry, target, 0);
    const active = registry.begin();
    active.track([target]);
    const replacement = { ...target, merkleRoot: '0xdef' };
    expect(registry.capture(replacement)).toBeUndefined();
    expect(registry.isCurrent(replacement, oldRecord.handle)).toBe(false);
    expect(registry.recordCount).toBe(1);
    expect(active.signal.aborted).toBe(false);
    registry.observeTarget(replacement);
    expect(registry.recordCount).toBe(0);
    expect(active.signal.aborted).toBe(true);
    const record = admitFor(registry, replacement, 0);
    expect(registry.capture(replacement)?.handle).toBe(record?.handle);
    active.release();
  });

  it('aborts an expired donor only after installing the waiting record within capacity', () => {
    const registry = new VmRecoverySlotRegistry(1);
    admitFor(registry, target, 0);
    const donor = registry.begin();
    donor.track([target]);
    const waitingTarget = { ...target, localCgId: 'cg-b' };
    let recordsAtAbort: VmRecoveryRotationSnapshot[] | undefined;
    donor.signal.addEventListener('abort', () => { recordsAtAbort = [...registry.snapshot().values()]; });
    const waiting = admitFor(registry, waitingTarget, 100);
    expect(donor.signal.aborted).toBe(true);
    expect(recordsAtAbort).toEqual([waiting.snapshot]);
    donor.release();
  });

  it('keeps a shared generation alive when one caller releases it', () => {
    const lifetimes = new VmRecoverySlotRegistry(2);
    const first = lifetimes.begin();
    const second = lifetimes.begin();
    first.track([target, target]);
    second.track([{ ...target, merkleRoot: '0xabc' }]);
    expect(first.signal.aborted).toBe(false);
    first.release();
    first.release();
    expect(second.signal.aborted).toBe(false);
    lifetimes.invalidate(target);
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false);
    second.release();
  });

  it('does not let an old completion retire its replacement generation', () => {
    const lifetimes = new VmRecoverySlotRegistry(2);
    const old = lifetimes.begin();
    old.track([target]);
    const replacement = lifetimes.begin();
    replacement.track([{ ...target, merkleRoot: '0xdef' }]);
    expect(old.signal.aborted).toBe(true);
    old.release();
    expect(replacement.signal.aborted).toBe(false);
    lifetimes.invalidateContextGraph(target.localCgId);
    expect(replacement.signal.aborted).toBe(true);
    replacement.release();
  });

  it('isolates context graphs and permits new work after a drained close', () => {
    const lifetimes = new VmRecoverySlotRegistry(2);
    const first = lifetimes.begin();
    const other = lifetimes.begin();
    first.track([target]);
    other.track([{ ...target, localCgId: 'cg-b' }]);
    lifetimes.invalidateContextGraph(target.localCgId);
    expect(first.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    lifetimes.close();
    expect(other.signal.aborted).toBe(true);
    const restarted = lifetimes.begin();
    restarted.track([target]);
    first.release();
    other.release();
    expect(restarted.signal.aborted).toBe(false);
    lifetimes.close();
    expect(restarted.signal.aborted).toBe(true);
    restarted.release();
  });

  it('cannot reacquire cancellation ownership through a released scope', () => {
    const lifetimes = new VmRecoverySlotRegistry(2);
    const finished = lifetimes.begin();
    finished.track([target]);
    finished.release();
    finished.track([target]);
    lifetimes.close();
    expect(finished.signal.aborted).toBe(false);
  });
});
