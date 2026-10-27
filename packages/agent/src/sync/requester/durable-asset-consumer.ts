// SPDX-License-Identifier: Apache-2.0
import type { ExactAssetCommitment } from '../exact-assets.js';
import { recordDurableSyncDiagnostics, type DurableSyncAccumulator } from '../durable-progress.js';
import type { DurableSyncContext, DurableSyncChallengePinnedAuthenticationRequest } from './durable-sync.js';
import type { VerifiedGraphScopedAsset, ChallengePinnedGraphScopedAsset } from './graph-scoped-materialization.js';

/** The shared write loop receives exactly one required consumer, selected before entry. */
export type DurableAssetConsumer = (asset: VerifiedGraphScopedAsset, authenticationDeadline: number) => Promise<void>;
export interface DurableSettlementProgress {
  readonly accumulator: DurableSyncAccumulator;
  readonly committedExactAssetUals: string[];
  readonly authenticatedExactAssets: ChallengePinnedGraphScopedAsset[];
}

export function challengeAssetConsumer(input: {
  readonly context: Pick<DurableSyncContext, 'ctx' | 'signal' | 'logDebug'>;
  readonly authenticate: (request: DurableSyncChallengePinnedAuthenticationRequest) => Promise<ChallengePinnedGraphScopedAsset>;
  readonly commitments: ReadonlyMap<string, ExactAssetCommitment>;
  readonly evidence: ChallengePinnedGraphScopedAsset[];
}): DurableAssetConsumer {
  return async (asset, authenticationDeadline) => {
    const commitment = input.commitments.get(asset.ual);
    if (!commitment) throw new Error(`Challenge-pinned durable sync returned unselected asset ${asset.ual}`);
    const authenticated = await input.authenticate({ asset, commitment, authenticationDeadline, signal: input.context.signal });
    input.evidence.push(authenticated);
    input.context.logDebug(input.context.ctx, `Authenticated challenge-scoped exact asset ${asset.ual}`);
  };
}

export function materializedAssetConsumer(input: {
  readonly context: Pick<DurableSyncContext, 'ctx' | 'signal' | 'logDebug' | 'logWarn'>;
  readonly materialize: NonNullable<DurableSyncContext['storeGraphScopedAsset']>;
  readonly accumulator: DurableSyncAccumulator;
  readonly committedExactAssetUals?: string[];
}): DurableAssetConsumer {
  return async (asset, authenticationDeadline) => {
    const outcome = await input.materialize({ asset, authenticationDeadline, signal: input.context.signal });
    const { ctx, logDebug, logWarn } = input.context;
    if (outcome === 'applied') {
      input.committedExactAssetUals?.push(asset.ual);
      // Record each atomic commit immediately: a later failure must not erase it.
      recordDurableSyncDiagnostics(input.accumulator, { insertedDataTriples: asset.dataQuads.length,
        insertedMetaTriples: asset.metadataQuads.length, insertedTriples: asset.dataQuads.length + asset.metadataQuads.length });
    } else if (outcome === 'stale') {
      logDebug(ctx, `Skipped stale graph-scoped durable assertion ${asset.ual} v${asset.assertionVersion}`);
    } else {
      logWarn(ctx, `Quarantined graph-scoped durable assertion ${asset.ual} v${asset.assertionVersion}`);
    }
  };
}
