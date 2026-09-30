import type { QueryOptions } from './triple-store.js';
import type { ReadSnapshotStore } from './read-snapshot-capability.js';

export function mergeQueryOptions(
  options?: QueryOptions,
  source?: QueryOptions['source'],
): QueryOptions | undefined {
  if (!options && !source) return undefined;
  return { ...options, ...(source ? { source } : {}) };
}

export async function listGraphsByPrefix(
  store: ReadSnapshotStore,
  prefix: string,
  options?: QueryOptions,
): Promise<string[]> {
  return store.listGraphsByPrefix
    ? store.listGraphsByPrefix(prefix, options)
    : (await store.listGraphs(options)).filter((graph) => graph.startsWith(prefix));
}
