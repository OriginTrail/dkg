import {
  sharedMemoryCompletionFields,
  sharedMemoryWorkOutcome,
  type SharedMemoryWorkOutcome,
} from '../src/sync/shared-memory-completion.js';
import { classifySwmCatchupPeerOutcome, createSwmCatchupPeerSelector, type DKGAgent, type SharedMemorySyncResult, type SwmCatchupPeerOutcome } from '@origintrail-official/dkg-agent';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import type { PublicSnapshotWalkPlan } from '../src/sync/requester/shared-memory-sync.js';

const localYield = true as const;
const workOutcome: SharedMemoryWorkOutcome = sharedMemoryWorkOutcome(
  sharedMemoryCompletionFields('local-budget-yield'),
);
void workOutcome;

classifySwmCatchupPeerOutcome({ localYield });

// Progress telemetry may coexist with a local scheduler yield. The classifier
// decides peer health from the telemetry while the yield itself remains neutral.
classifySwmCatchupPeerOutcome({ localYield, failedPhases: 1 });
classifySwmCatchupPeerOutcome({ localYield, failedPhases: 2, localYieldFailedPhases: 1 });

const snapshotPlan: PublicSnapshotWalkPlan = {
  entries: [{ snapshot: { ref: 'a', digest: 'new', count: 2 }, reuse: false }],
};
const detachedReuse: PublicSnapshotWalkPlan = {
  // @ts-expect-error reuse must accompany the full snapshot identity
  entries: [{ reuse: true }],
};
const parallelReuse: PublicSnapshotWalkPlan = {
  entries: snapshotPlan.entries,
  // @ts-expect-error a reference-only reuse list cannot be supplied independently
  reusableRefs: ['a'],
};
void detachedReuse;
void parallelReuse;

// @ts-expect-error arbitrary strings are not coherent work outcomes
const invalidOutcome: SharedMemoryWorkOutcome = 'yielded';
void invalidOutcome;

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

// @ts-expect-error a page cannot be both peer-timed-out and locally yielded
const timedOutAndYieldedPage: SyncPageResult = {
  quads: [],
  bytesReceived: 0,
  resumedFromOffset: 0,
  nextOffset: 0,
  checkpointKey: 'timed-out-and-yielded',
  completed: false,
  timedOut: true,
  localYield,
};

void timedOutAndYieldedPage;

// Existing public consumers can classify an old-shaped result and pass the
// guaranteed outcome directly to the selector, without an undefined guard.
const selector = createSwmCatchupPeerSelector();
const legacyResult = { insertedTriples: 0, failedPhases: 0 };
const legacyOutcome: SwmCatchupPeerOutcome = classifySwmCatchupPeerOutcome(legacyResult);
selector.record('cg', 'peer', classifySwmCatchupPeerOutcome(legacyResult));
const emptyOutcome: SwmCatchupPeerOutcome = classifySwmCatchupPeerOutcome({});
void legacyOutcome;
void emptyOutcome;

// A neutral local yield must be guarded before reaching the strict selector.
const neutralOutcome = classifySwmCatchupPeerOutcome({ localYield });
if (neutralOutcome) selector.record('cg', 'peer', neutralOutcome);
// @ts-expect-error selector records only real peer-health evidence
selector.record('cg', 'peer', neutralOutcome);

// Public compatibility counters may be absent on older producer results.
declare const detailed: SharedMemorySyncResult;
declare const catchup: NonNullable<Awaited<ReturnType<DKGAgent['syncContextGraphFromConnectedPeers']>>['diagnostics']>;
const detailedCounter: number = detailed.snapshotPlaneIncomplete ?? 0;
const catchupCounter: number = catchup.sharedMemory.snapshotPlaneIncomplete ?? 0;
void detailedCounter;
void catchupCounter;
