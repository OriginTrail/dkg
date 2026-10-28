import { withKeyedLocks } from './keyed-lock.js';
import type { TripleStore } from '@origintrail-official/dkg-storage';

/**
 * Publisher instances that target the same in-process store must serialize
 * lifecycle mutations together. A per-instance default lets a writer race a
 * promote in another publisher and disappear when promote drops the stale WM
 * snapshot. Explicitly supplied locks still win so the agent can share its
 * wider handler lock domain with the publisher.
 */
const STORE_WRITE_LOCKS = new WeakMap<TripleStore, Map<string, Promise<void>>>();

export function writeLocksForStore(
  store: TripleStore,
  suppliedLocks?: Map<string, Promise<void>>,
): Map<string, Promise<void>> {
  const existingLocks = STORE_WRITE_LOCKS.get(store);
  if (existingLocks) {
    if (suppliedLocks && suppliedLocks !== existingLocks) {
      throw new Error(
        'DKGPublisher instances sharing one TripleStore must share the same writeLocks map',
      );
    }
    return existingLocks;
  }
  const locks = suppliedLocks ?? new Map();
  STORE_WRITE_LOCKS.set(store, locks);
  return locks;
}

export function assertionLifecycleWriteLockKey(
  contextGraphId: string,
  name: string,
  agentAddress: string,
  subGraphName?: string,
): string {
  const normalizedAgentAddress = /^0x[0-9a-fA-F]{40}$/.test(agentAddress)
    ? agentAddress.toLowerCase()
    : agentAddress;
  return `assertion-lifecycle:${JSON.stringify([
    contextGraphId,
    subGraphName ?? '',
    normalizedAgentAddress,
    name,
  ])}`;
}

/** Short-lived proof that a caller owns one lifecycle lock in this exact store domain. */
export interface AssertionLifecycleWriteLease { readonly assertionLifecycleWriteLease: unique symbol }
const lifecycleLeases = new WeakMap<object, { locks: Map<string, Promise<void>>; key: string }>();
export async function withAssertionLifecycleWriteLease<T>(locks: Map<string, Promise<void>>, key: string,
  run: (lease: AssertionLifecycleWriteLease) => Promise<T>): Promise<T> {
  return withKeyedLocks(locks, [key], async () => {
    const lease = Object.freeze({}) as AssertionLifecycleWriteLease;
    lifecycleLeases.set(lease, { locks, key });
    try { return await run(lease); } finally { lifecycleLeases.delete(lease); }
  });
}
/** Allows nested cleanup only while the exact transaction still owns its lock. */
export function assertAssertionLifecycleWriteLease(lease: AssertionLifecycleWriteLease,
  locks: Map<string, Promise<void>>, key: string): void {
  const held = lifecycleLeases.get(lease);
  if (!held || held.locks !== locks || held.key !== key) throw new Error('Assertion lifecycle write lease is not current');
}
