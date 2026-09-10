import {
  selectSwmSnapshotCoverage,
  type SharedMemorySyncSummary,
} from '../src/sync/requester/shared-memory-sync.js';

const summary: SharedMemorySyncSummary = {
  snapshotPlaneIncomplete: 0,
  insertedTriples: 0,
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
  deniedPhases: 0,
  backoffWorthyFailures: 0,
  deferredBackpressure: 0,
  metadataContinuationYields: 0,
  continuationPasses: 0,
  resolvedSnapshotPlaneIncomplete: 0,
  resolvedMetadataContinuationYields: 0,
  replayPhaseBytesReceived: 0,
  snapshotPhaseBytesReceived: 0,
};

void summary;
void selectSwmSnapshotCoverage(undefined, undefined);
