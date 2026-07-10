import { createOperationContext, PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_SYNC, SYSTEM_CONTEXT_GRAPHS, type OperationContext } from '@origintrail-official/dkg-core';

interface SyncProgressSummary {
  insertedTriples: number;
  insertedDataTriples?: number;
  insertedMetaTriples?: number;
  metaOnlyResponses?: number;
  completedPhases?: number;
  checkpointAdvances?: number;
  timedOutPhases?: number;
  failedPeers?: number;
  failedPhases?: number;
  deniedPhases?: number;
  backoffWorthyFailures?: number;
}

type SyncFromPeerResult = number | SyncProgressSummary;

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

export type SyncOnConnectOutcome = 'synced' | 'skipped-no-sync' | 'already-syncing';

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

function insertedTriples(result: SyncFromPeerResult): number {
  return typeof result === 'number' ? result : result.insertedTriples;
}

function madeSyncProgress(result: SyncFromPeerResult): boolean {
  if (typeof result === 'number') return true;
  const phaseProgress = !metadataOnlySync(result) && (
    (result.completedPhases ?? 0) > 0 ||
    (result.checkpointAdvances ?? 0) > 0
  );
  return insertedDataTriplesForProgress(result) > 0
    || phaseProgress;
}

function hadBackoffWorthyFailure(result: SyncFromPeerResult): boolean {
  if (typeof result === 'number') return false;
  return (
    (result.backoffWorthyFailures ?? 0) > 0 ||
    (result.failedPeers ?? 0) > 0 ||
    (result.timedOutPhases ?? 0) > 0
  );
}

function hadDeniedPhase(result: SyncFromPeerResult): boolean {
  if (typeof result === 'number') return false;
  return (result.deniedPhases ?? 0) > 0;
}

function hadFailedPhase(result: SyncFromPeerResult): boolean {
  if (typeof result === 'number') return false;
  return (result.failedPhases ?? 0) > 0;
}

function cleanDetailedSync(result: SyncFromPeerResult): boolean {
  if (typeof result === 'number') return true;
  return (
    (result.failedPeers ?? 0) === 0 &&
    (result.failedPhases ?? 0) === 0 &&
    (result.timedOutPhases ?? 0) === 0 &&
    (result.deniedPhases ?? 0) === 0 &&
    !metadataOnlySync(result)
  );
}

function insertedDataTriplesForProgress(result: SyncProgressSummary): number {
  if (result.insertedDataTriples !== undefined) return result.insertedDataTriples;
  return metadataOnlySync(result) ? 0 : result.insertedTriples;
}

function metadataOnlySync(result: SyncProgressSummary): boolean {
  const insertedDataTriples = result.insertedDataTriples ?? 0;
  return insertedDataTriples === 0 && (
    (result.metaOnlyResponses ?? 0) > 0 ||
    ((result.insertedMetaTriples ?? 0) > 0 && result.insertedTriples > 0)
  );
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
  let sawDurableMetadataOnlyDetailedSync = false;
  let cleanDurableDetailedRound = false;
  const recordSyncAccounting = (result: SyncFromPeerResult, phase: 'durable' | 'shared'): void => {
    madeProgress = madeProgress || madeSyncProgress(result);
    sawDeniedPhase = sawDeniedPhase || hadDeniedPhase(result);
    sawFailedPhase = sawFailedPhase || hadFailedPhase(result);
    sawBackoffWorthyFailure = sawBackoffWorthyFailure || hadBackoffWorthyFailure(result);
    if (phase === 'durable') {
      sawDurableMetadataOnlyDetailedSync = sawDurableMetadataOnlyDetailedSync || (typeof result !== 'number' && metadataOnlySync(result));
      cleanDurableDetailedRound = cleanDurableDetailedRound || cleanDetailedSync(result);
    }
  };
  const finishSyncAccounting = (): SyncOnConnectOutcome => {
    const cleanDurableRound = cleanDurableDetailedRound && !sawDurableMetadataOnlyDetailedSync;
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
    recordSyncAccounting(synced, 'durable');
    logInfo(ctx, `Synced ${insertedTriples(synced)} data triples from peer ${shortPeer}`);
    if (hadBackoffWorthyFailure(synced)) {
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
      recordSyncAccounting(discoverSynced, 'durable');
      logInfo(ctx, `Synced ${insertedTriples(discoverSynced)} durable triples for newly discovered CG(s) from ${shortPeer}`);
      if (hadBackoffWorthyFailure(discoverSynced)) {
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
      recordSyncAccounting(wsSynced, 'shared');
      logInfo(ctx, `Synced ${insertedTriples(wsSynced)} shared memory triples from peer ${shortPeer}`);
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
