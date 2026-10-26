// SPDX-License-Identifier: Apache-2.0
import type { DurableRecoveryRoundDecision } from './sync/durable-recovery-round.js';
import type { DurableRecoveryHost } from './durable-recovery-host.js';
import { type DurableRecoveryAuthority } from './durable-recovery-authority.js';
import type { ExactBatchStreamOutcome } from './sync/requester/exact-recovery-transport.js';
import { DurableSyncAdmissionBoundary } from './sync/requester/admission-boundary.js';
import { type OperationContext } from '@origintrail-official/dkg-core';
import { type ChallengePinnedGraphScopedAsset } from './sync/requester/graph-scoped-materialization.js';
import { type PhaseCallback } from '@origintrail-official/dkg-publisher';
import { exactAssetUalsForSelection } from './sync/exact-assets.js';
import { createDurableSyncFetchTimeoutMs, normalizeDurableSyncTimeoutMs } from './sync/requester/durable-sync-budget.js';
import { type ExactAssetResponderCapability } from './sync/requester/durable-sync.js';
import { mergeExactAssetResponderCapability, mergeExactDurableFetchDisposition, type ExactDurableFetchDisposition } from './sync/requester/exact-durable-fetch.js';
import { resolveSyncAgentsMeta } from './sync/agents-meta-policy.js';
import { runOrderedContextGraphSyncs } from './sync/requester/ordered-sync.js';

import { createDurableSyncAccumulator, durableSyncAccumulatorHasPeerTransportFailure, durableSyncAccumulatorFromResult, finalizeDurableSyncCompletion, markDurableTerminalBoundary, mergeDurableSyncAccumulatorInto, recordDurableSyncDiagnostics, type DurableSyncAccumulator } from './sync/durable-progress.js';
import { orderContextGraphIdsByPriority } from './sync/policy.js';

import { runAdmittedDurableGraph } from './durable-recovery-graph.js';
import type { DurableRecoveryOptions, AdmittedDurableSyncResult } from './durable-recovery-types.js';
import { runSyncSingleFlight } from './sync-single-flight.js';
import { runSerializedDurableContextGraphSync, createDurableSyncOperationBoundary, durableSyncSingleFlightKey, DURABLE_RECOVERY_HARD_TIMEOUT_MS } from './durable-recovery-scheduling.js';

export interface DurableRecoveryRequest {
  readonly host: DurableRecoveryHost;
  readonly authority: DurableRecoveryAuthority;
  readonly ctx: OperationContext;
  readonly remotePeerId: string;
  readonly contextGraphIds: string[];
  readonly onPhase?: PhaseCallback;
  readonly onAccessDenied?: (contextGraphId: string) => void;
  readonly sinceBatchIdFor?: (contextGraphId: string) => string | undefined;
  readonly options?: DurableRecoveryOptions;
}

/** Named internal request keeps operation-owned authority outside SDK options. */
export async function runDurableRecovery(request: DurableRecoveryRequest): Promise<AdmittedDurableSyncResult> {
  const { host, authority, ctx, remotePeerId, contextGraphIds, onPhase, onAccessDenied, sinceBatchIdFor, options } = request;

  const admissionBoundary = new DurableSyncAdmissionBoundary(options?.onWorkStarted);
  const syncAgentsMeta = resolveSyncAgentsMeta(host.policy().syncAgentsMeta, process.env.DKG_SYNC_AGENTS_META);
  const stopOnBackoffWorthyFailure = options?.stopOnBackoffWorthyFailure;
  const exactAssetFetchPolicy = options?.exactAssetFetchPolicy;
  const exactAssetSelection = exactAssetFetchPolicy?.selection;
  const exactAssetUals = exactAssetSelection === undefined
    ? undefined
    : exactAssetUalsForSelection(exactAssetSelection);
  const extendedRecovery = exactAssetUals !== undefined
    || options?.settlementSliceTimeoutMs !== undefined;
  const operationBoundary = createDurableSyncOperationBoundary({
    totalTimeoutMs: options?.totalTimeoutMs,
    maximumTimeoutMs: extendedRecovery
      ? DURABLE_RECOVERY_HARD_TIMEOUT_MS
      : undefined,
    signal: options?.signal,
  });
  const authenticationTimeoutMs = normalizeDurableSyncTimeoutMs(options?.totalTimeoutMs);
  const fetchTimeoutMs = createDurableSyncFetchTimeoutMs({
    totalTimeoutMs: options?.totalTimeoutMs,
    exactRecovery: exactAssetUals !== undefined,
    extendedRecovery,
  });
  const orderedContextGraphIds = orderContextGraphIdsByPriority(
    contextGraphIds,
    host.policy().syncContextGraphPriorities,
  );
  let exactFetchDisposition: ExactDurableFetchDisposition | undefined;
  let exactResponderCapability: ExactAssetResponderCapability | undefined;
  const authenticatedExactAssets: ChallengePinnedGraphScopedAsset[] = [];
  const committedExactAssetUals: string[] = [];
  // What the stream established about this peer for one graph. A run over
  // several graphs has no single answer, so it reports none.
  let recoveryRound: DurableRecoveryRoundDecision | undefined;
  let exactStreamOutcome: ExactBatchStreamOutcome | undefined;
  const markExactFetchIncomplete = () => {
    if (exactAssetUals === undefined) return;
    exactFetchDisposition = mergeExactDurableFetchDisposition(
      exactFetchDisposition,
      'incomplete',
    );
  };
  const runSync = async (): Promise<AdmittedDurableSyncResult> => {
    const accumulator = await runOrderedContextGraphSyncs<DurableSyncAccumulator>({
      work: orderedContextGraphIds.map((contextGraphId) => ({
        contextGraphId,
        lane: 'durable' as const,
        operationId: `durable:${contextGraphId}:${remotePeerId.slice(-8)}`,
        run: async (remainingContextGraphs) => {
          const detailed = await runAdmittedDurableGraph({
            host, authority, ctx, remotePeerId, contextGraphId, remainingContextGraphs,
            options: {
              onPhase,
              onAtomicCommitStarted: options?.onAtomicCommitStarted,
              onAccessDenied,
              sinceBatchIdFor,
              stopOnBackoffWorthyFailure,
              fetchTimeoutMs,
              exactAssetFetchPolicy,
              exactRecoveryTransportMode: options?.exactRecoveryTransportMode,
              authenticationTimeoutMs,
              operationFetchDeadline: operationBoundary.fetchDeadline,
              operationDeadline: operationBoundary.deadline,
              settlementSliceTimeoutMs: options?.settlementSliceTimeoutMs,
              signal: operationBoundary.signal,
              isCurrent: options?.isCurrent,
              graphRecovery: options?.graphRecovery,
            },
          });
          if (detailed.exactFetchDisposition !== undefined) {
            exactFetchDisposition = mergeExactDurableFetchDisposition(
              exactFetchDisposition,
              detailed.exactFetchDisposition,
            );
          }
          exactResponderCapability = mergeExactAssetResponderCapability(
            exactResponderCapability,
            detailed.exactResponderCapability,
          );
          if (detailed.authenticatedExactAssets !== undefined) {
            authenticatedExactAssets.push(...detailed.authenticatedExactAssets);
          }
          if (detailed.committedExactAssetUals !== undefined) {
            committedExactAssetUals.push(...detailed.committedExactAssetUals);
          }
          if (orderedContextGraphIds.length === 1) { exactStreamOutcome = detailed.exactStreamOutcome; recoveryRound = detailed.recoveryRound; }
          return durableSyncAccumulatorFromResult(detailed.result);
        },
      })),
      priorities: host.policy().syncContextGraphPriorities,
      emptyResult: createDurableSyncAccumulator,
      runWithAdmission: async (item, work) => {
        try {
          return await runSerializedDurableContextGraphSync(
            host.owner,
            remotePeerId,
            item.contextGraphId,
            () => host.admission.run({
              ctx, contextGraphId: item.contextGraphId, lane: item.lane,
              label: item.operationId, work,
              priorityOverride: options?.priority,
              operationSignal: operationBoundary.signal,
              source: options?.source,
              onWorkStarted: admissionBoundary.startWork,
            }),
            operationBoundary.signal,
          );
        } catch (error) {
          if (!operationBoundary.signal?.aborted) throw error;
          markExactFetchIncomplete();
          return markDurableTerminalBoundary(createDurableSyncAccumulator(), false);
        }
      },
      merge: mergeDurableSyncAccumulatorInto,
      markDeferred: (summary) => {
        admissionBoundary.defer();
        markExactFetchIncomplete();
        recordDurableSyncDiagnostics(summary, { deferredBackpressure: 1 });
        return markDurableTerminalBoundary(summary, false);
      },
      // Preserve already-merged progress, but record that cancellation left
      // requested Context Graphs unvisited so the aggregate cannot finalize
      // as complete.
      markSkipped: (summary) => {
        markExactFetchIncomplete();
        return markDurableTerminalBoundary(summary, false);
      },
      shouldContinue: () => !operationBoundary.signal?.aborted,
      // One CG's backoff-worthy round stays in the merged summary (its
      // terminal boundary is false, so the aggregate cannot finalize
      // complete, and the peer is not stamped fresh) while the remaining
      // CGs still get their turn. Only peer-never-responded rounds may
      // stop the batch, via the ordered fanout's consecutive-failure guard.
      isPeerTransportFailure: (part) => Boolean(
        stopOnBackoffWorthyFailure
        && durableSyncAccumulatorHasPeerTransportFailure(part),
      ),
      onDeferred: (item, error) => host.log.info(
        ctx,
        `Deferring durable sync at CG ${item.contextGraphId} due to local backpressure: ${error.message}`,
      ),
    });
    return {
      admission: admissionBoundary.snapshot(),
      ...(recoveryRound ? { recoveryRound } : {}),
      result: finalizeDurableSyncCompletion(accumulator),
      ...(exactFetchDisposition ? { exactFetchDisposition } : {}),
      ...(exactResponderCapability ? { exactResponderCapability } : {}),
      ...(authenticatedExactAssets.length === 0
        ? {}
        : { authenticatedExactAssets: Object.freeze([...authenticatedExactAssets]) }),
      ...(committedExactAssetUals.length === 0
        ? {}
        : { committedExactAssetUals: Object.freeze([...committedExactAssetUals]) }),
      ...(exactStreamOutcome === undefined ? {} : { exactStreamOutcome }),
    };
  };

  const singleFlightKey = durableSyncSingleFlightKey({
    remotePeerId,
    contextGraphIds: orderedContextGraphIds,
    stopOnBackoffWorthyFailure,
    fetchTimeoutMs,
    authenticationTimeoutMs,
    syncAgentsMeta,
    hasPhaseCallback: Boolean(onPhase),
    hasAtomicCommitCallback: Boolean(options?.onAtomicCommitStarted),
    hasWorkStartedCallback: Boolean(options?.onWorkStarted),
    hasAccessDeniedCallback: Boolean(onAccessDenied),
    hasSinceBatchIdResolver: Boolean(sinceBatchIdFor),
    hasSignal: Boolean(operationBoundary.signal),
    hasCurrentFence: Boolean(options?.isCurrent),
    hasChallengePinnedSelection: exactAssetSelection?.kind === 'challenge-pinned',
    hasForcedFreshExactSession: exactAssetFetchPolicy?.kind === 'vm-update-refresh',
    hasRecoveryAuthorityOwner: authority.coalescing === 'owner-only',
    exactAssetUals,
    settlementSliceTimeoutMs: options?.settlementSliceTimeoutMs,
    exactRecoveryTransportMode: options?.exactRecoveryTransportMode,
    priority: options?.priority,
  });
  const runWithinBoundary = async () => {
    try {
      return await runSync();
    } finally {
      operationBoundary.dispose();
    }
  };
  return singleFlightKey
    ? runSyncSingleFlight(host.owner, singleFlightKey, runWithinBoundary, {
      scope: 'durable',
      source: options?.source,
    })
    : runWithinBoundary();
}
