// SPDX-License-Identifier: Apache-2.0
import { noteReadGraphPartitions } from './read-graph-partition-marker.js';
import { readGraphPartitionMaintenanceStore } from './read-graph-partition-store.js';
import { parseReadGraphStateRows, readGraphStateMarkAllDirty, readGraphStateRowsQuery } from './read-graph/state.js';
import type { UpdateOptions, TripleStore } from './triple-store.js';

/**
 * This release recognizes read graphs but does not maintain them, so at start
 * it marks every read graph it finds dirty: none stays `ready` across writes
 * that nothing maintained. One lookup on the state predicate finds the rows.
 * When there are any, it notes in `dataDir` that the store holds read-graph
 * partitions, for the rollback, and sends the state module's mark-all-dirty
 * update, one request, to the store below the partition guard. Returns how
 * many rows were not dirty before.
 */
export async function markReadGraphsDirtyAtStart(
  store: TripleStore,
  options: { readonly dataDir?: string; readonly signal?: AbortSignal } = {},
): Promise<number> {
  const target = readGraphPartitionMaintenanceStore(store);
  const storeOptions: UpdateOptions = { signal: options.signal, priority: 'background', source: 'storage.readGraphStartup' };
  const result = await target.query(readGraphStateRowsQuery(), storeOptions);
  if (result.type !== 'bindings') throw new Error('Read-graph start-up expected state-row bindings');
  if (result.bindings.length === 0) return 0;
  if (options.dataDir !== undefined) noteReadGraphPartitions(options.dataDir);
  const { rows, damaged } = parseReadGraphStateRows(result.bindings);
  const notDirty = rows.filter(row => row.state !== 'dirty').length + damaged.length;
  if (notDirty === 0) return 0;
  if (!target.update) throw new Error('This store cannot mark its read graphs dirty: it has no update()');
  await target.update(readGraphStateMarkAllDirty(), storeOptions);
  return notDirty;
}
