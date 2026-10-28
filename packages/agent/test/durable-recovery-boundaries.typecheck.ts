import type { GraphOwnedDurableRecoveryRequest } from '../src/durable-recovery-owned-round.js';
import type { ManifestResumePlan } from '../src/sync/requester/manifest-resume-policy.js';
import type { DurableRecoveryRoundOutcome } from '../src/sync/durable-recovery-round.js';
import { createIncompleteDurableSyncResult } from '../src/sync/durable-progress.js';

declare const owned: GraphOwnedDurableRecoveryRequest;
// @ts-expect-error A graph-owned request cannot supply multi-graph execution state.
const multiple: GraphOwnedDurableRecoveryRequest = { ...owned, contextGraphIds: ['a', 'b'] };
void multiple;
// @ts-expect-error A replacement must carry its final manifest-bound checkpoint.
const invalidPlan: ManifestResumePlan = { checkpointAction: 'replace', seeded: true, resume: { kind: 'fresh', verifiedOffset: 0, rawOffset: 0 } };
void invalidPlan;
// @ts-expect-error A round must state its decision, including when execution never started.
const missingDecision: DurableRecoveryRoundOutcome = { result: createIncompleteDurableSyncResult() };
void missingDecision;

import type { DetailedDurableSyncResult } from '../src/sync/requester/durable-sync-result.js';
declare const physical: DetailedDurableSyncResult;
// @ts-expect-error Ordinary transport results do not expose graph-owner continuation decisions.
void physical.recoveryRound;

import { runDurableSyncDetailed, runChallengeExactAssetFetch, runGraphOwnedDurableSyncDetailed,
  type DurableSyncContext, type ChallengeExactAssetFetchContext, type GraphOwnedDurableSyncContext,
} from '../src/sync/requester/durable-sync.js';
declare const ordinaryRequester: DurableSyncContext;
declare const challengeRequester: ChallengeExactAssetFetchContext;
declare const ownedRequester: GraphOwnedDurableSyncContext;
void runGraphOwnedDurableSyncDetailed(ownedRequester);
// @ts-expect-error The requester accepts a single graph id, never multi-graph owner state.
void runGraphOwnedDurableSyncDetailed({ ...ownedRequester, contextGraphIds: ['a', 'b'] });
// @ts-expect-error Recovery capabilities are absent from the ordinary requester.
void runDurableSyncDetailed({ ...ordinaryRequester, graphRecovery: ownedRequester.recovery });
// @ts-expect-error The distinct owned input cannot be used as ordinary transport.
void runDurableSyncDetailed(ownedRequester);
// @ts-expect-error Challenge-only retrieval cannot accept graph-owner state.
void runChallengeExactAssetFetch({ ...challengeRequester, recovery: ownedRequester.recovery });
// @ts-expect-error Historical recovery fields cannot leak through the challenge context either.
void runChallengeExactAssetFetch({ ...challengeRequester, graphRecovery: ownedRequester.recovery });
// @ts-expect-error Owned recovery cannot request exact selections.
void runGraphOwnedDurableSyncDetailed({ ...ownedRequester, exactAssetSelectionFor: () => undefined });
// @ts-expect-error Owned recovery cannot request exact fetch policies.
void runGraphOwnedDurableSyncDetailed({ ...ownedRequester, exactAssetFetchPolicyFor: () => undefined });
// @ts-expect-error Owned recovery cannot become a full-snapshot consumer.
void runGraphOwnedDurableSyncDetailed({ ...ownedRequester, onVerifiedFullSnapshot: async () => {} });
// @ts-expect-error Owned recovery is full-graph and cannot use delta watermarks.
void runGraphOwnedDurableSyncDetailed({ ...ownedRequester, sinceBatchIdFor: () => '1' });

import { runAdmittedGraphOwnedDurableGraph, type OwnedDurableGraphRequest } from '../src/durable-recovery-graph.js';
declare const admittedOwned: OwnedDurableGraphRequest;
// @ts-expect-error Owned assembly cannot capture ordinary exact-selection policy in transport.
void runAdmittedGraphOwnedDurableGraph({ ...admittedOwned, options: { ...admittedOwned.options, exactAssetFetchPolicy: undefined } });
// @ts-expect-error Snapshot consumers enter through the ordinary requester mode.
void runAdmittedGraphOwnedDurableGraph({ ...admittedOwned, options: { ...admittedOwned.options, onVerifiedFullSnapshot: async () => {} } });
// @ts-expect-error Owned assembly has no delta watermark resolver.
void runAdmittedGraphOwnedDurableGraph({ ...admittedOwned, options: { ...admittedOwned.options, sinceBatchIdFor: () => '1' } });

// @ts-expect-error Graph owners accept scheduling options, never exact transport policy.
const exactTransport: GraphOwnedDurableRecoveryRequest = { ...owned, options: { exactRecoveryTransportMode: 'stream-required' } };
void exactTransport;
// @ts-expect-error Graph owners cannot carry an ordinary exact-selection policy.
const exactSelection: GraphOwnedDurableRecoveryRequest = { ...owned, options: { exactAssetFetchPolicy: undefined } };
void exactSelection;

import { HeldAssetsConfirmationRun, type ConfirmHeldAssetsCurrent } from '../src/sync/requester/durable-data-holdings.js';
import type { AuthenticateHeldAsset } from '../src/sync/requester/held-assets-contracts.js';
declare const authenticateHeld: AuthenticateHeldAsset;
const confirmation = new HeldAssetsConfirmationRun();
const budget = { createGraphScopedAuthenticationDeadline: () => 42 };
// @ts-expect-error Capability selection belongs to composition, not an unbound confirmer.
confirmation.forRound({ budget });
// @ts-expect-error Authentication alone cannot identify cached confirmation evidence.
confirmation.forRound({ budget, authenticateHeld });
// @ts-expect-error A binding reader must return a required on-chain identity.
confirmation.forRound({ budget, authenticateHeld, binding: () => ({ generation: 0 }) });
const requiredConfirmer: ConfirmHeldAssetsCurrent = confirmation.forRound({ budget, authenticateHeld,
  binding: () => ({ onChainId: '1', generation: 0 }) });
void requiredConfirmer;
