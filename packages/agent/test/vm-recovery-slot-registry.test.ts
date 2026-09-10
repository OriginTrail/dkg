import { describe, expect, it } from 'vitest';
import { VmRecoverySlotRegistry } from '../src/internal/vm-recovery-slot-registry.js';
import type { VmReconcileRotationRecord } from '../src/dkg-agent-types.js';

const target = { localCgId: 'cg-a', onChainCgId: '1', ordinal: 0, ual: 'ka-0', merkleRoot: '0xABC' };

function admitFor(
  registry: VmRecoverySlotRegistry,
  value = target,
  now = 0,
  maxEntries = 2,
): VmReconcileRotationRecord {
  const admission = registry.admit(value, {
    candidatePeerIds: ['peer-a'], curatorRosterConfirmed: true, collectionDeadlineAt: 100,
  }, now, maxEntries);
  if (admission.kind === 'deferred') throw new Error('expected slot admission');
  return admission.record;
}

describe('active VM recovery slot ownership', () => {
  it('keeps snapshot membership fixed while later reads reflect slot transitions', () => {
    const registry = new VmRecoverySlotRegistry();
    const empty = registry.snapshot();
    const record = admitFor(registry, target, 0, 1);
    const installed = registry.snapshot();
    expect(empty.size).toBe(0);
    expect([...installed.values()]).toEqual([record]);
    registry.complete(target);
    expect([...installed.values()]).toEqual([record]);
    expect(registry.snapshot().size).toBe(0);
  });

  it('retires evidence on completion while preserving cancellation ownership until physical release', () => {
    const registry = new VmRecoverySlotRegistry();
    const record = admitFor(registry);
    const scope = registry.begin();
    scope.track([target]);
    registry.touch(target, record);
    registry.complete(target);
    expect(registry.recordCount).toBe(0);
    expect(scope.signal.aborted).toBe(false);
    registry.invalidateContextGraph(target.localCgId);
    expect(scope.signal.aborted).toBe(true);
    scope.release();
  });

  it('invalidates retained and record-less slots together while isolating other graphs', () => {
    const registry = new VmRecoverySlotRegistry();
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
    expect([...registry.snapshot().values()]).toEqual([otherRecord]);
    registry.close();
    expect(remote.signal.aborted).toBe(true);
    expect(registry.recordCount).toBe(0);
    local.release();
    remote.release();
  });

  it('keeps reads pure and replaces a fingerprint only at explicit observation', () => {
    const registry = new VmRecoverySlotRegistry();
    const oldRecord = admitFor(registry, target, 0, 1);
    const active = registry.begin();
    active.track([target]);
    const replacement = { ...target, merkleRoot: '0xdef' };
    expect(registry.peekRecord(replacement)).toBeUndefined();
    expect(registry.isCurrent(replacement, oldRecord)).toBe(false);
    expect(registry.recordCount).toBe(1);
    expect(active.signal.aborted).toBe(false);
    registry.observeTarget(replacement);
    expect(registry.recordCount).toBe(0);
    expect(active.signal.aborted).toBe(true);
    const record = admitFor(registry, replacement, 0, 1);
    expect(registry.peekRecord(replacement)).toBe(record);
    active.release();
  });

  it('aborts an expired donor only after installing the waiting record within capacity', () => {
    const registry = new VmRecoverySlotRegistry();
    admitFor(registry, target, 0, 1);
    const donor = registry.begin();
    donor.track([target]);
    const waitingTarget = { ...target, localCgId: 'cg-b' };
    let recordsAtAbort: VmReconcileRotationRecord[] | undefined;
    donor.signal.addEventListener('abort', () => { recordsAtAbort = [...registry.snapshot().values()]; });
    const waiting = admitFor(registry, waitingTarget, 100, 1);
    expect(donor.signal.aborted).toBe(true);
    expect(recordsAtAbort).toEqual([waiting]);
    donor.release();
  });

  it('keeps a shared generation alive when one caller releases it', () => {
    const lifetimes = new VmRecoverySlotRegistry();
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
    const lifetimes = new VmRecoverySlotRegistry();
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
    const lifetimes = new VmRecoverySlotRegistry();
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
    const lifetimes = new VmRecoverySlotRegistry();
    const finished = lifetimes.begin();
    finished.track([target]);
    finished.release();
    finished.track([target]);
    lifetimes.close();
    expect(finished.signal.aborted).toBe(false);
  });
});
