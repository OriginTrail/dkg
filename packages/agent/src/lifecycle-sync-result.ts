// SPDX-License-Identifier: Apache-2.0

import { emptySharedMemorySyncResult as createEmptySharedMemorySyncResult, mergeSamePeerSharedMemoryDiagnostics } from './sync/shared-memory-diagnostics.js';
import { type RecoverContextGraphSwmResult } from './sync/requester/swm-recovery.js';
import { type SharedMemorySyncResult } from './dkg-agent-types.js';

export function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function emptySharedMemorySyncResult(): SharedMemorySyncResult {
  return createEmptySharedMemorySyncResult();
}

export function mergeSharedMemorySyncResults(
  a: SharedMemorySyncResult,
  b: SharedMemorySyncResult,
): SharedMemorySyncResult {
  return {
    ...mergeSamePeerSharedMemoryDiagnostics(a, b),
  };
}

export function emptySwmRecoveryResult(): RecoverContextGraphSwmResult {
  return {
    replacedRoots: 0,
    replacedGraphs: 0,
    insertedDataQuads: 0,
    insertedMetaQuads: 0,
    droppedDataTriples: 0,
    readySnapshots: 0,
    totalSnapshots: 0,
    completed: true,
  };
}
