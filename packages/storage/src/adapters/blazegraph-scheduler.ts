import { externalStorePriorityScheduler, type StorePriorityScheduler } from '../store-priority-scheduler.js';
import { selectStoreScheduler } from '../store-control-path.js';
import type { QueryOptions } from '../triple-store.js';

export interface BlazegraphStoreOptions {
  /** End-to-end timeout including scheduler wait, HTTP work, and response decoding. */
  timeout?: number;
  /** Optional scheduler injection for embedded callers and adapter-boundary tests. */
  scheduler?: StorePriorityScheduler;
  /** Private embedded store: every operation, including control calls, uses this scheduler.
   * Mutually exclusive with scheduler; process-wide control capacity must not bypass its limit. */
  isolatedScheduler?: StorePriorityScheduler;
}

export function blazegraphSchedulers(options: BlazegraphStoreOptions) {
  if (options.scheduler && options.isolatedScheduler) throw new Error('Provide only one scheduler');
  const shared = options.isolatedScheduler ?? options.scheduler ?? externalStorePriorityScheduler;
  const isolated = options.isolatedScheduler !== undefined;
  return { shared, select: (query: QueryOptions | undefined) => isolated
    ? shared : selectStoreScheduler(shared, query) };
}
