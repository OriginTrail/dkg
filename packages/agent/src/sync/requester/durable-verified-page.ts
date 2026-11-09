// SPDX-License-Identifier: Apache-2.0
import type { Quad } from '@origintrail-official/dkg-storage';
import type { DurableBatchVerificationMode } from '../../sync-verify-worker.js';
import { recordDurableSyncDiagnostics, type DurableSyncAccumulator } from '../durable-progress.js';
import type { DurableSyncContext } from './durable-sync.js';
import type { PreparedDurableDataStrategy } from './durable-holdings-phase.js';
import type { SyncPageResult } from './page-fetch.js';
import { assertNoLegacyRfc64ControlGraphs, partitionVerifiedGraphScopedAssets } from './verified-asset-preparation.js';

type VerificationContext = Pick<DurableSyncContext, 'ctx' | 'signal' | 'processDurableBatchInWorker'>;
interface VerificationInput {
  readonly metaResult: SyncPageResult;
}
/** Both transfer plans enter one verification/storage scope; DATA completion remains explicit. */
export type PreparedDurableVerificationInput = VerificationInput & (
  | { readonly kind: 'held'; readonly data: [];
      readonly mode: Extract<DurableBatchVerificationMode, { kind: 'heldMetadata' }>;
      readonly holdings: Exclude<PreparedDurableDataStrategy, { kind: 'full' }> }
  | { readonly kind: 'fetched'; readonly data: Quad[];
      readonly mode: Exclude<DurableBatchVerificationMode, { kind: 'heldMetadata' }>;
      readonly rawDataResult: SyncPageResult;
      readonly dataResult: SyncPageResult; readonly descriptorCoverageComplete: boolean;
      readonly returnedDescriptorCount: number }
);

export async function verifyDurablePage(context: VerificationContext,
  input: PreparedDurableVerificationInput, acceptUnverified: boolean) {
  context.signal?.throwIfAborted();
  const processed = await context.processDurableBatchInWorker(input.data, input.metaResult.quads,
    context.ctx, acceptUnverified, input.mode);
  context.signal?.throwIfAborted();
  return processed;
}

export function prepareDurableVerifiedPage(
  context: Pick<DurableSyncContext, 'admitVerifiedPage'>, contextGraphId: string,
  processed: Awaited<ReturnType<DurableSyncContext['processDurableBatchInWorker']>>,
  input: PreparedDurableVerificationInput,
) {
  assertNoLegacyRfc64ControlGraphs(contextGraphId, processed.verifiedData, processed.verifiedMeta,
    processed.verifiedGraphScopedDataGraphs ?? []);
  const partitioned = partitionVerifiedGraphScopedAssets(contextGraphId, processed.verifiedData, processed.verifiedMeta,
    processed.verifiedGraphScopedDataGraphs ?? []);
  if (input.kind === 'held' && (partitioned.assets.length > 0 || partitioned.remainingData.length > 0)) {
    throw new Error('Held metadata verification unexpectedly selected unfetched DATA');
  }
  context.admitVerifiedPage?.(partitioned);
  return partitioned;
}

export async function persistDurableRemainingMetadata(
  context: Pick<DurableSyncContext, 'signal' | 'storeInsert'>, quads: Quad[],
  accumulator: DurableSyncAccumulator, assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  if (quads.length > 0) {
    await context.storeInsert({ quads, signal: context.signal });
    recordDurableSyncDiagnostics(accumulator, { insertedTriples: quads.length, insertedMetaTriples: quads.length });
  }
  assertCurrent();
}
