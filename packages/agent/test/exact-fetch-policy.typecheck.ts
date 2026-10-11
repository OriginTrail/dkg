// SPDX-License-Identifier: Apache-2.0
import type { DurableSyncOptions } from '../src/dkg-agent-lifecycle.js';
import { createUalOnlyExactAssetSelection, createChallengePinnedExactAssetSelection } from '../src/sync/exact-assets.js';
import { exactAssetFetchSessionPolicy, type ExactAssetFetchSessionPolicy } from '../src/sync/requester/exact-durable-fetch.js';

const ordinary = createUalOnlyExactAssetSelection(['did:dkg:mock:31337/0x0000000000000000000000000000000000000001/7']);
const refresh = exactAssetFetchSessionPolicy(ordinary, 'vm-update-refresh');
const accepted: DurableSyncOptions = { exactAssetFetchPolicy: refresh };
void accepted;
const challenge = createChallengePinnedExactAssetSelection([{ assetUal: ordinary.assetUals[0]!, merkleRootHex: '1'.repeat(64), merkleLeafCount: 1n }]);
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
