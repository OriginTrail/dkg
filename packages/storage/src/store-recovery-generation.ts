import { isStoreOperation, type StoreOperation } from './store-operation-outcome.js';
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


const failedExecutions = new WeakMap<object, { operation: StoreOperation; generation: number }>();

/** Internal worker failure construction: bind evidence to one posted operation, never to a later queue admission. */
export function storeWorkerExecutionFailure(cause: Error, operation: string, generation: number): Error {
  const error = new Error(cause.message, { cause });
  error.name = cause.name;
  if ('code' in cause) Object.assign(error, { code: cause.code });
  if (isStoreOperation(operation)) failedExecutions.set(error, { operation, generation });
  return error;
}

/** Only privately registered execution evidence for this exact operation can label uncertainty. */
export function readStoreOperationExecutionGeneration(error: unknown, operation: StoreOperation): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const evidence = failedExecutions.get(error);
  return evidence?.operation === operation ? evidence.generation : undefined;
}
