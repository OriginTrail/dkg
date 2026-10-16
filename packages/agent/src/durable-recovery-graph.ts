// SPDX-License-Identifier: Apache-2.0
import type { DurableRecoveryHost } from './durable-recovery-host.js';
import { createAbortError as asSyncFetchAbortError } from './bounded-operation.js';
import { authenticateChallengePinnedGraphScopedAssetWithinDeadline } from './durable-recovery-authentication.js';
import { memoizeRecoveryBindingProof, type DurableRecoveryAuthority, type DurableRecoveryInput } from './durable-recovery-authority.js';
import { type OperationContext } from '@origintrail-official/dkg-core';
import { materializeVerifiedGraphScopedAsset, type GraphScopedMaterializationOutcome } from './sync/requester/graph-scoped-materialization.js';
import { deleteSyncPageCheckpoint } from './sync/requester/page-fetch.js';
import { exactAssetUalsForSelection } from './sync/exact-assets.js';
import { MemorySyncCheckpointStore } from './sync/checkpoint/state.js';
import { createDurableSyncBudget, normalizeDurableSyncTimeoutMs } from './sync/requester/durable-sync-budget.js';
import { runChallengeExactAssetFetch, runDurableSync, runDurableSyncDetailed, type ChallengeExactAssetFetchContext, type DurableSyncContext } from './sync/requester/durable-sync.js';
import { createGraphScopedPhysicalOperationFence } from './sync/requester/graph-scoped-operation-fence.js';
import { normalizeExactAssetFetchPolicy } from './sync/requester/durable-sync-compat.js';
import { resolveSyncAgentsMeta } from './sync/agents-meta-policy.js';
import { runExactBatchStreamDriver } from './sync/requester/exact-batch-stream-driver.js';
import { resolveExactBatchStreamEnabled } from './sync/backpressure.js';
import { SYNC_TOTAL_TIMEOUT_MS } from './dkg-agent-constants.js';
import { contextGraphSubscriptionSyncPremisesEqual, isContextGraphSubscriptionStoredAgain } from './context-graph-subscription-policy.js';

import type { LegacyDurableContextGraphOptions, PhysicalDurableSyncResult } from './durable-recovery-types.js';
export type DurableGraphHost = DurableRecoveryHost;

export interface DurableGraphRequest {
  readonly host: DurableGraphHost;
  readonly authority: DurableRecoveryAuthority;
  readonly ctx: OperationContext;
  readonly remotePeerId: string;
  readonly contextGraphId: string;
  readonly remainingContextGraphs: number;
  readonly options: Omit<LegacyDurableContextGraphOptions, keyof DurableRecoveryInput>;
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
    durableMetaContinuation,
  } = options;
  const exactAssetFetchPolicy = normalizeExactAssetFetchPolicy(
    options.exactAssetFetchPolicy, () => options.exactAssetSelection, options.forceFreshExactSession,
  );
  const exactAssetSelection = exactAssetFetchPolicy?.selection;
  const assertLifecycleCurrent = () => {
    if (isCurrent?.() === false) {
      throw asSyncFetchAbortError(new Error(
        `Exact VM recovery lifecycle for ${contextGraphId} is no longer current`,
      ));
    }
  };
  const syncAgentsMeta = resolveSyncAgentsMeta(host.config.syncAgentsMeta, process.env.DKG_SYNC_AGENTS_META);
  const verifyContextGraphBinding = memoizeRecoveryBindingProof(
    (id, onChainId, signal) => host.requireLocalCgMatchesOnChainSlot(id, onChainId, ctx, { signal }),
  );
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
  const runGraphScopedOperation = createGraphScopedPhysicalOperationFence({
    isClosed: () => host.graphScopedStoreClosed,
    captureSubscription: (operationContextGraphId) =>
      host.subscribedContextGraphs.get(operationContextGraphId),
    captureBindingGeneration: (operationContextGraphId) =>
      host.contextGraphBindingState.capture(operationContextGraphId),
    isBindingGenerationCurrent: (operationContextGraphId, generation) =>
      host.contextGraphBindingState.isGenerationCurrent(
        operationContextGraphId,
        generation,
      ),
    // The same subscription (not one deleted and subscribed again, whose
    // binding generation starts over) and the same premises for a store.
    isEquivalentSubscription: (captured, current) =>
      isContextGraphSubscriptionStoredAgain(captured, current)
      && contextGraphSubscriptionSyncPremisesEqual(captured, current),
    assertLifecycleCurrent,
    asAbortError: asSyncFetchAbortError,
    track: (run) => host.graphScopedStorePhysicalRuns.add(run),
    untrack: (run) => host.graphScopedStorePhysicalRuns.delete(run),
  });
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
    fetchSyncPages: ({
      ctx: opCtx,
      remotePeerId: peerId,
      contextGraphId: cgId,
      phase,
      graphUri,
      snapshotRef,
      sinceBatchId,
      manifestDigest,
      manifestPrefixDigestAtOffset,
      forceFreshSession,
      shouldStopAfterPage,
      returnAcceptedPrefixOnRetryableTransportFailure,
      requesterScope,
      ephemeralRequesterState,
      fetchContext,
    }) => {
      return host.fetchSyncPages(
        opCtx,
        peerId,
        cgId,
        false,
        phase,
        graphUri,
        fetchContext.deadline,
        {
          snapshotRef,
          sinceBatchId,
          signal: fetchContext.signal,
          forceFreshSession: forceFreshSession
            || onVerifiedFullSnapshot !== undefined,
          manifestDigest,
          manifestPrefixDigestAtOffset,
          shouldStopAfterPage,
          assetUals: exactAssetSelection === undefined
            ? undefined
            : exactAssetUalsForSelection(exactAssetSelection),
          returnAcceptedPrefixOnRetryableTransportFailure,
          requesterScope,
          checkpointStore: ephemeralRequesterState
            ? proofCheckpointStore
            : undefined,
          ephemeralRequesterState,
        },
      );
    },
    sinceBatchIdFor,
    exactAssetFetchPolicyFor: exactAssetFetchPolicy?.kind !== 'ephemeral-challenge'
      ? () => exactAssetFetchPolicy
      : undefined,
    durableMetaContinuation,
    stopOnBackoffWorthyFailure,
    admitVerifiedPage: page => authority.admitVerifiedPage(page),
    processDurableBatchInWorker: host.processDurableBatchInWorker.bind(host),
    storeInsert: ({ quads, signal: operationSignal }) => {
      return host.insertSyncedQuadsAndInvalidateListCache(quads, {
        priority: 'background',
        source: 'agent.durableSync.storeInsert',
        signal: operationSignal,
      });
    },
    ...(exactAssetSelection?.kind === 'challenge-pinned'
      ? {
          authenticateChallengePinnedAsset: ({
            asset,
            commitment,
            authenticationDeadline,
            signal: operationSignal,
          }) => runGraphScopedOperation({
            contextGraphId: asset.contextGraphId,
            signal: operationSignal,
            closedError: () => asSyncFetchAbortError(new Error(
              `Challenge-pinned authentication for ${asset.ual} is closed for node shutdown`,
            )),
            bindingChangedError: () => asSyncFetchAbortError(new Error(
              `Context graph binding for ${asset.contextGraphId} changed during challenge authentication`,
            )),
            operation: async ({ assertCurrent }) => {
              const authenticated =
                await authenticateChallengePinnedGraphScopedAssetWithinDeadline({
                  chain: host.chain,
                  asset,
                  commitment,
                  verifyContextGraphBinding,
                  authenticationDeadline,
                  signal: operationSignal,
                });
              assertCurrent();
              return authenticated;
            },
          }),
        }
      : {}),
    storeGraphScopedAsset: ({
      asset,
      authenticationDeadline,
      signal: operationSignal,
    }) => runGraphScopedOperation({
      contextGraphId: asset.contextGraphId,
      signal: operationSignal,
      closedError: () => asSyncFetchAbortError(new Error(
        `Graph-scoped store for ${asset.ual} is closed for node shutdown`,
      )),
      bindingChangedError: () => asSyncFetchAbortError(new Error(
        `Context graph binding for ${asset.contextGraphId} changed during graph-scoped store`,
      )),
      operation: async (control): Promise<GraphScopedMaterializationOutcome> => {
        const { isBindingCurrent, recaptureBindingGeneration, assertCurrent } = control;
        const authentication = await authority.authenticate(asset, authenticationDeadline, operationSignal);
        control.adoptEquivalentSubscription();
        assertCurrent();
        const subscription = control.subscription;
        const verifiedOnChainId = authentication.onChainContextGraphId;
        if (
          verifiedOnChainId
          && subscription?.onChainId
          && subscription.onChainId !== verifiedOnChainId
        ) {
          throw Object.assign(
            new Error(
              `Graph-scoped durable sync ${asset.ual} belongs to on-chain context graph `
              + `${verifiedOnChainId}, but local ${asset.contextGraphId} is already bound to `
              + `${subscription.onChainId}`,
            ),
            { code: 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH' },
          );
        }
        if (verifiedOnChainId && subscription && subscription.onChainId === undefined) {
          // An on-demand subscription binds in memory only; durable rows are
          // saved before the binding becomes visible.
          await host.persistContextGraphSyncStateStrict(
            asset.contextGraphId,
            { ...subscription, onChainId: verifiedOnChainId, lastReconciledOrdinal: 0 },
            'on-chain id binding',
            isBindingCurrent,
          );
          assertCurrent();
          host.bindSubscriptionOnChainId(
            asset.contextGraphId,
            subscription,
            verifiedOnChainId,
          );
          recaptureBindingGeneration();
          assertCurrent();
        }
        assertCurrent();
        onAtomicCommitStarted?.(asset.contextGraphId, asset.ual);
        assertCurrent();
        const outcome = await materializeVerifiedGraphScopedAsset({
          store: host.store,
          asset: authentication.asset,
          isCurrent: () => (isCurrent?.() ?? true) && isBindingCurrent(),
          shouldQuarantineCommitted: () => {
            const current = host.subscribedContextGraphs.get(asset.contextGraphId);
            return (subscription !== undefined && current === undefined)
              || (verifiedOnChainId !== null
                && current !== undefined
                && current.onChainId !== verifiedOnChainId);
          },
          options: {
            priority: 'background',
            source: 'agent.durableSync.graphScopedMaterialization',
            signal: operationSignal,
          },
          oversizeHooks: {
            recordDrops: (drops, seam) => host.oversizeTombstoneLog.record(drops, seam),
          },
        });
        if (outcome === 'applied') await host.reconcileAfterGraphScopedMaterialization(authentication.asset, ctx);
        return outcome;
      },
    }),
    onVerifiedFullSnapshot,
    deleteCheckpoint: (key) => deleteSyncPageCheckpoint(host.syncCheckpoints, key),
    setCheckpoint: (key, checkpoint) => {
      if (checkpoint.binding) {
        host.syncCheckpoints.setManifestBoundOffset(
          key,
          checkpoint.offset,
          checkpoint.binding.manifestDigest,
          Date.now(),
          checkpoint.binding.manifestPrefixDigest,
          checkpoint.binding.terminal,
          checkpoint.responderSessionOffset,
        );
      } else {
        host.syncCheckpoints.set(
          key,
          checkpoint.offset,
          Date.now(),
          checkpoint.responderSessionOffset,
        );
      }
    },
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
      router: host.router, capabilityOwner: host.owner,
      captureConnectionKey: () => host.getSyncReconcilerConnectionKey(remotePeerId),
      captureRefusalScope: () => host.captureExperimentalExactBatchRefusalScope(contextGraphId),
      isChainEnabled: () => host.chain.chainId !== 'none',
      getPeerProtocols: () => host.getPeerProtocols(remotePeerId),
      // The recovery pass that owns this exchange may have handed it its own fresh positive
      // answer; every other fetch, and any doubt about that answer, reads the authority itself.
      isRegisteredPublic: async () => authority.isRegisteredPublic(contextGraphId, signal),
      requestIdentity: () => ({
        requesterPeerId: host.peerId,
        computeSyncDigest: (...args) => host.computeSyncDigest(...args),
        getIdentityId: () => host.chain.getIdentityId(),
        signMessage: typeof host.chain.signMessage === 'function' ? host.chain.signMessage.bind(host.chain) : undefined,
      }),
      verification: {
        ctx,
        parseAndFilter: (text, graph, cg) => host.getOrCreateSyncVerifyWorker().parseAndFilter(text, graph, cg),
        processDurableBatchInWorker: durableContext.processDurableBatchInWorker,
        authenticationDeadline: contextGraphBudget.createGraphScopedAuthenticationDeadline,
        storeGraphScopedAsset: durableContext.storeGraphScopedAsset!,
      },
      reconnect: async (reconnectSignal) => {
        try {
          await host.ensurePeerConnected(remotePeerId, { signal: reconnectSignal });
        } catch {
          // Unreachable for now, or connected but no longer admitted.
          return false;
        }
        return host.node.libp2p.getConnections()
          .some((connection) => connection.remotePeer.toString() === remotePeerId);
      },
      logInfo: message => host.log.info(ctx, message),
    });
    switch (outcome.kind) {
      case 'settled': return outcome.detailed;
      case 'not-selected':
      case 'unsupported-before-start': return runDurableSyncDetailed(durableContext);
    }
  }
  return { result: await runDurableSync(durableContext) };
}
