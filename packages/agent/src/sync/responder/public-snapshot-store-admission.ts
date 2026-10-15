import { AsyncLocalStorage } from 'node:async_hooks';

const admittedPublicSnapshot = new AsyncLocalStorage<true>();

/** Enter only after the public stream's authorization and responder admission.
 * Each export read uses existing normal capacity; no store slot is held while
 * waiting for transport credit or durable ACK. Repair retains its background
 * floor, and total concurrency, queue bounds and caller deadlines are unchanged.
 */
export function withPublicSnapshotStoreReads<T>(work: () => Promise<T>): Promise<T> {
  return admittedPublicSnapshot.run(true, work);
}

export function exactExportStorePriority(): 'normal' | 'background' {
  return admittedPublicSnapshot.getStore() ? 'normal' : 'background';
}
