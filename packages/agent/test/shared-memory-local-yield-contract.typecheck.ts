import type { SharedMemoryLocalYield } from '../src/sync/shared-memory-completion.js';
import { sharedMemoryLocalYield } from '../src/sync/shared-memory-completion.js';
import { classifySwmCatchupPeerOutcome } from '../src/swm/swm-catchup-peer-selection.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

const localYield = sharedMemoryLocalYield();

classifySwmCatchupPeerOutcome({ localYield });

// Progress telemetry may coexist with a local scheduler yield. The classifier
// decides peer health from the telemetry while the yield itself remains neutral.
classifySwmCatchupPeerOutcome({ localYield, failedPhases: 1 });

// Plane-specific counts cannot be embedded in the generic completion reason.
const invalidLocalYield: SharedMemoryLocalYield = {
  kind: 'local-budget-yield',
  // @ts-expect-error snapshot cardinality belongs to shared-memory diagnostics
  snapshotPlaneIncomplete: 1,
};

void invalidLocalYield;

// @ts-expect-error a completed page cannot also be a local scheduler yield
const contradictoryPage: SyncPageResult = {
  quads: [],
  bytesReceived: 0,
  resumedFromOffset: 0,
  nextOffset: 0,
  checkpointKey: 'checkpoint',
  completed: true,
  timedOut: false,
  localYield,
};

void contradictoryPage;
