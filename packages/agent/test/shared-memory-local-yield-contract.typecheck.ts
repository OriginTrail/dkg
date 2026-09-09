import type { SharedMemoryLocalYield } from '../src/sync/shared-memory-completion.js';
import { sharedMemoryLocalYield } from '../src/sync/shared-memory-completion.js';
import { classifySwmCatchupPeerOutcome } from '../src/swm/swm-catchup-peer-selection.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

const localYield = sharedMemoryLocalYield();

classifySwmCatchupPeerOutcome({ localYield });

// A local scheduler yield and peer-failure evidence are mutually exclusive at
// the sole peer-cache boundary.
// @ts-expect-error contradictory local and peer completion evidence
classifySwmCatchupPeerOutcome({ localYield, failedPhases: 1 });

// Counts enter the canonical completion only through the positive-count
// constructor; zero cannot masquerade as a local yield.
const invalidLocalYield: SharedMemoryLocalYield = {
  kind: 'local-budget-yield',
  // @ts-expect-error zero is not a branded positive snapshot-plane count
  snapshotPlaneIncomplete: 0,
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
