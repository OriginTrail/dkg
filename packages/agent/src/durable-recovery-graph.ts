import { createStoredPrefixAcquirer } from './durable-recovery-held-store.js';
// SPDX-License-Identifier: Apache-2.0
import type { HeldAssetFence } from './durable-recovery-materialization.js';
import type { DurableRecoveryHost } from './durable-recovery-host.js';
import { type DurableRecoveryAuthority } from './durable-recovery-authority.js';
import { type OperationContext } from '@origintrail-official/dkg-core';
import { MemorySyncCheckpointStore } from './sync/checkpoint/state.js';
import { createDurableSyncBudget, normalizeDurableSyncTimeoutMs } from './sync/requester/durable-sync-budget.js';
import { runChallengeExactAssetFetch, runDurableSyncDetailed, runGraphOwnedDurableSyncDetailed, type DurableSyncCommonPorts, type DurableSyncPageTransport, type DurableSyncContext } from './sync/requester/durable-sync.js';
import { resolveSyncAgentsMeta } from './sync/agents-meta-policy.js';
import { runExactBatchStreamDriver } from './sync/requester/exact-batch-stream-driver.js';
import { resolveExactBatchStreamEnabled } from './sync/backpressure.js';
import { currentHeldGraphScopedAssetsConfirmer } from './sync/requester/durable-data-holdings.js';
import { SYNC_TOTAL_TIMEOUT_MS } from './dkg-agent-constants.js';

import type { DurableGraphCommonOptions, DurableGraphOptions, PhysicalDurableSyncResult } from './durable-recovery-types.js';
import type { GraphOwnedRecoveryInput } from './sync/requester/graph-owned-recovery.js';
import type { DurableRecoveryRoundOutcome } from './sync/durable-recovery-round.js';
export type DurableGraphHost = DurableRecoveryHost;

interface DurableGraphIdentity {
  readonly host: DurableGraphHost;
  readonly authority: DurableRecoveryAuthority;
  readonly ctx: OperationContext;
  readonly remotePeerId: string;
  readonly contextGraphId: string;
}
export interface DurableGraphRequest extends DurableGraphIdentity {
  readonly remainingContextGraphs: number;
  readonly options: DurableGraphOptions;
}

function prepareDurableGraph(request: DurableGraphIdentity & {
  readonly remainingContextGraphs: number; readonly options: DurableGraphCommonOptions;
}, exactRecovery: boolean) {
  const { host, authority, ctx, remotePeerId, contextGraphId, remainingContextGraphs, options } = request;

  const {
    onPhase,
    onAtomicCommitStarted,
    onAccessDenied,
    stopOnBackoffWorthyFailure,
    fetchTimeoutMs = SYNC_TOTAL_TIMEOUT_MS,
    authenticationTimeoutMs = fetchTimeoutMs,
    operationFetchDeadline,
    operationDeadline,
    settlementSliceTimeoutMs,
    signal,
    isCurrent,
  } = options;
  const syncAgentsMeta = resolveSyncAgentsMeta(host.policy().syncAgentsMeta, process.env.DKG_SYNC_AGENTS_META);
  const materialization = host.materialization({ ctx, contextGraphId, authority, isCurrent, onAtomicCommitStarted });
  const contextGraphBudget = createDurableSyncBudget({
    fetchTimeoutMs,
    authenticationTimeoutMs,
    exactRecovery,
    operationFetchDeadline,
    extendedRecovery: settlementSliceTimeoutMs !== undefined,
    operationDeadline,
  }).createContextGraphBudget({
    contextGraphId,
    remainingContextGraphs,
  });
  const ports: DurableSyncCommonPorts = {
    ctx,
    remotePeerId,
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
    stopOnBackoffWorthyFailure,
    admitVerifiedPage: page => authority.admitVerifiedPage(page),
    processDurableBatchInWorker: host.verification.processBatch,
    storeInsert: request => host.storeInsert(request),
    logInfo: (opCtx, message) => host.log.info(opCtx, message),
    logWarn: (opCtx, message) => host.log.warn(opCtx, message),
    logDebug: (opCtx, message) => host.log.debug(opCtx, message),
  };
  return { ports, materialization, contextGraphBudget };
}

/** Each mode supplies only its own transport policy; shared preparation captures no selection. */
function graphPageTransport(host: DurableGraphHost, options: {
  readonly forceFreshSession: boolean;
  readonly checkpointStore?: MemorySyncCheckpointStore;
}): DurableSyncPageTransport {
  return { fetchSyncPages: request => host.transport.fetchPages(request, {
    assetUals: request.exactAssetUals,
    forceFreshSession: options.forceFreshSession,
    checkpointStore: request.ephemeralRequesterState ? options.checkpointStore : undefined,
  }) };
}

/** Ordinary physical results are independent of graph-owner continuation policy. */
export async function runAdmittedDurableGraph(request: DurableGraphRequest): Promise<PhysicalDurableSyncResult> {
  const { host, authority, ctx, remotePeerId, contextGraphId, options } = request;
  const { signal, isCurrent, onVerifiedFullSnapshot, exactRecoveryTransportMode = 'stream-preferred' } = options;
  const exactAssetFetchPolicy = options.exactAssetFetchPolicy;
  const exactAssetSelection = exactAssetFetchPolicy?.selection;
  const { ports, materialization, contextGraphBudget } = prepareDurableGraph(request, exactAssetSelection !== undefined);
  if (exactAssetSelection?.kind === 'challenge-pinned') {
    const fetched = await runChallengeExactAssetFetch({
      ...ports,
      ...graphPageTransport(host, { forceFreshSession: onVerifiedFullSnapshot !== undefined,
        checkpointStore: new MemorySyncCheckpointStore() }),
      contextGraphIds: [contextGraphId],
      sinceBatchIdFor: options.sinceBatchIdFor,
      onVerifiedFullSnapshot,
      challengeSelectionFor: () => exactAssetSelection,
      authenticateChallengePinnedAsset: materialization.authenticateChallengePinnedAsset,
    });
    return {
      result: fetched.result,
      exactFetchDisposition: fetched.disposition,
      authenticatedExactAssets: fetched.authenticatedAssets,
    };
  }
  const durableContext: DurableSyncContext = {
    ...ports, ...host.checkpoints,
    ...graphPageTransport(host, { forceFreshSession: onVerifiedFullSnapshot !== undefined }),
    contextGraphIds: [contextGraphId],
    sinceBatchIdFor: options.sinceBatchIdFor,
    onVerifiedFullSnapshot,
    exactAssetFetchPolicyFor: () => exactAssetFetchPolicy?.kind !== 'ephemeral-challenge'
      ? exactAssetFetchPolicy : undefined,
    storeGraphScopedAsset: materialization.storeGraphScopedAsset,
  };
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
  const runPaging = (fence?: HeldAssetFence) => runDurableSyncDetailed({ ...durableContext,
    storedPrefix: fence ? createStoredPrefixAcquirer(host.heldStore?.prove, contextGraphId, fence.assertCurrent) : undefined,
  });
  return host.heldStore && !onVerifiedFullSnapshot
    ? materialization.withHeldAssetFence(runPaging, signal) : runPaging();
}

export interface OwnedDurableGraphRequest extends DurableGraphIdentity {
  readonly recovery: GraphOwnedRecoveryInput;
  readonly options: DurableGraphCommonOptions;
}

/** A graph owner receives a required decision without adding policy fields to transport results. */
export async function runAdmittedGraphOwnedDurableGraph(request: OwnedDurableGraphRequest): Promise<DurableRecoveryRoundOutcome> {
  const { host, authority, contextGraphId, recovery, options } = request;
  const { ports, materialization, contextGraphBudget } = prepareDurableGraph({ ...request, remainingContextGraphs: 1 }, false);
  const runPaging = async (fence?: HeldAssetFence): Promise<DurableRecoveryRoundOutcome> => {
    // An unbound subscription must persist its numeric binding before skipping DATA.
    const confirmCurrent = fence && fence.binding().onChainId !== undefined
      ? currentHeldGraphScopedAssetsConfirmer({ binding: fence.binding,
          authenticateHeld: authority.authenticateHeld?.bind(authority), budget: contextGraphBudget }) : undefined;
    return runGraphOwnedDurableSyncDetailed({ ...ports, ...host.checkpoints,
      ...graphPageTransport(host, { forceFreshSession: false }), contextGraphId,
      storeGraphScopedAsset: materialization.storeGraphScopedAsset,
      storedPrefix: fence ? createStoredPrefixAcquirer(host.heldStore?.prove, contextGraphId, fence.assertCurrent) : undefined,
      recovery: { ...recovery,
        held: confirmCurrent && host.heldStore && fence
          ? { prove: host.heldStore.prove, confirmCurrent, assertCurrent: fence.assertCurrent } : undefined },
    });
  };
  return host.heldStore ? materialization.withHeldAssetFence(runPaging, options.signal) : runPaging();
}
