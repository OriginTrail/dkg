import { describe, expect, it } from 'vitest';
import { VmRecoverySlotGeneration, VmRecoverySlotLease } from '../src/internal/vm-recovery-slot-lifetimes.js';

describe('VM recovery slot lifetimes', () => {
  it('cancels every lease but the exempt requester when a generation ends', () => {
    const generation = new VmRecoverySlotGeneration('slot');
    const requester = new VmRecoverySlotLease();
    const observer = new VmRecoverySlotLease();
    requester.attach(generation);
    requester.attach(generation);
    observer.attach(generation);
    generation.end(requester);
    expect(requester.signal.aborted).toBe(false);
    expect(observer.signal.aborted).toBe(true);
    expect((observer.signal.reason as Error).name).toBe('AbortError');
    expect(generation.idle).toBe(true);
    // The exempt lease was detached rather than canceled, so it retires nothing later.
    expect(requester.detachAll()).toEqual([]);
  });

  it('cancels all leases without an exemption and never reaches a released lease', () => {
    const generation = new VmRecoverySlotGeneration('slot');
    const active = new VmRecoverySlotLease();
    const released = new VmRecoverySlotLease();
    active.attach(generation);
    released.attach(generation);
    expect(released.detachAll()).toEqual([generation]);
    expect(generation.idle).toBe(false);
    generation.end();
    expect(active.signal.aborted).toBe(true);
    expect((active.signal.reason as Error).name).toBe('AbortError');
    expect(released.signal.aborted).toBe(false);
    expect(generation.idle).toBe(true);
  });

  it('lets an abort listener attach a replacement without rejoining the ended generation', () => {
    const ended = new VmRecoverySlotGeneration('slot');
    const replacement = new VmRecoverySlotGeneration('slot');
    const lease = new VmRecoverySlotLease();
    const successor = new VmRecoverySlotLease();
    lease.attach(ended);
    lease.signal.addEventListener('abort', () => successor.attach(replacement), { once: true });
    ended.end();
    expect(ended.idle).toBe(true);
    expect(replacement.idle).toBe(false);
    expect(successor.signal.aborted).toBe(false);
    expect(lease.detachAll()).toEqual([]);
  });
});
