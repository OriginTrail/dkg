// SPDX-License-Identifier: Apache-2.0
import type { PublicSnapshotEvidence } from './public-snapshot-evidence.js';
import type { BulkGraphMetrics } from './sync/requester/bulk-graph-stream.js';

export interface PublicSnapshotRecoveryOptions {
  contextGraphId: string; peers: readonly string[]; uals: readonly string[];
  evidence: PublicSnapshotEvidence; signal: AbortSignal; assertCurrent: () => void;
}
export interface PublicSnapshotRecoveryResult {
  committed: Set<string>;
  bulkChunks?: BulkGraphMetrics[];
}
