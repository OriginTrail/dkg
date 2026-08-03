import { createOperationContext, PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_SYNC, SYSTEM_CONTEXT_GRAPHS, type OperationContext } from '@origintrail-official/dkg-core';
import {
  classifyDurableProgress,
  type DurableProgressSummary,
} from '../durable-progress.js';

type SyncProgressSummary = DurableProgressSummary & { insertedTriples: number };

type SyncFromPeerResult = number | SyncProgressSummary;

export interface SyncOnConnectScopePlan {
  /** Bootstrap graphs frozen into the first durable request. */
  initialBootstrapContextGraphIds: readonly string[];
  /** Explicit plus automatic CGs frozen for the first durable request. */
  initialDurableContextGraphIds: readonly string[];
  /**
   * Scheduler-vetted automatic public CGs to complete before bootstrap.
   * Configured/private CGs must stay in the normal post-bootstrap path because
   * private SWM recovery depends on the refreshed Agents registry.
   */
  preBootstrapPublicContextGraphIds?: readonly string[];
  /** Explicit intent re-read after discovery, merged with the frozen automatic tail. */
  contextGraphIdsAfterDiscovery: () => string[];
}

export interface SyncOnConnectPeerOutcome {
  fresh: boolean;
  progress?: boolean;
}

interface SyncOnConnectCommonContext {
  remotePeer: string;
  syncingPeers: Set<string>;
  getPeerProtocols: (peerId: string) => Promise<string[]>;
  knownCorePeerIds: Set<string>;
  knownCorePeerIdsV2?: Set<string>;
  getSharedMemorySyncContextGraphs?: (
    remotePeerId: string,
    contextGraphIdsAfterDiscovery: readonly string[],
  ) => string[] | Promise<string[]>;
  syncFromPeer: (peerId: string, contextGraphIds?: string[]) => Promise<SyncFromPeerResult>;
  refreshMetaSyncedFlags: (contextGraphIds: Iterable<string>) => Promise<void>;
  discoverContextGraphsFromStore: () => Promise<number>;
  syncSharedMemoryFromPeer: (peerId: string, contextGraphIds: string[]) => Promise<SyncFromPeerResult>;
  syncSharedMemoryOnConnect?: boolean;
  logInfo: (ctx: OperationContext, message: string) => void;
  /**
   * Optional. Called when the peer is reachable but does not currently
   * advertise PROTOCOL_SYNC. The orchestrator (`DKGAgent`) uses this to
   * remember the peer so it can retry later — either when libp2p's
   * `peer:update` event reports a new protocol list, or when the periodic
   * sync reconciler ticks. See packages/agent/src/dkg-agent.ts.
   *
   * Without this hook, a peer whose identify hadn't completed at
   * `connection:open` time would be skipped FOREVER (the function reads
   * the protocol list once and returns); on inbound connections this
   * race is the dominant cause of a node never back-filling chunks
   * from its own peers.
   */
  onPeerSkippedNoSync?: (peerId: string, protocols: string[]) => void;
  /**
   * Optional. Called after sync accounting shows either real progress or a
   * denial-only clean response. `fresh=false` clears peer backoff without
   * marking the peer as cleanly fresh for reconnect suppression; `progress`
   * controls whether the periodic reconciler may write its long cooldown.
   */
  onPeerSynced?: (peerId: string, outcome?: SyncOnConnectPeerOutcome) => void;
}

interface LegacySyncOnConnectScopePlan {
  /**
   * New callers should make the bootstrap scope explicit. This stays optional
   * only at the legacy adapter boundary so existing deep imports keep their
   * historical system-graph default.
   */
  initialBootstrapContextGraphIds?: readonly string[];
  initialDurableContextGraphIds: readonly string[];
  contextGraphIdsAfterDiscovery: () => string[];
}

interface SyncOnConnectContext extends SyncOnConnectCommonContext {
  /** Legacy dynamic scope callback retained at the compatibility boundary. */
  getSyncContextGraphs?: () => string[];
  /** Legacy two-phase scope retained at the compatibility boundary. */
  contextGraphScope?: LegacySyncOnConnectScopePlan;
  /**
   * @deprecated Use contextGraphScope.initialBootstrapContextGraphIds. Kept so
   * existing deep-import callers can still opt out of Agents/Ontology.
   */
  includeSystemContextGraphs?: boolean;
}

interface PlannedSyncOnConnectContext extends SyncOnConnectCommonContext {
  /** Invoked only after the peer passes in-flight and protocol admission. */
  createScopePlan: () => SyncOnConnectScopePlan;
}

export type SyncOnConnectOutcome = 'synced' | 'skipped-no-sync' | 'already-syncing' | 'deferred-backpressure';

export class SyncOnConnectPostSyncError extends Error {
  readonly originalError: unknown;
  readonly backoffEligible: boolean;

  constructor(remotePeer: string, originalError: unknown, options: { backoffEligible: boolean }) {
    const detail = originalError instanceof Error ? originalError.message : String(originalError);
    super(`post-sync step failed for peer ${remotePeer.slice(-8)}: ${detail}`, { cause: originalError });
    this.name = 'SyncOnConnectPostSyncError';
    this.originalError = originalError;
    this.backoffEligible = options.backoffEligible;
  }
}

interface SyncResultAccounting {
  insertedTriples: number;
  madeProgress: boolean;
  backoffWorthyFailure: boolean;
  denied: boolean;
  failed: boolean;
  deferredByBackpressure: boolean;
  metadataOnly: boolean;
  cleanNonMetadataResponse: boolean;
}

function classifySyncResult(
  result: SyncFromPeerResult,
  complete?: boolean,
): SyncResultAccounting {
  if (typeof result === 'number') {
    return {
      insertedTriples: result,
      madeProgress: true,
      backoffWorthyFailure: false,
      denied: false,
      failed: false,
      deferredByBackpressure: false,
      metadataOnly: false,
      cleanNonMetadataResponse: true,
    };
  }

  const progress = classifyDurableProgress(result, { complete });
  return {
    insertedTriples: result.insertedTriples,
    madeProgress: progress.madeReconnectProgress,
    backoffWorthyFailure: progress.backoffWorthyFailure,
    denied: progress.denied,
    failed: progress.phaseFailed || progress.integrityRejected,
    deferredByBackpressure: progress.deferredByBackpressure,
    metadataOnly: progress.metadataOnly,
    cleanNonMetadataResponse: progress.cleanNonMetadataResponse,
  };
}

/** Compatibility adapter for existing direct callers of the generic orchestrator. */
export function runSyncOnConnect(context: SyncOnConnectContext): Promise<SyncOnConnectOutcome> {
  const {
    getSyncContextGraphs = () => [],
    contextGraphScope,
    includeSystemContextGraphs = true,
    syncFromPeer,
    ...common
  } = context;
  const defaultBootstrapContextGraphIds = includeSystemContextGraphs
    ? [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY]
    : [];
  let initialCall = true;
  return runSyncOnConnectWithScopePlan({
    ...common,
    createScopePlan: () => contextGraphScope ? {
      initialBootstrapContextGraphIds: contextGraphScope.initialBootstrapContextGraphIds
        ?? defaultBootstrapContextGraphIds,
      initialDurableContextGraphIds: contextGraphScope.initialDurableContextGraphIds,
      contextGraphIdsAfterDiscovery: contextGraphScope.contextGraphIdsAfterDiscovery,
    } : (() => {
      const initialDurableContextGraphIds = [...(getSyncContextGraphs() ?? [])];
      return {
        initialBootstrapContextGraphIds: defaultBootstrapContextGraphIds,
        initialDurableContextGraphIds,
        contextGraphIdsAfterDiscovery: () => getSyncContextGraphs() ?? [],
      };
    })(),
    // Preserve the historical one-argument initial call shape for direct
    // callback-only clients. Legacy two-phase callers already received an
    // explicit scope, while the normalized orchestrator always supplies one.
    syncFromPeer: (peerId, contextGraphIds) => {
      if (initialCall && !contextGraphScope) {
        initialCall = false;
        return syncFromPeer(peerId);
      }
      initialCall = false;
      return syncFromPeer(peerId, contextGraphIds);
    },
  });
}

export async function runSyncOnConnectWithScopePlan(
  context: PlannedSyncOnConnectContext,
): Promise<SyncOnConnectOutcome> {
  const {
    remotePeer,
    syncingPeers,
    getPeerProtocols,
    knownCorePeerIds,
    knownCorePeerIdsV2 = new Set<string>(),
    createScopePlan,
    getSharedMemorySyncContextGraphs,
    syncFromPeer,
    refreshMetaSyncedFlags,
    discoverContextGraphsFromStore,
    syncSharedMemoryFromPeer,
    syncSharedMemoryOnConnect = true,
    logInfo,
  } = context;

  const ctx = createOperationContext('sync');
  const shortPeer = remotePeer.slice(-8);

  if (syncingPeers.has(remotePeer)) return 'already-syncing';
  syncingPeers.add(remotePeer);

  let durableSyncCompleted = false;
  let madeProgress = false;
  let sawDeniedPhase = false;
  let sawFailedPhase = false;
  let sawBackoffWorthyFailure = false;
  let sawBackpressureDeferral = false;
  let sawDurableMetadataOnlyDetailedSync = false;
  let sawExplicitIncompleteDurableResult = false;
  let cleanDurableDetailedRound = false;
  const recordSyncAccounting = (
    result: SyncFromPeerResult,
    phase: 'durable' | 'shared',
  ): SyncResultAccounting => {
    const complete = phase === 'durable'
      && typeof result !== 'number'
      && 'complete' in result
      && typeof result.complete === 'boolean'
        ? result.complete
        : undefined;
    const accounting = classifySyncResult(result, complete);
    madeProgress = madeProgress || accounting.madeProgress;
    sawDeniedPhase = sawDeniedPhase || accounting.denied;
    sawFailedPhase = sawFailedPhase || accounting.failed;
    sawBackoffWorthyFailure = sawBackoffWorthyFailure || accounting.backoffWorthyFailure;
    sawBackpressureDeferral = sawBackpressureDeferral || accounting.deferredByBackpressure;
    if (phase === 'durable') {
      sawDurableMetadataOnlyDetailedSync = sawDurableMetadataOnlyDetailedSync || accounting.metadataOnly;
      sawExplicitIncompleteDurableResult = sawExplicitIncompleteDurableResult || complete === false;
      // Safely committed prefixes are useful progress, but an explicit
      // incomplete durable result must not refresh the peer's successful-sync
      // timestamp and suppress the next recovery attempt. Legacy counter-only
      // results keep their existing behaviour when no completion verdict is
      // available.
      cleanDurableDetailedRound = cleanDurableDetailedRound || (
        complete !== false && accounting.cleanNonMetadataResponse
      );
    }
    return accounting;
  };
  const finishSyncAccounting = (): SyncOnConnectOutcome => {
    const cleanDurableRound = cleanDurableDetailedRound
      && !sawDurableMetadataOnlyDetailedSync
      && !sawExplicitIncompleteDurableResult;
    if (sawBackpressureDeferral) {
      if (madeProgress) {
        context.onPeerSynced?.(remotePeer, { fresh: false, progress: true });
      }
      return 'deferred-backpressure';
    }
    const clearsPeerBackoff = madeProgress || (!sawBackoffWorthyFailure && (cleanDurableRound || sawDeniedPhase));
    if (clearsPeerBackoff) {
      context.onPeerSynced?.(remotePeer, {
        fresh: !sawBackoffWorthyFailure && !sawDeniedPhase && !sawFailedPhase && cleanDurableRound,
        progress: madeProgress,
      });
    }
    return 'synced';
  };
  const runNonTransportStep = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (err) {
      throw new SyncOnConnectPostSyncError(remotePeer, err, { backoffEligible: false });
    }
  };
  type OrderedSyncPhase = Readonly<{
    kind: 'durable' | 'shared';
    label: string;
    contextGraphIds: readonly string[];
    /** Preserve the legacy initial probe/accounting call even for an empty scope. */
    runWhenEmpty?: boolean;
  }>;
  const runSyncPhase = async (
    phase: OrderedSyncPhase,
  ): Promise<SyncOnConnectOutcome | undefined> => {
    const contextGraphIds = [...new Set(phase.contextGraphIds)];
    if (contextGraphIds.length === 0 && phase.runWhenEmpty !== true) return undefined;
    const result = phase.kind === 'durable'
      ? await syncFromPeer(remotePeer, contextGraphIds)
      : await syncSharedMemoryFromPeer(remotePeer, contextGraphIds);
    const accounting = recordSyncAccounting(result, phase.kind);
    const dataLabel = phase.kind === 'durable' ? 'data' : 'shared memory';
    logInfo(
      ctx,
      `Synced ${accounting.insertedTriples} ${phase.label} ${dataLabel} triples from peer ${shortPeer}`,
    );
    if (accounting.deferredByBackpressure) {
      logInfo(
        ctx,
        `Stopping sync-on-connect fanout for peer ${shortPeer} after ${phase.label} ${phase.kind} admission deferral`,
      );
      return finishSyncAccounting();
    }
    if (accounting.backoffWorthyFailure) {
      logInfo(
        ctx,
        `Stopping sync-on-connect fanout for peer ${shortPeer} after ${phase.label} ${phase.kind} sync hit backoff-worthy pressure`,
      );
      return finishSyncAccounting();
    }
    if (phase.kind === 'durable') {
      await runNonTransportStep(() => refreshMetaSyncedFlags(contextGraphIds));
    }
    return undefined;
  };

  try {
    const protocols = await getPeerProtocols(remotePeer);

    if (protocols.includes(PROTOCOL_STORAGE_ACK)) {
      knownCorePeerIds.add(remotePeer);
    } else if (protocols.length > 0) {
      // #1093: only de-classify on a POPULATED protocol list. An empty
      // list means identify hasn't completed yet (the dominant race on
      // inbound connections) — evicting a previously-confirmed core here
      // would re-poison the ACK candidate pool that
      // `DKGAgent.getACKCandidatePeers` builds for the publisher.
      knownCorePeerIds.delete(remotePeer);
    }
    if (protocols.includes(PROTOCOL_STORAGE_ACK_V2)) {
      knownCorePeerIdsV2.add(remotePeer);
    } else if (protocols.length > 0) {
      knownCorePeerIdsV2.delete(remotePeer);
    }

    const hasSync = protocols.includes(PROTOCOL_SYNC);
    if (!hasSync) {
      logInfo(ctx, `Peer ${shortPeer} does not support sync protocol (protocols: ${protocols.join(', ')})`);
      context.onPeerSkippedNoSync?.(remotePeer, protocols);
      return 'skipped-no-sync';
    }

    const scopePlan = createScopePlan();
    const bootstrapContextGraphIds = [...new Set(scopePlan.initialBootstrapContextGraphIds)];
    const initialDurableContextGraphIds = [...new Set(scopePlan.initialDurableContextGraphIds)];
    const initialDurableSet = new Set(initialDurableContextGraphIds);
    const preBootstrapPublicContextGraphIds = [
      ...new Set(scopePlan.preBootstrapPublicContextGraphIds ?? []),
    ].filter((contextGraphId) => initialDurableSet.has(contextGraphId));
    const preBootstrapPublicSet = new Set(preBootstrapPublicContextGraphIds);
    const bootstrapAndConfiguredContextGraphIds = [...new Set([
      ...bootstrapContextGraphIds,
      ...initialDurableContextGraphIds.filter(
        (contextGraphId) => !preBootstrapPublicSet.has(contextGraphId),
      ),
    ])];
    logInfo(ctx, `Syncing from peer ${shortPeer}...`);
    const knownCgsBefore = new Set(initialDurableContextGraphIds);
    let completedPreBootstrapSharedMemoryIds: readonly string[] = [];

    if (preBootstrapPublicContextGraphIds.length > 0) {
      logInfo(
        ctx,
        `Prioritizing ${preBootstrapPublicContextGraphIds.length} bounded public context graph(s) before bootstrap backlog from ${shortPeer}`,
      );
      const priorityDurableOutcome = await runSyncPhase({
        kind: 'durable',
        label: 'priority public',
        contextGraphIds: preBootstrapPublicContextGraphIds,
      });
      if (priorityDurableOutcome) return priorityDurableOutcome;

      if (syncSharedMemoryOnConnect) {
        const prioritySharedMemoryContextGraphIds = getSharedMemorySyncContextGraphs
          ? await runNonTransportStep(() => Promise.resolve(
            getSharedMemorySyncContextGraphs(remotePeer, preBootstrapPublicContextGraphIds),
          ))
          : preBootstrapPublicContextGraphIds;
        const prioritySharedOutcome = await runSyncPhase({
          kind: 'shared',
          label: 'priority public',
          contextGraphIds: prioritySharedMemoryContextGraphIds,
        });
        if (prioritySharedOutcome) return prioritySharedOutcome;
        completedPreBootstrapSharedMemoryIds = prioritySharedMemoryContextGraphIds;
      }
    }

    const bootstrapOutcome = await runSyncPhase({
      kind: 'durable',
      label: 'bootstrap',
      contextGraphIds: bootstrapAndConfiguredContextGraphIds,
      runWhenEmpty: true,
    });
    if (bootstrapOutcome) return bootstrapOutcome;

    await runNonTransportStep(() => discoverContextGraphsFromStore());

    const allCgsAfter = scopePlan.contextGraphIdsAfterDiscovery();
    const newlyDiscovered = allCgsAfter.filter((id) => !knownCgsBefore.has(id));
    if (newlyDiscovered.length > 0) {
      logInfo(ctx, `Discovered ${newlyDiscovered.length} new CG(s) — syncing durable data from ${shortPeer}`);
      const discoveredOutcome = await runSyncPhase({
        kind: 'durable',
        label: 'discovered',
        contextGraphIds: newlyDiscovered,
      });
      if (discoveredOutcome) return discoveredOutcome;
    }

    durableSyncCompleted = true;
    const wsContextGraphIds = getSharedMemorySyncContextGraphs
      ? await runNonTransportStep(() => Promise.resolve(
        getSharedMemorySyncContextGraphs(remotePeer, allCgsAfter),
      ))
      : allCgsAfter;
    const completedPreBootstrapSharedMemory = new Set(
      completedPreBootstrapSharedMemoryIds,
    );
    const remainingWsContextGraphIds = wsContextGraphIds.filter(
      (contextGraphId) => !completedPreBootstrapSharedMemory.has(contextGraphId),
    );
    if (syncSharedMemoryOnConnect && remainingWsContextGraphIds.length > 0) {
      const remainingSharedOutcome = await runSyncPhase({
        kind: 'shared',
        label: 'remaining',
        contextGraphIds: remainingWsContextGraphIds,
      });
      if (remainingSharedOutcome) return remainingSharedOutcome;
    } else if (!syncSharedMemoryOnConnect && remainingWsContextGraphIds.length > 0) {
      logInfo(ctx, `Skipping shared memory sync from peer ${shortPeer} (syncSharedMemoryOnConnect=false)`);
    }

    return finishSyncAccounting();
  } catch (err) {
    if (err instanceof SyncOnConnectPostSyncError) {
      throw err;
    }
    if (durableSyncCompleted) {
      throw new SyncOnConnectPostSyncError(remotePeer, err, { backoffEligible: true });
    }
    throw err;
  } finally {
    syncingPeers.delete(remotePeer);
  }
}
