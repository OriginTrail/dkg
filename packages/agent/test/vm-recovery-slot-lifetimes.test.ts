import { describe, expect, it } from 'vitest';
import { VmRecoverySlotLifetimes, vmRecoverySlotKey } from '../src/internal/vm-recovery-slot-lifetimes.js';

const target = { localCgId: 'cg-a', onChainCgId: '1', ordinal: 0, ual: 'ka-0', merkleRoot: '0xABC' };

describe('active VM recovery slot ownership', () => {
  it('keeps a shared generation alive when one caller releases it', () => {
    const lifetimes = new VmRecoverySlotLifetimes();
    const first = lifetimes.begin();
    const second = lifetimes.begin();
    first.track([target, target]);
    second.track([{ ...target, merkleRoot: '0xabc' }]);
    expect(first.signal.aborted).toBe(false);
    first.release();
    first.release();
    expect(second.signal.aborted).toBe(false);
    lifetimes.invalidateSlot(vmRecoverySlotKey(target));
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false);
    second.release();
  });

  it('does not let an old completion retire its replacement generation', () => {
    const lifetimes = new VmRecoverySlotLifetimes();
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
    const lifetimes = new VmRecoverySlotLifetimes();
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
    const lifetimes = new VmRecoverySlotLifetimes();
    const finished = lifetimes.begin();
    finished.track([target]);
    finished.release();
    finished.track([target]);
    lifetimes.close();
    expect(finished.signal.aborted).toBe(false);
  });
});
