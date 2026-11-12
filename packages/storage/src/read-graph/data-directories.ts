// SPDX-License-Identifier: Apache-2.0

/**
 * The data directories of the nodes whose stores share a backend's runtime in
 * this process. Any of those nodes may be the one a later process starts
 * alone, or the one an update rolls back. So each directory keeps the journal
 * of the dirty marks the store refused (`./mark-journal.ts`), and, once the
 * backend may hold read-graph partitions, the note that tells a rollback to
 * drop them (`../read-graph-partition-marker.ts`).
 */

import { noteReadGraphPartitions } from '../read-graph-partition-marker.js';
import type { ReadGraphBackendRuntime } from './runtime.js';

const DIRECTORIES = new WeakMap<ReadGraphBackendRuntime, Set<string>>();

/**
 * Add a node's data directory to the runtime's. If the backend may already
 * hold read-graph partitions, the directory notes so at once; one that cannot
 * take the note throws, and is not added.
 */
export function addReadGraphDataDirectory(runtime: ReadGraphBackendRuntime, dataDir: string): void {
  if (runtime.mayHoldPartitions === true) noteReadGraphPartitions(dataDir);
  const directories = DIRECTORIES.get(runtime) ?? new Set<string>();
  DIRECTORIES.set(runtime, directories.add(dataDir));
}

/** The runtime's data directories. */
export function readGraphDataDirectories(runtime: ReadGraphBackendRuntime): readonly string[] {
  return [...(DIRECTORIES.get(runtime) ?? [])];
}

/**
 * Note in `dataDir`, when there is one, and in each of the runtime's data
 * directories that the backend may hold read-graph partitions.
 */
export function noteReadGraphPartitionsOfRuntime(runtime: ReadGraphBackendRuntime, dataDir: string | undefined): void {
  const directories = new Set(readGraphDataDirectories(runtime));
  if (dataDir !== undefined) directories.add(dataDir);
  for (const directory of directories) noteReadGraphPartitions(directory);
}
