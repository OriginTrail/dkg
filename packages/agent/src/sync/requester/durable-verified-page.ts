// SPDX-License-Identifier: Apache-2.0
import type { AuthenticatedHeldMetadataDescriptor } from '../durable-integrity.js';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { DurableBatchVerificationMode } from '../../sync-verify-worker.js';
import { recordDurableSyncDiagnostics, type DurableSyncAccumulator } from '../durable-progress.js';
import type { DurableSyncContext } from './durable-sync.js';
import type { SyncPageResult } from './page-fetch.js';
import { assertNoLegacyRfc64ControlGraphs, partitionVerifiedGraphScopedAssets } from './verified-asset-preparation.js';

type VerificationContext = Pick<DurableSyncContext, 'ctx' | 'signal' | 'processDurableBatchInWorker'>;

export async function verifyDurablePage(context: VerificationContext, data: Quad[], meta: Quad[],
  acceptUnverified: boolean, mode: DurableBatchVerificationMode) {
  context.signal?.throwIfAborted();
  const processed = await context.processDurableBatchInWorker(data, meta, context.ctx, acceptUnverified, mode);
  context.signal?.throwIfAborted();
  return processed;
}

export function prepareDurableVerifiedPage(
  context: Pick<DurableSyncContext, 'admitVerifiedPage'>, contextGraphId: string,
  processed: Awaited<ReturnType<DurableSyncContext['processDurableBatchInWorker']>>,
) {
  assertNoLegacyRfc64ControlGraphs(contextGraphId, processed.verifiedData, processed.verifiedMeta,
    processed.verifiedGraphScopedDataGraphs ?? []);
  const partitioned = partitionVerifiedGraphScopedAssets(contextGraphId, processed.verifiedData, processed.verifiedMeta,
    processed.verifiedGraphScopedDataGraphs ?? []);
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

/** Preserve admissible META even when local holdings replace the DATA transfer. */
export async function persistDurableHoldingsMetadata(
  context: Pick<DurableSyncContext, 'ctx' | 'signal' | 'processDurableBatchInWorker' | 'storeInsert' | 'admitVerifiedPage'>,
  contextGraphId: string,
  meta: SyncPageResult,
  descriptors: readonly AuthenticatedHeldMetadataDescriptor[],
  accumulator: DurableSyncAccumulator,
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  // The caller owns the content proof through this write and has confirmed
  // these exact descriptors on chain. Missing assets grant no META authority.
  const processed = await verifyDurablePage(context, [], meta.quads, false,
    { kind: 'heldMetadata', descriptors });
  assertCurrent();
  if (processed.rejectedKcs > 0 || processed.dataRejectedMissingMeta > 0) {
    recordDurableSyncDiagnostics(accumulator, { rejectedKcs: processed.rejectedKcs,
      dataRejectedMissingMeta: processed.dataRejectedMissingMeta });
    throw new Error('Held durable generation has rejected metadata');
  }
  const partitioned = prepareDurableVerifiedPage(context, contextGraphId, processed);
  if (partitioned.assets.length > 0 || partitioned.remainingData.length > 0) {
    throw new Error('Held metadata verification unexpectedly selected unfetched DATA');
  }
  await persistDurableRemainingMetadata(context, partitioned.remainingMeta, accumulator, assertCurrent);
}
