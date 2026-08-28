import { createOperationContext, PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_SYNC, SYSTEM_CONTEXT_GRAPHS, type OperationContext } from '@origintrail-official/dkg-core';
import {
  classifyDurableProgress,
} from '../durable-progress.js';
import {
  classifySharedMemoryFreshness,
  type SharedMemoryFreshnessSummary,
} from '../shared-memory-freshness.js';

type SyncProgressSummary = SharedMemoryFreshnessSummary & {
  insertedTriples: number;
};

type SyncFromPeerResult = number | SyncProgressSummary;

type DurableSyncFromPeerResult = number | (SyncProgressSummary & {
  readonly complete?: boolean;
});

interface SelectedSharedMemorySyncLane {
  /** Resolve the graph-complete SWM scope that must run before unrelated history. */
  getContextGraphIds: (remotePeerId: string) => string[] | Promise<string[]>;
  /** Produce the lane-owned terminal evidence for exactly that selected scope. */
  syncFromPeer: (
    peerId: string,
    contextGraphIds: string[],
  ) => Promise<SelectedSharedMemoryLaneResult>;
}

/** One normalized completion contract consumed by generic sync accounting. */
export interface SelectedSharedMemoryLaneResult {
  readonly kind: 'selected-shared-memory-lane';
  readonly shared: SyncProgressSummary;
  readonly scopeComplete: boolean;
}

type SyncAccountingResult = DurableSyncFromPeerResult | SelectedSharedMemoryLaneResult;

export interface SyncOnConnectPeerOutcome {
  fresh: boolean;
  progress?: boolean;
}

interface SyncOnConnectContext {
  remotePeer: string;
  syncingPeers: Set<string>;
  getPeerProtocols: (peerId: string) => Promise<string[]>;
  knownCorePeerIds: Set<string>;
  knownCorePeerIdsV2?: Set<string>;
  getSyncContextGraphs: () => string[];
  /** Exact durable scope for this automatic run; explicit catch-up bypasses it. */
  getDurableSyncContextGraphs?: () => string[];
  getSharedMemorySyncContextGraphs?: (remotePeerId: string) => string[] | Promise<string[]>;
  /** Cohesive selected lane; its scope resolver and typed producer cannot be mis-wired separately. */
  selectedSharedMemoryLane?: SelectedSharedMemorySyncLane;
  syncFromPeer: (peerId: string, contextGraphIds?: string[]) => Promise<DurableSyncFromPeerResult>;
  refreshMetaSyncedFlags: (contextGraphIds: Iterable<string>) => Promise<void>;
  discoverContextGraphsFromStore: () => Promise<number>;
  syncSharedMemoryFromPeer: (
    peerId: string,
    contextGraphIds: string[],
  ) => Promise<SyncFromPeerResult>;
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

/**
 * Narrow RFC-64 retry boundary. Unlike {@link SyncOnConnectContext}, this
 * shape cannot express durable, discovery, or ordinary shared-memory work, so
 * a selected retry cannot fall through when the broad on-connect workflow is
 * changed later.
 */
interface SelectedSharedMemoryRetryContext {
  remotePeer: string;
  syncingPeers: Set<string>;
  getPeerProtocols: (peerId: string) => Promise<string[]>;
  selectedSharedMemoryLane: SelectedSharedMemorySyncLane;
  logInfo: (ctx: OperationContext, message: string) => void;
  onPeerSkippedNoSync?: (peerId: string, protocols: string[]) => void;
  onPeerSynced?: (peerId: string, outcome?: SyncOnConnectPeerOutcome) => void;
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
  /**
   * The peer never answered at least one Context Graph's round
   * (`failedPeers`), as opposed to a round that failed after a response.
   * Only this — combined with zero progress — may stop the on-connect
   * fanout early; per-CG failures are isolated inside the sync itself.
   */
  peerUnreachable: boolean;
  denied: boolean;
  failed: boolean;
  deferredByBackpressure: boolean;
  metadataOnly: boolean;
  cleanNonMetadataResponse: boolean;
}

function classifySyncResult(
  result: SyncFromPeerResult,
  phase: 'durable' | 'shared',
  complete?: boolean,
): SyncResultAccounting {
  if (typeof result === 'number') {
    return {
      insertedTriples: result,
      madeProgress: true,
      backoffWorthyFailure: false,
      peerUnreachable: false,
      denied: false,
      failed: false,
      deferredByBackpressure: false,
      metadataOnly: false,
      cleanNonMetadataResponse: true,
    };
  }

  const progress = phase === 'shared'
    ? classifySharedMemoryFreshness(result, { complete })
    : classifyDurableProgress(result, { complete });
  // `failedPeers` is folded across every Context Graph in this lane. It says
  // at least one round never got a response; it does not mean the peer failed
  // to answer every round. Preserve any response evidence from sibling CGs so
  // one unreachable/poisoned CG cannot suppress discovery and SWM fanout from
  // a peer that demonstrably answered elsewhere.
  const peerRespondedInLane = progress.madeReconnectProgress
    || progress.denied
    || progress.phaseFailed
    || progress.integrityRejected
    || progress.timedOut
    || progress.hasMetadataEvidence
    || progress.hasVerifiedPrivateOnlyResponse;
  return {
    insertedTriples: result.insertedTriples,
    madeProgress: progress.madeReconnectProgress,
    backoffWorthyFailure: progress.backoffWorthyFailure,
    peerUnreachable: progress.transportFailed && !peerRespondedInLane,
    denied: progress.denied,
    failed: progress.phaseFailed || progress.integrityRejected,
    deferredByBackpressure: progress.deferredByBackpressure,
    metadataOnly: progress.metadataOnly,
    cleanNonMetadataResponse: progress.cleanNonMetadataResponse,
  };
}

/**
 * Retry exactly the selected RFC-64 SWM lane and nothing else. The generic
 * on-connect orchestrator still prioritizes selected SWM during a broad run,
 * but resumptions created by the catalog bootstrap use this dedicated entry
 * point so disabling broad sync does not disable selected recovery.
 */
export async function runSelectedSharedMemoryRetry(
  context: SelectedSharedMemoryRetryContext,
): Promise<SyncOnConnectOutcome> {
  const {
    remotePeer,
    syncingPeers,
    getPeerProtocols,
    selectedSharedMemoryLane,
    logInfo,
  } = context;
  const ctx = createOperationContext('sync');
  const shortPeer = remotePeer.slice(-8);

  if (syncingPeers.has(remotePeer)) return 'already-syncing';
  syncingPeers.add(remotePeer);

  const runNonTransportStep = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (err) {
      throw new SyncOnConnectPostSyncError(remotePeer, err, { backoffEligible: false });
    }
  };

  try {
    const protocols = await getPeerProtocols(remotePeer);
    if (!protocols.includes(PROTOCOL_SYNC)) {
      logInfo(
        ctx,
        `Peer ${shortPeer} does not support sync protocol (protocols: ${protocols.join(', ')})`,
      );
      context.onPeerSkippedNoSync?.(remotePeer, protocols);
      return 'skipped-no-sync';
    }

    const contextGraphIds = [...new Set(await runNonTransportStep(() => Promise.resolve(
      selectedSharedMemoryLane.getContextGraphIds(remotePeer),
    )))];
    if (contextGraphIds.length === 0) return 'synced';

    logInfo(
      ctx,
      `Retrying ${contextGraphIds.length} selected shared-memory Context Graph(s) from ${shortPeer}`,
    );
    const selected = await selectedSharedMemoryLane.syncFromPeer(remotePeer, contextGraphIds);
    const accounting = classifySyncResult(
      selected.shared,
      'shared',
      selected.scopeComplete,
    );
    logInfo(
      ctx,
      `Synced ${accounting.insertedTriples} selected shared memory triples from peer ${shortPeer}`,
    );

    if (accounting.deferredByBackpressure) {
      if (accounting.madeProgress) {
        context.onPeerSynced?.(remotePeer, { fresh: false, progress: true });
      }
      return 'deferred-backpressure';
    }

    // Selected completion clears this attempt's backoff, but never stamps the
    // whole peer fresh: durable and unrelated CG work were intentionally not
    // run. Explicit incomplete/no-progress remains silent so reconciler
    // accounting grows its bounded retry backoff.
    const selectedRetryResolved = selected.scopeComplete
      && !accounting.backoffWorthyFailure
      && !accounting.failed
      && !accounting.denied;
    if (accounting.madeProgress || accounting.denied || selectedRetryResolved) {
      context.onPeerSynced?.(remotePeer, {
        fresh: false,
        progress: accounting.madeProgress,
      });
    }
    return 'synced';
  } finally {
    syncingPeers.delete(remotePeer);
  }
}

export async function runSyncOnConnect(context: SyncOnConnectContext): Promise<SyncOnConnectOutcome> {
  const {
    remotePeer,
    syncingPeers,
    getPeerProtocols,
    knownCorePeerIds,
    knownCorePeerIdsV2 = new Set<string>(),
    getSyncContextGraphs,
    getDurableSyncContextGraphs,
    getSharedMemorySyncContextGraphs,
    selectedSharedMemoryLane,
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
  let sawExplicitIncompleteSharedResult = false;
  let cleanDurableDetailedRound = false;
  const recordSyncAccounting = (
    result: SyncAccountingResult,
    phase: 'durable' | 'shared',
  ): SyncResultAccounting => {
    const selectedResult = phase === 'shared'
      && typeof result !== 'number'
      && 'kind' in result
      && result.kind === 'selected-shared-memory-lane'
        ? result
        : undefined;
    const syncResult = (selectedResult?.shared ?? result) as SyncFromPeerResult;
    const complete = selectedResult !== undefined
      ? selectedResult.scopeComplete
      : (
      phase === 'durable'
      && typeof result !== 'number'
      && 'complete' in result
      && typeof result.complete === 'boolean'
        ? result.complete
        : undefined
      );
    const accounting = classifySyncResult(syncResult, phase, complete);
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
    } else {
      sawExplicitIncompleteSharedResult = sawExplicitIncompleteSharedResult
        || complete === false;
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
    const clearsPeerBackoff = madeProgress || (
      !sawBackoffWorthyFailure
      && !sawExplicitIncompleteSharedResult
      && (cleanDurableRound || sawDeniedPhase)
    );
    if (clearsPeerBackoff) {
      context.onPeerSynced?.(remotePeer, {
        fresh: !sawBackoffWorthyFailure
          && !sawDeniedPhase
          && !sawFailedPhase
          && !sawExplicitIncompleteSharedResult
          && cleanDurableRound,
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

    const prioritySharedMemoryContextGraphIds = syncSharedMemoryOnConnect
      && selectedSharedMemoryLane
        ? [...new Set(await runNonTransportStep(() => Promise.resolve(
          selectedSharedMemoryLane.getContextGraphIds(remotePeer),
        )))]
        : [];
    if (prioritySharedMemoryContextGraphIds.length > 0 && selectedSharedMemoryLane) {
      logInfo(
        ctx,
        `Prioritizing ${prioritySharedMemoryContextGraphIds.length} selected shared-memory Context Graph(s) from ${shortPeer}`,
      );
      const priorityWsSynced = await selectedSharedMemoryLane.syncFromPeer(
        remotePeer,
        prioritySharedMemoryContextGraphIds,
      );
      const prioritySharedAccounting = recordSyncAccounting(priorityWsSynced, 'shared');
      logInfo(
        ctx,
        `Synced ${prioritySharedAccounting.insertedTriples} priority shared memory triples from peer ${shortPeer}`,
      );
      if (prioritySharedAccounting.deferredByBackpressure) {
        logInfo(
          ctx,
          `Priority shared-memory sync from peer ${shortPeer} deferred by local admission pressure`,
        );
        return finishSyncAccounting();
      }
    }

    const durableContextGraphIds = getDurableSyncContextGraphs?.() ?? [
      SYSTEM_CONTEXT_GRAPHS.AGENTS,
      SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      ...(getSyncContextGraphs() ?? []),
    ];
    logInfo(ctx, `Syncing from peer ${shortPeer}...`);
    const knownCgsBefore = new Set(getSyncContextGraphs() ?? []);
    if (durableContextGraphIds.length > 0) {
      const synced = getDurableSyncContextGraphs
        ? await syncFromPeer(remotePeer, durableContextGraphIds)
        : await syncFromPeer(remotePeer);
      const syncedAccounting = recordSyncAccounting(synced, 'durable');
      logInfo(ctx, `Synced ${syncedAccounting.insertedTriples} data triples from peer ${shortPeer}`);
      if (syncedAccounting.deferredByBackpressure) {
        logInfo(ctx, `Stopping sync-on-connect fanout for peer ${shortPeer} after local admission deferral`);
        return finishSyncAccounting();
      }
      // A backoff-worthy per-CG failure must NOT stop the remaining lanes: the
      // failure is already recorded (the peer will not be stamped fresh), and
      // stopping here starves CG discovery and shared-memory sync of a peer
      // that is demonstrably reachable — the small-CG-behind-a-poison-transfer
      // starvation this accounting exists to prevent. Only a peer that never
      // answered any round and produced no progress stops the fanout, because
      // every later lane would just re-dial the same dead peer.
      if (syncedAccounting.peerUnreachable && !syncedAccounting.madeProgress) {
        logInfo(ctx, `Stopping sync-on-connect fanout for peer ${shortPeer}: durable sync could not reach the peer`);
        return finishSyncAccounting();
      }
      if (syncedAccounting.backoffWorthyFailure) {
        logInfo(ctx, `Durable sync from peer ${shortPeer} hit backoff-worthy pressure; continuing remaining sync-on-connect lanes`);
      }
    } else {
      // An empty automatic scope is a completed no-op. Stamp the peer fresh so
      // the reconciler does not repeatedly wake an Edge that selected no CGs.
      cleanDurableDetailedRound = true;
      logInfo(ctx, `Skipping automatic durable sync from ${shortPeer}: no Context Graphs are eligible`);
    }

    const syncScope = new Set<string>(durableContextGraphIds);
    if (syncScope.size > 0) {
      await runNonTransportStep(() => refreshMetaSyncedFlags(syncScope));
    }

    await runNonTransportStep(() => discoverContextGraphsFromStore());

    const allCgsAfter = getSyncContextGraphs() ?? [];
    const newlyDiscovered = allCgsAfter.filter((id) => !knownCgsBefore.has(id));
    if (newlyDiscovered.length > 0) {
      logInfo(ctx, `Discovered ${newlyDiscovered.length} new CG(s) — syncing durable data from ${shortPeer}`);
      const discoverSynced = await syncFromPeer(remotePeer, newlyDiscovered);
      const discoverAccounting = recordSyncAccounting(discoverSynced, 'durable');
      logInfo(ctx, `Synced ${discoverAccounting.insertedTriples} durable triples for newly discovered CG(s) from ${shortPeer}`);
      if (discoverAccounting.deferredByBackpressure) {
        logInfo(ctx, `Stopping sync-on-connect fanout for peer ${shortPeer} after discovered-CG admission deferral`);
        return finishSyncAccounting();
      }
      // Same policy as the primary durable leg: per-CG pressure continues,
      // only an unanswered round with no progress stops the fanout.
      if (discoverAccounting.peerUnreachable && !discoverAccounting.madeProgress) {
        logInfo(ctx, `Stopping sync-on-connect fanout for peer ${shortPeer}: discovered-CG durable sync could not reach the peer`);
        return finishSyncAccounting();
      }
      await runNonTransportStep(() => refreshMetaSyncedFlags(newlyDiscovered));
    }

    durableSyncCompleted = true;
    const allWsContextGraphIds = getSharedMemorySyncContextGraphs
      ? await runNonTransportStep(() => Promise.resolve(getSharedMemorySyncContextGraphs(remotePeer)))
      : getSyncContextGraphs() ?? [];
    const prioritySharedMemoryContextGraphIdSet = new Set(prioritySharedMemoryContextGraphIds);
    const wsContextGraphIds = allWsContextGraphIds.filter(
      (contextGraphId) => !prioritySharedMemoryContextGraphIdSet.has(contextGraphId),
    );
    if (syncSharedMemoryOnConnect && wsContextGraphIds.length > 0) {
      const wsSynced = await syncSharedMemoryFromPeer(remotePeer, wsContextGraphIds);
      const sharedAccounting = recordSyncAccounting(wsSynced, 'shared');
      logInfo(ctx, `Synced ${sharedAccounting.insertedTriples} shared memory triples from peer ${shortPeer}`);
      if (sharedAccounting.deferredByBackpressure) {
        logInfo(ctx, `Shared-memory sync from peer ${shortPeer} deferred by local admission pressure`);
      }
    } else if (!syncSharedMemoryOnConnect && wsContextGraphIds.length > 0) {
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
