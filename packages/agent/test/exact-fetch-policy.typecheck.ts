// SPDX-License-Identifier: Apache-2.0
import type { DKGAgent } from '../src/index.js';
import type { DurableSyncOptions } from '../src/dkg-agent-lifecycle.js';
import type { LegacyDurableSyncContext } from '../src/sync/requester/durable-sync-compat.js';
import type { DurableSyncContext } from '../src/sync/requester/durable-sync.js';
import { createUalOnlyExactAssetSelection, createChallengePinnedExactAssetSelection, type ExactAssetSelection } from '../src/sync/exact-assets.js';
import { exactAssetFetchSessionPolicy, type ExactAssetFetchSessionPolicy } from '../src/sync/requester/exact-durable-fetch.js';

const ordinary = createUalOnlyExactAssetSelection(['did:dkg:mock:31337/0x0000000000000000000000000000000000000001/7']);
const refresh = exactAssetFetchSessionPolicy(ordinary, 'vm-update-refresh');
const accepted: DurableSyncOptions = { exactAssetFetchPolicy: refresh };
void accepted;
const challenge = createChallengePinnedExactAssetSelection([{ assetUal: ordinary.assetUals[0]!, merkleRootHex: '1'.repeat(64), merkleLeafCount: 1n }]);
const ordinaryCallback: Pick<DurableSyncContext, 'exactAssetFetchPolicyFor'> = {
  exactAssetFetchPolicyFor: () => exactAssetFetchSessionPolicy(ordinary),
};
void ordinaryCallback;
const challengeCallback: Pick<DurableSyncContext, 'exactAssetFetchPolicyFor'> = {
  // @ts-expect-error a challenge policy cannot enter durable materialization
  exactAssetFetchPolicyFor: () => exactAssetFetchSessionPolicy(challenge),
};
void challengeCallback;
const ordinaryKind: 'durable-materialization' = exactAssetFetchSessionPolicy(ordinary).kind;
const challengeKind: 'ephemeral-challenge' = exactAssetFetchSessionPolicy(challenge).kind;
void ordinaryKind;
void challengeKind;
// @ts-expect-error a refresh is bound to a UAL-only selection, never challenge pins
exactAssetFetchSessionPolicy(challenge, 'vm-update-refresh');
// @ts-expect-error a refresh cannot describe a full graph without an exact selection
const unbound: ExactAssetFetchSessionPolicy = { kind: 'vm-update-refresh', forceFreshSession: true, allowDurableCheckpoints: true };
void unbound;
// @ts-expect-error the full-graph API has no independent exact-refresh purpose
const fullGraph: DurableSyncOptions = { exactFetchPurpose: 'vm-update-refresh' };
void fullGraph;
// @ts-expect-error ordinary durable retrieval must retain resumable session semantics
const contradictory: ExactAssetFetchSessionPolicy = { kind: 'durable-materialization', selection: ordinary, forceFreshSession: true, allowDurableCheckpoints: true };
void contradictory;

// Historical public options remain accepted while internal policy is selection-bound.
const historicalFresh: DurableSyncOptions = { exactAssetSelection: ordinary, forceFreshExactSession: true };
const historicalResume: DurableSyncOptions = { exactAssetSelection: ordinary, forceFreshExactSession: false };
void historicalFresh;
void historicalResume;
declare const agent: DKGAgent;
void agent.syncExactKnowledgeAssetsFromPeerDetailed('peer', 'cg', ordinary.assetUals, { forceFreshExactSession: true });
void agent.syncExactKnowledgeAssetsFromPeerDetailed('peer', 'cg', ordinary, { forceFreshExactSession: false });
void agent.syncExactKnowledgeAssetsFromPeerDetailed('peer', 'cg', ordinary, { exactFetchPurpose: 'vm-update-refresh', forceFreshExactSession: false });

void agent.syncExactKnowledgeAssetsFromPeerDetailed('peer', 'cg', ordinary.assetUals, { exactFetchPurpose: 'vm-update-refresh' });
void agent.syncExactKnowledgeAssetsFromPeerDetailed('peer', 'cg', challenge, { forceFreshExactSession: true });
// @ts-expect-error modern refresh purpose requires UAL-only selection, never challenge pins
void agent.syncExactKnowledgeAssetsFromPeerDetailed('peer', 'cg', challenge, { exactFetchPurpose: 'vm-update-refresh' });
declare const generalSelection: ExactAssetSelection;
// @ts-expect-error a general selection must narrow to UAL-only before modern refresh
void agent.syncExactKnowledgeAssetsFromPeerDetailed('peer', 'cg', generalSelection, { exactFetchPurpose: 'vm-update-refresh' });
const ordinaryLegacy: Pick<LegacyDurableSyncContext, 'exactAssetFetchPolicyFor'> = {
  exactAssetFetchPolicyFor: () => exactAssetFetchSessionPolicy(ordinary),
};
void ordinaryLegacy;
const unsupportedLegacyRefresh: Pick<LegacyDurableSyncContext, 'exactAssetFetchPolicyFor'> = {
  // @ts-expect-error positional callbacks cannot enforce VM-refresh freshness
  exactAssetFetchPolicyFor: () => refresh,
};
void unsupportedLegacyRefresh;

declare const operation: Parameters<DKGAgent['runLegacyDurableSyncForContextGraph']>[0];
void agent.runLegacyDurableSyncForContextGraph(operation, 'peer', 'cg', 1, {
  exactAssetSelection: ordinary, forceFreshExactSession: true, exactRecoveryTransportMode: 'stream-required',
});
void agent.runLegacyDurableSyncForContextGraphDetailed(operation, 'peer', 'cg', 1, {
  exactAssetSelection: challenge, forceFreshExactSession: false,
});

void agent.runExactAssetFetchForContextGraph('cg', ordinary.assetUals, {
  isCurrent: () => true, forceFreshExactSession: true,
});
