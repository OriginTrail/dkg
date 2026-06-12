import { createOperationContext, PROTOCOL_STORAGE_ACK, PROTOCOL_SYNC, SYSTEM_CONTEXT_GRAPHS, type OperationContext } from '@origintrail-official/dkg-core';

interface SyncProgressSummary {
  insertedTriples: number;
  completedPhases?: number;
  checkpointAdvances?: number;
  timedOutPhases?: number;
  failedPeers?: number;
  deniedPhases?: number;
}

type SyncFromPeerResult = number | SyncProgressSummary;

interface SyncOnConnectContext {
  remotePeer: string;
  syncingPeers: Set<string>;
  getPeerProtocols: (peerId: string) => Promise<string[]>;
  knownCorePeerIds: Set<string>;
  getSyncContextGraphs: () => string[];
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
   * denial-only clean response. `fresh=false` means progress was made but
   * the round also saw a timeout/failed phase, so peer backoff may be
   * cleared but freshness gates should still allow a near-term retry.
   */
  onPeerSynced?: (peerId: string, outcome?: { fresh: boolean }) => void;
}

export type SyncOnConnectOutcome = 'synced' | 'skipped-no-sync' | 'already-syncing';

export class SyncOnConnectPostSyncError extends Error {
  readonly originalError: unknown;
  readonly backoffEligible: boolean;

  constructor(remotePeer: string, originalError: unknown, options: { backoffEligible: boolean }) {
    const detail = originalError instanceof Error ? originalError.message : String(originalError);
    super(`post-sync step failed for peer ${remotePeer.slice(-8)}: ${detail}`);
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
  return (result.completedPhases ?? 0) > 0 || (result.checkpointAdvances ?? 0) > 0;
}

function hadBackoffWorthyFailure(result: SyncFromPeerResult): boolean {
  if (typeof result === 'number') return false;
  return (result.failedPeers ?? 0) > 0 || (result.timedOutPhases ?? 0) > 0;
}

function hadDeniedPhase(result: SyncFromPeerResult): boolean {
  if (typeof result === 'number') return false;
  return (result.deniedPhases ?? 0) > 0;
}

export async function runSyncOnConnect(context: SyncOnConnectContext): Promise<SyncOnConnectOutcome> {
  const {
    remotePeer,
    syncingPeers,
    getPeerProtocols,
    knownCorePeerIds,
    getSyncContextGraphs,
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
  let sawBackoffWorthyFailure = false;
  const recordSyncAccounting = (result: SyncFromPeerResult): void => {
    madeProgress = madeProgress || madeSyncProgress(result);
    sawDeniedPhase = sawDeniedPhase || hadDeniedPhase(result);
    sawBackoffWorthyFailure = sawBackoffWorthyFailure || hadBackoffWorthyFailure(result);
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
    } else {
      knownCorePeerIds.delete(remotePeer);
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
    recordSyncAccounting(synced);
    logInfo(ctx, `Synced ${insertedTriples(synced)} data triples from peer ${shortPeer}`);

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
      recordSyncAccounting(discoverSynced);
      logInfo(ctx, `Synced ${insertedTriples(discoverSynced)} durable triples for newly discovered CG(s) from ${shortPeer}`);
      await runNonTransportStep(() => refreshMetaSyncedFlags(newlyDiscovered));
    }

    durableSyncCompleted = true;
    const wsContextGraphIds = getSyncContextGraphs() ?? [];
    if (syncSharedMemoryOnConnect && wsContextGraphIds.length > 0) {
      const wsSynced = await syncSharedMemoryFromPeer(remotePeer, wsContextGraphIds);
      recordSyncAccounting(wsSynced);
      logInfo(ctx, `Synced ${insertedTriples(wsSynced)} shared memory triples from peer ${shortPeer}`);
    } else if (!syncSharedMemoryOnConnect && wsContextGraphIds.length > 0) {
      logInfo(ctx, `Skipping shared memory sync from peer ${shortPeer} (syncSharedMemoryOnConnect=false)`);
    }

    const clearsPeerBackoff = madeProgress || (sawDeniedPhase && !sawBackoffWorthyFailure);
    if (clearsPeerBackoff) {
      context.onPeerSynced?.(remotePeer, { fresh: !sawBackoffWorthyFailure });
    }
    return 'synced';
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
