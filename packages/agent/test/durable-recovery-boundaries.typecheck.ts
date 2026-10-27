import type { GraphOwnedDurableRecoveryRequest } from '../src/durable-recovery-owned-round.js';
import type { ManifestResumePlan } from '../src/sync/requester/manifest-resume-policy.js';
import { durableRecoveryRoundOutcome } from '../src/sync/durable-recovery-round.js';
import { createIncompleteDurableSyncResult } from '../src/sync/durable-progress.js';

declare const owned: GraphOwnedDurableRecoveryRequest;
// @ts-expect-error A graph-owned request cannot supply multi-graph execution state.
const multiple: GraphOwnedDurableRecoveryRequest = { ...owned, contextGraphIds: ['a', 'b'] };
void multiple;
// @ts-expect-error A replacement must carry its final manifest-bound checkpoint.
const invalidPlan: ManifestResumePlan = { checkpointAction: 'replace', seeded: true, resume: { kind: 'fresh', verifiedOffset: 0, rawOffset: 0 } };
void invalidPlan;
// @ts-expect-error A round must state its decision, including when execution never started.
void durableRecoveryRoundOutcome(createIncompleteDurableSyncResult());

import type { DetailedDurableSyncResult } from '../src/sync/requester/durable-sync-result.js';
declare const physical: DetailedDurableSyncResult;
// @ts-expect-error Ordinary transport results do not expose graph-owner continuation decisions.
void physical.recoveryRound;
