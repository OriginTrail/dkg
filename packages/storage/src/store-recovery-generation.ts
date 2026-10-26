import { findTripleStoreCapability } from './triple-store.js';

/** A newer stable generation certifies that all work in older backend processes has stopped.
 * It says nothing about content correctness: callers must read and authenticate it again.
 * Undefined means recovery is unconfirmed or admission is closed. */
export type StoreRecoveryGenerationReader = () => number | undefined;
const readers = new WeakMap<object, StoreRecoveryGenerationReader>();

/** Internal adapter registration; generic endpoint options cannot grant this capability. */
export function registerStoreRecoveryGeneration(store: object, read: StoreRecoveryGenerationReader): void {
  readers.set(store, read);
}

export function asStoreRecoveryGenerationReader(store: unknown): StoreRecoveryGenerationReader | undefined {
  const owner = findTripleStoreCapability(store, (value): value is object =>
    typeof value === 'object' && value !== null && readers.has(value));
  return owner === null ? undefined : readers.get(owner);
}
