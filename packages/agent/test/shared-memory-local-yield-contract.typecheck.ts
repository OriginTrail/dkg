import type { SharedMemoryLocalYield } from '../src/sync/shared-memory-completion.js';
import { sharedMemoryLocalYield } from '../src/sync/shared-memory-completion.js';
import { classifySwmCatchupPeerOutcome, createSwmCatchupPeerSelector, type DKGAgent, type SharedMemorySyncResult, type SwmCatchupPeerOutcome } from '@origintrail-official/dkg-agent';
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

// Existing public consumers can classify an old-shaped result and pass the
// guaranteed outcome directly to the selector, without an undefined guard.
const selector = createSwmCatchupPeerSelector();
const legacyResult = { insertedTriples: 0, failedPhases: 0 };
const legacyOutcome: SwmCatchupPeerOutcome = classifySwmCatchupPeerOutcome(legacyResult);
selector.record('cg', 'peer', classifySwmCatchupPeerOutcome(legacyResult));
const emptyOutcome: SwmCatchupPeerOutcome = classifySwmCatchupPeerOutcome({});
void legacyOutcome;
void emptyOutcome;

// New local-yield inputs also compose safely; the selector treats no evidence as a no-op.
selector.record('cg', 'peer', classifySwmCatchupPeerOutcome({ localYield }));

// Public compatibility counters may be absent on older producer results.
declare const detailed: SharedMemorySyncResult;
declare const catchup: NonNullable<Awaited<ReturnType<DKGAgent['syncContextGraphFromConnectedPeers']>>['diagnostics']>;
const detailedCounter: number = detailed.snapshotPlaneIncomplete ?? 0;
const catchupCounter: number = catchup.sharedMemory.snapshotPlaneIncomplete ?? 0;
void detailedCounter;
void catchupCounter;
