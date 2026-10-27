import { findTripleStoreCapability } from './triple-store.js';

/** A newer stable generation certifies that all work in older backend processes has stopped.
 * It says nothing about content correctness: callers must read and authenticate it again.
 * Undefined means recovery is unconfirmed or admission is closed. */
export interface StoreRecoveryGenerationReader {
  (): number | undefined;
  /** Supervised epoch even during recovery; never grants permission to read. */
  readonly epoch?: () => number | undefined;
}
const readers = new WeakMap<object, StoreRecoveryGenerationReader>();

/** Internal adapter registration; generic endpoint options cannot grant this capability. */
export function registerStoreRecoveryGeneration(store: object, read: StoreRecoveryGenerationReader, epoch?: () => number | undefined): void {
  readers.set(store, Object.assign(read, { epoch }));
}

export function asStoreRecoveryGenerationReader(store: unknown): StoreRecoveryGenerationReader | undefined {
  const owner = findTripleStoreCapability(store, (value): value is object =>
    typeof value === 'object' && value !== null && readers.has(value));
  return owner === null ? undefined : readers.get(owner);
}
