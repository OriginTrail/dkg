import { describe, expect, it } from 'vitest';
import { VmRecoverySlotRegistry } from '../src/internal/vm-recovery-slot-registry.js';
import type { VmReconcileRotationRecord } from '../src/dkg-agent-types.js';

const target = { localCgId: 'cg-a', onChainCgId: '1', ordinal: 0, ual: 'ka-0', merkleRoot: '0xABC' };

function recordFor(registry: VmRecoverySlotRegistry, value = target): VmReconcileRotationRecord {
  return registry.createRecord(value, {
    candidatePeerIds: ['peer-a'], curatorRosterConfirmed: true, collectionDeadlineAt: 100,
  });
}

describe('active VM recovery slot ownership', () => {
  it('retires evidence on completion while preserving cancellation ownership until physical release', () => {
    const registry = new VmRecoverySlotRegistry();
    const record = recordFor(registry);
    registry.install(record, 0, 2);
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
    registry.install(recordFor(registry), 0, 2);
    const otherRecord = recordFor(registry, other);
    registry.install(otherRecord, 0, 2);
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

  it('replaces a cached fingerprint even when no active generation was retained', () => {
    const registry = new VmRecoverySlotRegistry();
    registry.install(recordFor(registry), 0, 1);
    const replacement = { ...target, merkleRoot: '0xdef' };
    expect(registry.currentRecord(replacement)).toBeUndefined();
    expect(registry.recordCount).toBe(0);
    const record = recordFor(registry, replacement);
    expect(registry.install(record, 0, 1)).toBe(true);
    expect(registry.currentRecord(replacement)).toBe(record);
  });

  it('aborts an expired donor only after installing the waiting record within capacity', () => {
    const registry = new VmRecoverySlotRegistry();
    registry.install(recordFor(registry), 0, 1);
    const donor = registry.begin();
    donor.track([target]);
    const waitingTarget = { ...target, localCgId: 'cg-b' };
    const waiting = recordFor(registry, waitingTarget);
    let recordsAtAbort: VmReconcileRotationRecord[] | undefined;
    donor.signal.addEventListener('abort', () => { recordsAtAbort = [...registry.snapshot().values()]; });
    expect(registry.install(waiting, 100, 1)).toBe(true);
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
