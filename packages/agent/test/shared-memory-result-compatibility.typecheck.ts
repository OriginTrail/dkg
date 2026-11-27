import type {
  SharedMemorySyncDiagnostics,
  SharedMemorySyncResult,
} from '@origintrail-official/dkg-agent';
import type { SharedMemorySyncAggregate } from '../src/sync/shared-memory-diagnostics.js';

// Public inputs constructed before snapshot-plane diagnostics remain valid.
const legacyDiagnostics: SharedMemorySyncDiagnostics = {
  fetchedMetaTriples: 0,
  fetchedDataTriples: 0,
  insertedMetaTriples: 0,
  insertedDataTriples: 0,
  bytesReceived: 0,
  resumedPhases: 0,
  timedOutPhases: 0,
  completedPhases: 0,
  checkpointAdvances: 0,
  emptyResponses: 0,
  droppedDataTriples: 0,
  failedPeers: 0,
  failedPhases: 0,
};
const legacyResult: SharedMemorySyncResult = {
  ...legacyDiagnostics,
  insertedTriples: 0,
  deniedPhases: 0,
};

const normalizedLegacyCounter: number = legacyResult.snapshotPlaneIncomplete ?? 0;
declare const aggregate: SharedMemorySyncAggregate;
const aggregateCounter: number = aggregate.snapshotPlaneIncomplete;
// Internal accumulators must still carry the concrete normalized counter.
declare const missingSnapshotCounter: Omit<SharedMemorySyncAggregate, 'snapshotPlaneIncomplete'>;
// @ts-expect-error the snapshot counter must be normalized even when every other counter is present
const unnormalizedAggregate: SharedMemorySyncAggregate = missingSnapshotCounter;
void normalizedLegacyCounter;
void aggregateCounter;
void unnormalizedAggregate;
