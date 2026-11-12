// SPDX-License-Identifier: Apache-2.0
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A file in the node's data directory saying that its triple store may hold
 * read-graph partitions. It is written before a read graph can exist and when
 * a start finds read-graph state, and removed once the partitions are dropped.
 * A rollback opens the store to drop them only while it is present.
 */
export const READ_GRAPH_PARTITIONS_MARKER = 'read-graph-partitions';

export function readGraphPartitionsMarkerPath(dataDir: string): string {
  return join(dataDir, READ_GRAPH_PARTITIONS_MARKER);
}

export function noteReadGraphPartitions(dataDir: string): void {
  writeFileSync(readGraphPartitionsMarkerPath(dataDir), 'This store may hold read-graph partitions.\n');
}

export function mayHoldReadGraphPartitions(dataDir: string): boolean {
  return existsSync(readGraphPartitionsMarkerPath(dataDir));
}

export function clearReadGraphPartitionsNote(dataDir: string): void {
  rmSync(readGraphPartitionsMarkerPath(dataDir), { force: true });
}
