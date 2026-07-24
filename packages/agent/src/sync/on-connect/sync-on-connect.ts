import { createOperationContext, PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_SYNC, SYSTEM_CONTEXT_GRAPHS, type OperationContext } from '@origintrail-official/dkg-core';
import {
  classifyDurableProgress,
  type DurableProgressSummary,
} from '../durable-progress.js';

type SyncProgressSummary = DurableProgressSummary & { insertedTriples: number };

type SyncFromPeerResult = number | SyncProgressSummary;

export interface SyncOnConnectPeerOutcome {
  fresh: boolean;
  progress?: boolean;
  /**
   * The round committed useful progress but also hit a transport/integrity
   * failure that should retain the ordinary per-peer retry backoff. Without
   * this signal, every transient connection:open clears the failure history
   * and immediately replays the full sync scope.
   */
  retryBackoff?: boolean;
}

interface SyncOnConnectContext {
  remotePeer: string;
  syncingPeers: Set<string>;
  getPeerProtocols: (peerId: string) => Promise<string[]>;
  knownCorePeerIds: Set<string>;
  knownCorePeerIdsV2?: Set<string>;
  getSyncContextGraphs: () => string[];
  getSharedMemorySyncContextGraphs?: (remotePeerId: string) => string[] | Promise<string[]>;
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

export async function runSyncOnConnect(context: SyncOnConnectContext): Promise<SyncOnConnectOutcome> {
  const {
    remotePeer,
    syncingPeers,
    getPeerProtocols,
    knownCorePeerIds,
    knownCorePeerIdsV2 = new Set<string>(),
    getSyncContextGraphs,
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
    const recordsPeerAccounting = madeProgress || (!sawBackoffWorthyFailure && (cleanDurableRound || sawDeniedPhase));
    if (recordsPeerAccounting) {
      context.onPeerSynced?.(remotePeer, {
        fresh: !sawBackoffWorthyFailure && !sawDeniedPhase && !sawFailedPhase && cleanDurableRound,
        progress: madeProgress,
        retryBackoff: sawBackoffWorthyFailure,
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

    logInfo(ctx, `Syncing from peer ${shortPeer}...`);
    const knownCgsBefore = new Set(getSyncContextGraphs() ?? []);
    const synced = await syncFromPeer(remotePeer);
    const syncedAccounting = recordSyncAccounting(synced, 'durable');
    logInfo(ctx, `Synced ${syncedAccounting.insertedTriples} data triples from peer ${shortPeer}`);
    if (syncedAccounting.deferredByBackpressure) {
      logInfo(ctx, `Stopping sync-on-connect fanout for peer ${shortPeer} after local admission deferral`);
      return finishSyncAccounting();
    }
    if (syncedAccounting.backoffWorthyFailure) {
      logInfo(ctx, `Stopping sync-on-connect fanout for peer ${shortPeer} after durable sync hit backoff-worthy pressure`);
      return finishSyncAccounting();
    }

    const syncScope = new Set<string>([
      SYSTEM_CONTEXT_GRAPHS.AGENTS,
      SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      ...(getSyncContextGraphs() ?? []),
    ]);
    await runNonTransportStep(() => refreshMetaSyncedFlags(syncScope));

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
      if (discoverAccounting.backoffWorthyFailure) {
        logInfo(ctx, `Stopping sync-on-connect fanout for peer ${shortPeer} after discovered-CG durable sync hit backoff-worthy pressure`);
        return finishSyncAccounting();
      }
      await runNonTransportStep(() => refreshMetaSyncedFlags(newlyDiscovered));
    }

    durableSyncCompleted = true;
    const wsContextGraphIds = getSharedMemorySyncContextGraphs
      ? await runNonTransportStep(() => Promise.resolve(getSharedMemorySyncContextGraphs(remotePeer)))
      : getSyncContextGraphs() ?? [];
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
