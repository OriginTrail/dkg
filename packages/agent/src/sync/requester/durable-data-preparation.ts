// SPDX-License-Identifier: Apache-2.0
import type { DurableSyncContext, DurableSyncPhaseRequest } from './durable-sync.js';
import type { PreparedDurableMeta } from './durable-meta-phase.js';
import type { PreparedDurableDataStrategy } from './durable-holdings-phase.js';
import type { PreparedDurableVerificationInput } from './durable-verified-page.js';
import type { DurableGraphSettlementGuard } from './durable-prefix-proof.js';
import type { DurableBatchVerificationMode } from '../../sync-verify-worker.js';
import type { ExactAssetSelection } from '../exact-assets.js';
import type { SyncPageResult } from './page-fetch.js';
import { graphScopedDurableManifestPrefixAtOffset, isGraphScopedDurableManifestBoundary,
  planBoundedGraphScopedDurableBatch } from '../durable-integrity.js';
import { filterExactAssetDurablePayload } from './exact-durable-fetch.js';
import { createDurableDataRoundBoundary } from './durable-data-round.js';

type PreparationContext = Pick<DurableSyncContext, 'ctx' | 'signal' | 'contentProofs' | 'deleteCheckpoint' | 'logInfo' | 'logWarn'>;


/** Own DATA transport, coordinate projection and prefix-proof acquisition before shared verification. */
export async function prepareDurableDataInput(context: PreparationContext, input: {
  readonly contextGraphId: string;
  readonly dataGraph: string;
  readonly metaResult: SyncPageResult;
  readonly preparedMeta: PreparedDurableMeta;
  readonly dataPlan: PreparedDurableDataStrategy;
  readonly sinceBatchId?: string;
  readonly isSystemContextGraph: boolean;
  readonly exactAssetSelection?: ExactAssetSelection;
  readonly exactAssetUals?: readonly string[];
  readonly settlementSliceDeadline?: number;
  readonly requireCompleteSnapshot: boolean;
  readonly fetchData: (request: DurableSyncPhaseRequest) => Promise<SyncPageResult>;
  readonly settlement: DurableGraphSettlementGuard;
  readonly events: { peerResponded(): void; rejectResume(offset: number): void };
}): Promise<PreparedDurableVerificationInput> {
  const { ctx, signal, deleteCheckpoint, logInfo, logWarn } = context;
  const { contextGraphId: pid, dataGraph, metaResult, preparedMeta, dataPlan, sinceBatchId,
    isSystemContextGraph, exactAssetSelection, exactAssetUals, settlementSliceDeadline, requireCompleteSnapshot,
    fetchData: fetchPhase, settlement, events } = input;
  const graphScopedManifest = preparedMeta.manifestPlan;
  if (dataPlan.kind !== 'full') {
    settlement.assertCurrent();
    return { kind: 'held', data: [], metaResult,
      mode: { kind: 'heldMetadata', descriptors: dataPlan.descriptors },
      holdings: dataPlan };
  } else {
    const rawDataResult = await fetchPhase({
      phase: 'data',
      graphUri: dataGraph,
      sinceBatchId,
      manifestDigest: graphScopedManifest?.manifestDigest,
      manifestPrefixDigestAtOffset: graphScopedManifest
        ? (offset) => graphScopedDurableManifestPrefixAtOffset(
          graphScopedManifest!,
          offset,
        )?.prefixDigest
        : undefined,
      forceFreshSession: preparedMeta.forceFreshUnboundDataSession || (graphScopedManifest !== null && !context.contentProofs),
      // A full-graph round holds what it fetched until it is verified and
      // stored, so it ends at a checkpointable graph within a row/heap budget.
      // A caller that needs one complete snapshot from row 0 keeps one round.
      shouldStopAfterPage: graphScopedManifest && exactAssetUals === undefined && !requireCompleteSnapshot
        ? createDurableDataRoundBoundary({ manifest: graphScopedManifest, settlementSliceDeadline,
            onHardLimit: ({ resumedFromOffset, nextOffset, acceptedQuads }) => logWarn(ctx,
              `Durable data round for "${pid}" reached its hard limit at ${acceptedQuads} rows `
                + `(offset ${resumedFromOffset}->${nextOffset}) without a complete graph to checkpoint`) })
        : undefined,
    });
    settlement.assertCurrent();
    events.peerResponded();
    const preparedPayload = prepareDurableVerificationPayload({
      rawDataResult,
      rawMetaResult: metaResult,
      preparedMeta,
      exactAssetSelection,
    });
    const dataResult = preparedPayload.dataResult;
    const effectiveMetaResult = preparedPayload.metaResult;
    const exactAssetDescriptorCoverageComplete =
      preparedPayload.exactDescriptorCoverageComplete;
    const exactAssetReturnedDescriptorCount =
      preparedPayload.exactReturnedDescriptorCount;
    if (exactAssetUals !== undefined && !exactAssetDescriptorCoverageComplete) {
      logWarn(
        ctx,
        `Exact durable response for "${pid}" did not cover every requested asset descriptor`,
      );
    }

    let effectiveDataResult = dataResult;
    let dataForVerification = dataResult.quads;
    let verificationMode: DurableBatchVerificationMode = sinceBatchId === undefined
      ? { kind: 'fullSnapshot' }
      : { kind: 'sinceBatchId', sinceBatchId };

    // A rootless full snapshot is a deterministic concatenation of complete
    // exact graphs. Always compare a graph-scoped response with its verified
    // metadata manifest: a relayed stream can close cleanly after a prefix
    // and surface `completed=true` even though later graphs never arrived.
    // Verify and persist only complete leading graphs, checkpoint their
    // absolute row boundary, and call the phase complete only at the manifest
    // total. A partial final graph is deliberately discarded and retried.
    // This gives large V2 snapshots bounded memory and monotonic progress
    // without weakening legacy/mixed-layout fail-closed behaviour.
    if (
      sinceBatchId === undefined
      && !isSystemContextGraph
    ) {
      if (
        graphScopedManifest
        && dataResult.resumedFromOffset > 0
        && dataResult.manifestDigest !== graphScopedManifest.manifestDigest
      ) {
        deleteCheckpoint(dataResult.checkpointKey);
        throw Object.assign(
          new Error(
            `Discarding rootless durable response for "${pid}": resumed DATA `
            + 'continuation is not bound to the completed META generation',
          ),
          { code: 'SYNC_DATA_MANIFEST_UNBOUND' },
        );
      }
      const resumeIsManifestBoundary = dataResult.resumedFromOffset > 0
        ? graphScopedManifest !== null
          && isGraphScopedDurableManifestBoundary(
            graphScopedManifest,
            dataResult.resumedFromOffset,
          )
        : true;
      if (resumeIsManifestBoundary === false) {
        // An OFFSET inside an exact assertion graph can never produce a
        // complete first graph in this round. Keeping it creates a permanent
        // N-1 verification loop (for example 9,999/10,000 rows). Delete the
        // paired responder session/checkpoint and retry from offset zero on
        // the next bounded sync; never store this non-contiguous suffix.
        deleteCheckpoint(dataResult.checkpointKey);
        throw Object.assign(
          new Error(
            `Discarding rootless durable response for "${pid}": resumed offset `
            + `${dataResult.resumedFromOffset} is inside an assertion graph; `
            + 'resetting the data checkpoint to a manifest boundary',
          ),
          { code: 'SYNC_GRAPH_CHECKPOINT_MISALIGNED' },
        );
      }
      const responderCursorDelta = (dataResult.rawNextOffset ?? dataResult.nextOffset)
        - (dataResult.rawResumedFromOffset ?? dataResult.resumedFromOffset);
      if (responderCursorDelta !== dataResult.quads.length) {
        logWarn(
          ctx,
          `Rootless durable cursor drift for "${pid}": responder advanced `
            + `${responderCursorDelta} row(s) but delivered ${dataResult.quads.length}; `
            + 'projecting only the verified complete-graph prefix',
        );
      }
      const bounded = graphScopedManifest
        ? planBoundedGraphScopedDurableBatch(
            dataResult.quads,
            graphScopedManifest,
            dataResult.resumedFromOffset,
            dataResult.rawNextOffset ?? dataResult.nextOffset,
            dataResult.completed,
            dataResult.rawResumedFromOffset ?? dataResult.resumedFromOffset,
            dataResult.quadRawOffsets,
          )
        : null;
      if (!bounded && graphScopedManifest) {
        deleteCheckpoint(dataResult.checkpointKey);
        if (dataResult.resumedFromOffset > 0) events.rejectResume(dataResult.resumedFromOffset);
        throw Object.assign(
          new Error(
            `Discarding rootless durable response for "${pid}": responder and manifest coordinates cannot be reconciled`,
          ),
          { code: 'SYNC_DATA_CURSOR_UNMAPPABLE' },
        );
      }
      if (bounded) {
        dataForVerification = bounded.dataQuads;
        const boundedCompleted = dataResult.completed
          && bounded.safeNextOffset === bounded.manifestRowCount;
        if (boundedCompleted) {
          const { localYield: _impossibleLocalYield, ...completedResult } = dataResult;
          effectiveDataResult = {
            ...completedResult,
            quads: bounded.dataQuads,
            nextOffset: bounded.safeNextOffset,
            rawNextOffset: bounded.safeRawNextOffset,
            completed: true,
          };
        } else {
          effectiveDataResult = {
            ...dataResult,
            quads: bounded.dataQuads,
            nextOffset: bounded.safeNextOffset,
            rawNextOffset: bounded.safeRawNextOffset,
            completed: false,
          };
        }
        verificationMode = {
          kind: 'changelogPage',
          changedDataGraphs: bounded.changedDataGraphs,
        };
        logInfo(
          ctx,
          `Rootless durable progress for "${pid}": `
            + `${bounded.completedGraphCount} complete graph(s), `
            + `safe offset ${dataResult.resumedFromOffset}->${bounded.safeNextOffset} `
            + `of ${bounded.manifestRowCount} (raw ${dataResult.rawNextOffset ?? dataResult.nextOffset}->${bounded.safeRawNextOffset})`,
        );
      }
    }

    if (graphScopedManifest && dataResult.resumedFromOffset > 0) {
      await settlement.acquire(graphScopedManifest, dataResult.resumedFromOffset, () => {
        deleteCheckpoint(dataResult.checkpointKey);
        deleteCheckpoint(metaResult.checkpointKey);
        events.rejectResume(dataResult.resumedFromOffset);
      }, signal);
    } else settlement.releaseUnneededHoldings();

    return { kind: 'fetched', data: dataForVerification, metaResult: effectiveMetaResult,
      mode: verificationMode, rawDataResult, dataResult: effectiveDataResult,
      descriptorCoverageComplete: exactAssetDescriptorCoverageComplete,
      returnedDescriptorCount: exactAssetReturnedDescriptorCount };
  }
}

function prepareDurableVerificationPayload(input: {
  readonly rawDataResult: SyncPageResult;
  readonly rawMetaResult: SyncPageResult;
  readonly preparedMeta: PreparedDurableMeta;
  readonly exactAssetSelection?: ExactAssetSelection;
}): {
  readonly dataResult: SyncPageResult;
  readonly metaResult: SyncPageResult;
  readonly exactDescriptorCoverageComplete: boolean;
  readonly exactReturnedDescriptorCount: number;
} {
  if (input.exactAssetSelection === undefined) {
    return {
      dataResult: input.rawDataResult,
      metaResult: input.preparedMeta.metaForManifest,
      exactDescriptorCoverageComplete:
        input.preparedMeta.exactDescriptorCoverageComplete,
      exactReturnedDescriptorCount: 0,
    };
  }
  const exact = filterExactAssetDurablePayload(
    input.rawDataResult.quads,
    input.rawMetaResult.quads,
    input.exactAssetSelection,
  );
  const exactDataSet = new Set(exact.dataQuads);
  const exactDataRawOffsets = input.rawDataResult.quadRawOffsets?.filter(
    (_, index) => exactDataSet.has(input.rawDataResult.quads[index]!),
  );
  return {
    metaResult: { ...input.rawMetaResult, quads: exact.metaQuads },
    dataResult: {
      ...input.rawDataResult,
      quads: exact.dataQuads,
      ...(exactDataRawOffsets
        ? { quadRawOffsets: exactDataRawOffsets }
        : { quadRawOffsets: undefined }),
    },
    exactDescriptorCoverageComplete: exact.descriptorCoverageComplete,
    exactReturnedDescriptorCount: exact.returnedDescriptorCount,
  };
}

