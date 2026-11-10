// SPDX-License-Identifier: Apache-2.0
import { mayHoldReadGraphPartitions, noteReadGraphPartitions } from './read-graph-partition-marker.js';
import { noteStoreMayHoldReadGraphPartitions, readGraphPartitionMaintenanceStore } from './read-graph-partition-store.js';
import { parseReadGraphStateRows, readGraphStateMarkAllDirty, readGraphStateRowsQuery } from './read-graph/state.js';
import type { UpdateOptions, TripleStore } from './triple-store.js';

/**
 * This release recognizes read graphs but does not maintain them, so at start
 * it marks every read graph it finds dirty: none stays `ready` across writes
 * that nothing maintained. One lookup on the state predicate finds the rows.
 * When there are any, it notes in `dataDir` that the store holds read-graph
 * partitions, for the rollback, and sends the state module's mark-all-dirty
 * update, one request, to the store below the partition guard. Rows found, or
 * a note left by an interrupted drop, also mark the store for this process as
 * one that may hold partitions. Returns how many rows were not dirty before.
 */
export async function markReadGraphsDirtyAtStart(
  store: TripleStore,
  options: { readonly dataDir?: string; readonly signal?: AbortSignal } = {},
): Promise<number> {
  const target = readGraphPartitionMaintenanceStore(store);
  const storeOptions: UpdateOptions = { signal: options.signal, priority: 'background', source: 'storage.readGraphStartup' };
  const result = await target.query(readGraphStateRowsQuery(), storeOptions);
  if (result.type !== 'bindings') throw new Error('Read-graph start-up expected state-row bindings');
  const found = result.bindings.length > 0;
  if (found && options.dataDir !== undefined) noteReadGraphPartitions(options.dataDir);
  if (found || (options.dataDir !== undefined && mayHoldReadGraphPartitions(options.dataDir))) {
    noteStoreMayHoldReadGraphPartitions(target);
  }
  if (!found) return 0;
  const { rows, damaged } = parseReadGraphStateRows(result.bindings);
  const notDirty = rows.filter(row => row.state !== 'dirty').length + damaged.length;
  if (notDirty === 0) return 0;
  if (!target.update) throw new Error('This store cannot mark its read graphs dirty: it has no update()');
  await target.update(readGraphStateMarkAllDirty(), storeOptions);
  return notDirty;
}
