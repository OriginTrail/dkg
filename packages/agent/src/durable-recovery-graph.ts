import { createStoredPrefixAcquirer } from './durable-recovery-held-store.js';
// SPDX-License-Identifier: Apache-2.0
import type { HeldAssetFence } from './durable-recovery-materialization.js';
import type { DurableRecoveryHost } from './durable-recovery-host.js';
import { type DurableRecoveryAuthority } from './durable-recovery-authority.js';
import { type OperationContext } from '@origintrail-official/dkg-core';
import { exactAssetUalsForSelection } from './sync/exact-assets.js';
import { MemorySyncCheckpointStore } from './sync/checkpoint/state.js';
import { createDurableSyncBudget, normalizeDurableSyncTimeoutMs } from './sync/requester/durable-sync-budget.js';
import { runChallengeExactAssetFetch, runDurableSyncDetailed, type ChallengeExactAssetFetchContext, type DurableSyncContext } from './sync/requester/durable-sync.js';
import { resolveSyncAgentsMeta } from './sync/agents-meta-policy.js';
import { runExactBatchStreamDriver } from './sync/requester/exact-batch-stream-driver.js';
import { resolveExactBatchStreamEnabled } from './sync/backpressure.js';
import { currentHeldGraphScopedAssetsConfirmer } from './sync/requester/durable-data-holdings.js';
import { SYNC_TOTAL_TIMEOUT_MS } from './dkg-agent-constants.js';

import type { DurableGraphOptions, PhysicalDurableSyncResult } from './durable-recovery-types.js';
export type DurableGraphHost = DurableRecoveryHost;

export interface DurableGraphRequest {
  readonly host: DurableGraphHost;
  readonly authority: DurableRecoveryAuthority;
  readonly ctx: OperationContext;
  readonly remotePeerId: string;
  readonly contextGraphId: string;
  readonly remainingContextGraphs: number;
  readonly options: DurableGraphOptions;
}

/** Executes one admitted graph while retaining physical authentication and materialization ownership. */
export async function runAdmittedDurableGraph(request: DurableGraphRequest): Promise<PhysicalDurableSyncResult> {
  const { host, authority, ctx, remotePeerId, contextGraphId, remainingContextGraphs, options } = request;

  const {
    onPhase,
    onAtomicCommitStarted,
    onAccessDenied,
    sinceBatchIdFor,
    stopOnBackoffWorthyFailure,
    onVerifiedFullSnapshot,
    fetchTimeoutMs = SYNC_TOTAL_TIMEOUT_MS,
    exactRecoveryTransportMode = 'stream-preferred',
    authenticationTimeoutMs = fetchTimeoutMs,
    operationFetchDeadline,
    operationDeadline,
    settlementSliceTimeoutMs,
    signal,
    isCurrent,
    graphRecovery,
  } = options;
  const exactAssetFetchPolicy = options.exactAssetFetchPolicy;
  const exactAssetSelection = exactAssetFetchPolicy?.selection;
  const syncAgentsMeta = resolveSyncAgentsMeta(host.policy().syncAgentsMeta, process.env.DKG_SYNC_AGENTS_META);
  const materialization = host.materialization({ ctx, contextGraphId, authority, isCurrent, onAtomicCommitStarted });
  const contextGraphBudget = createDurableSyncBudget({
    fetchTimeoutMs,
    authenticationTimeoutMs,
    exactRecovery: exactAssetSelection !== undefined,
    operationFetchDeadline,
    extendedRecovery: settlementSliceTimeoutMs !== undefined,
    operationDeadline,
  }).createContextGraphBudget({
    contextGraphId,
    remainingContextGraphs,
  });
  const proofCheckpointStore = exactAssetSelection?.kind === 'challenge-pinned'
    ? new MemorySyncCheckpointStore()
    : undefined;
  const durableContext: DurableSyncContext & Partial<Pick<
    ChallengeExactAssetFetchContext,
    'authenticateChallengePinnedAsset'
  >> = {
    ctx,
    remotePeerId,
    contextGraphIds: [contextGraphId],
    onPhase,
    onAccessDenied,
    syncAgentsMeta,
    durableSyncBudget: {
      createContextGraphBudget: () => contextGraphBudget,
    },
    settlementSliceDeadline: settlementSliceTimeoutMs === undefined
      ? undefined
      : Math.min(
          Date.now() + normalizeDurableSyncTimeoutMs(settlementSliceTimeoutMs),
          operationDeadline ?? Number.POSITIVE_INFINITY,
        ),
    signal,
    fetchSyncPages: request => host.transport.fetchPages(request, {
      assetUals: exactAssetSelection === undefined ? undefined : exactAssetUalsForSelection(exactAssetSelection),
      forceFreshSession: onVerifiedFullSnapshot !== undefined,
      checkpointStore: request.ephemeralRequesterState ? proofCheckpointStore : undefined,
    }),
    sinceBatchIdFor,
    exactAssetFetchPolicyFor: exactAssetFetchPolicy?.kind !== 'ephemeral-challenge'
      ? () => exactAssetFetchPolicy
      : undefined,
    stopOnBackoffWorthyFailure,
    admitVerifiedPage: page => authority.admitVerifiedPage(page),
    processDurableBatchInWorker: host.verification.processBatch,
    storeInsert: request => host.storeInsert(request),
    ...(exactAssetSelection?.kind === 'challenge-pinned'
      ? { authenticateChallengePinnedAsset: materialization.authenticateChallengePinnedAsset }
      : {}),
    storeGraphScopedAsset: materialization.storeGraphScopedAsset,
    onVerifiedFullSnapshot,
    ...host.checkpoints,
    logInfo: (opCtx, message) => host.log.info(opCtx, message),
    logWarn: (opCtx, message) => host.log.warn(opCtx, message),
    logDebug: (opCtx, message) => host.log.debug(opCtx, message),
  };
  if (exactAssetSelection?.kind === 'challenge-pinned') {
    const {
      exactAssetSelectionFor: _exactAssetSelectionFor,
      storeGraphScopedAsset: _storeGraphScopedAsset,
      deleteCheckpoint: _deleteCheckpoint,
      setCheckpoint: _setCheckpoint,
      authenticateChallengePinnedAsset,
      ...challengeContext
    } = durableContext;
    if (authenticateChallengePinnedAsset === undefined) {
      throw new Error('Challenge-pinned exact fetch is missing its authentication consumer');
    }
    const fetched = await runChallengeExactAssetFetch({
      ...challengeContext,
      challengeSelectionFor: () => exactAssetSelection,
      authenticateChallengePinnedAsset,
    });
    return {
      result: fetched.result,
      exactFetchDisposition: fetched.disposition,
      authenticatedExactAssets: fetched.authenticatedAssets,
    };
  }
  if (exactAssetSelection !== undefined) {
    const outcome = await runExactBatchStreamDriver({
      contextGraphId, remotePeerId,
      selection: exactAssetSelection, transportMode: exactRecoveryTransportMode,
      streamEnabled: resolveExactBatchStreamEnabled(),
      fetchDeadline: contextGraphBudget.fetchDeadline, signal, isCurrent,
    }, {
      ...host.transport.stream(ctx, remotePeerId, contextGraphId),
      isRegisteredPublic: async () => authority.isRegisteredPublic(contextGraphId, signal),
      verification: {
        ctx,
        parseAndFilter: host.verification.parseAndFilter,
        processDurableBatchInWorker: durableContext.processDurableBatchInWorker,
        authenticationDeadline: contextGraphBudget.createGraphScopedAuthenticationDeadline,
        storeGraphScopedAsset: durableContext.storeGraphScopedAsset!,
      },

    });
    switch (outcome.kind) {
      case 'settled': return outcome.detailed;
      case 'not-selected':
      case 'unsupported-before-start': break; // Paging uses the same stored-prefix proof as full-graph recovery.
    }
  }
  // Resolve continuation policy once; snapshots own a fresh full walk.
  const continuation = onVerifiedFullSnapshot ? undefined : graphRecovery;
  const runPaging = (fence?: HeldAssetFence) => {
    // An unbound subscription must persist its numeric binding before skipping DATA.
    const confirmCurrent = continuation && fence && fence.binding().onChainId !== undefined
      ? currentHeldGraphScopedAssetsConfirmer({
          binding: fence.binding,
          reconcileHeld: (request, held) => host.heldStore?.reconcile?.(request, held, ctx) ?? Promise.resolve(),
          authenticateHeld: authority.authenticateHeld?.bind(authority), budget: contextGraphBudget,
        }) : undefined;
    return runDurableSyncDetailed({ ...durableContext,
      storedPrefix: fence ? createStoredPrefixAcquirer(host.heldStore?.prove, contextGraphId, fence.assertCurrent) : undefined,
      graphRecovery: continuation ? { ...continuation,
        held: confirmCurrent && host.heldStore && fence
          ? { prove: host.heldStore.prove, confirmCurrent, assertCurrent: fence.assertCurrent } : undefined,
      } : undefined,
    });
  };
  return host.heldStore && !onVerifiedFullSnapshot
    ? materialization.withHeldAssetFence(runPaging, signal) : runPaging();
}
