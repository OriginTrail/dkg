import { findTripleStoreCapability } from './triple-store.js';

/** One observation of a supervised backend. A newer ready generation certifies
 * termination of older backend work, not content correctness. An unready epoch
 * may label uncertain writes but cannot grant a content proof. */
export interface StoreRecoveryState {
  readonly generation: number;
  readonly ready: boolean;
}
/** Undefined means no supervised state is currently available. */
export type StoreRecoveryGenerationReader = () => StoreRecoveryState | undefined;
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
