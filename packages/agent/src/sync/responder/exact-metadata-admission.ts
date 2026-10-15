import { setTimeout as delay } from 'node:timers/promises';
import { isStoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { exactExportStorePriority } from './public-snapshot-store-admission.js';

export const EXACT_EXPORT_METADATA_OPERATION = 'sync.responder.exactAssetExport.metadata';
export const EXACT_EXPORT_PAYLOAD_OPERATION = 'sync.responder.exactAssetExport.payload';

/** Retry only the named read that the scheduler proves never started.
 * Queue limits, priority and the caller's existing session deadline stay intact.
 * At most two re-admissions avoid resetting a warm stream on transient pressure;
 * persistent overload still propagates the final typed admission error.
 */
async function retryExactReadAdmission<T>(
  operation: string, read: () => Promise<T>, signal?: AbortSignal, onRetry?: (waitMs: number) => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await read(); }
    catch (error) {
      signal?.throwIfAborted();
      if (attempt >= 2 || !isStoreSchedulerBusyError(error)
        || error.priority !== exactExportStorePriority() || error.operation !== operation) throw error;
      const started = performance.now();
      try { await delay(250 * (attempt + 1), undefined, { signal }); }
      catch (error) { signal?.throwIfAborted(); throw error; }
      signal?.throwIfAborted();
      onRetry?.(performance.now() - started);
    }
  }
}

export function retryExactMetadataAdmission<T>(
  read: () => Promise<T>, signal?: AbortSignal, onRetry?: (waitMs: number) => void,
): Promise<T> {
  return retryExactReadAdmission(EXACT_EXPORT_METADATA_OPERATION, read, signal, onRetry);
}

export function retryExactPayloadAdmission<T>(
  read: () => Promise<T>, signal?: AbortSignal, onRetry?: (waitMs: number) => void,
): Promise<T> {
  return retryExactReadAdmission(EXACT_EXPORT_PAYLOAD_OPERATION, read, signal, onRetry);
}
