import { setTimeout as delay } from 'node:timers/promises';
import { isStoreSchedulerBusyError } from '@origintrail-official/dkg-storage';

export const EXACT_EXPORT_METADATA_OPERATION = 'sync.responder.exactAssetExport.metadata';

/** Retry only a metadata read that the scheduler proves never started.
 * Queue limits, priority and the caller's existing session deadline stay intact.
 * At most two re-admissions avoid resetting a warm stream on transient pressure;
 * persistent overload still propagates the final typed admission error.
 */
export async function retryExactMetadataAdmission<T>(
  read: () => Promise<T>, signal?: AbortSignal, onRetry?: (waitMs: number) => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await read(); }
    catch (error) {
      signal?.throwIfAborted();
      if (attempt >= 2 || !isStoreSchedulerBusyError(error)
        || error.priority !== 'background' || error.operation !== EXACT_EXPORT_METADATA_OPERATION) throw error;
      const started = performance.now();
      try { await delay(250 * (attempt + 1), undefined, { signal }); }
      catch (error) { signal?.throwIfAborted(); throw error; }
      signal?.throwIfAborted();
      onRetry?.(performance.now() - started);
    }
  }
}
