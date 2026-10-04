// SPDX-License-Identifier: Apache-2.0

import { type RecoverContextGraphSwmResult } from '../sync/requester/swm-recovery.js';

export function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
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
