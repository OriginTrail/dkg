// SPDX-License-Identifier: Apache-2.0
import type { PublicSnapshotEvidence } from './public-snapshot-evidence.js';
import type { BulkGraphMetrics } from './sync/requester/bulk-graph-stream.js';

export interface PublicSnapshotRecoveryOptions {
  contextGraphId: string; uals: readonly string[];
  /** Bounded fallback batches, memoized by the caller for later asset groups. */
  peerBatches: () => AsyncIterable<readonly string[]>;
  evidence: PublicSnapshotEvidence; signal: AbortSignal; assertCurrent: () => void;
}
export interface PublicSnapshotRecoveryResult {
  committed: Set<string>;
  /** Assets found already stored as the snapshot pins them, counted in `committed` without a transfer. */
  alreadyPresent?: number;
  bulkChunks?: BulkGraphMetrics[];
}
