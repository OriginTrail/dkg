import {
  selectSwmSnapshotCoverage,
  type SharedMemorySyncSummary,
} from '../src/sync/requester/shared-memory-sync.js';
import {
  readPublicSnapshotWalkProgress,
  settlePublicSnapshotsForMeta,
  syncPublicSnapshotsForMeta,
} from '@origintrail-official/dkg-agent/dist/sync/requester/shared-memory-sync.js';
import type { Quad } from '@origintrail-official/dkg-storage';

declare const legacySnapshotParams: Omit<Parameters<typeof syncPublicSnapshotsForMeta>[0], 'workAdmission' | 'snapshotWalk'> & {
  metaQuads: Quad[];
};
void syncPublicSnapshotsForMeta(legacySnapshotParams);

// The published settled API accepts the same parameters and reports the walk's
// progress on BOTH branches, so a failed walk still has a readable denominator.
void settlePublicSnapshotsForMeta(legacySnapshotParams);
declare const settledSnapshotWalk: Awaited<ReturnType<typeof settlePublicSnapshotsForMeta>>;
const settledProgress: number = settledSnapshotWalk.kind === 'failure'
  ? settledSnapshotWalk.result.readySnapshots
  : settledSnapshotWalk.result.totalSnapshots;
void settledProgress;

// A consumer compiled against the throwing helper still imports the reader from
// the published subpath and still gets the walk's progress for what it caught.
declare const caughtWalkFailure: unknown;
const recoveredProgress: number | undefined =
  readPublicSnapshotWalkProgress(caughtWalkFailure)?.readySnapshots;
void recoveredProgress;

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
