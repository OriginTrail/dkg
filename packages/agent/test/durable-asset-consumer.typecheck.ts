import { challengeAssetConsumer, materializedAssetConsumer } from '../src/sync/requester/durable-asset-consumer.js';
import type { DurableSyncContext } from '../src/sync/requester/durable-sync.js';
import type { DurableSyncAccumulator } from '../src/sync/durable-progress.js';
import type { FetchedDurableAssetSettlementRequest } from '../src/sync/requester/durable-fetched-assets.js';

declare const context: DurableSyncContext;
declare const accumulator: DurableSyncAccumulator;
// @ts-expect-error A challenge consumer requires an authenticator.
challengeAssetConsumer({ context, commitments: new Map(), evidence: [] });
// @ts-expect-error A durable consumer requires materialization.
materializedAssetConsumer({ context, accumulator });
declare const requestWithoutConsumer: Omit<FetchedDurableAssetSettlementRequest, 'settleAsset'>;
// @ts-expect-error The shared loop cannot accept an optional capability bag.
const invalid: FetchedDurableAssetSettlementRequest = requestWithoutConsumer;
void invalid;

import { runChallengeExactAssetFetch, type ChallengeExactAssetFetchContext } from '../src/sync/requester/durable-sync.js';
declare const challengeWithoutAuthenticator: Omit<ChallengeExactAssetFetchContext, 'authenticateChallengePinnedAsset'>;
// @ts-expect-error Mode selection cannot erase the challenge entry's required authenticator.
void runChallengeExactAssetFetch(challengeWithoutAuthenticator);
