import type { TripleStoreQueryOptions } from '../triple-store.js';
/** Signals stay local; execution-affecting options cross the worker boundary together. */
export function serializableQueryOptions(options?: TripleStoreQueryOptions) {
  return { ...(options?.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
    ...(options?.withheldGraphRoots?.length ? { withheldGraphRoots: [...options.withheldGraphRoots] } : {}) };
}
