import { createOperationContext, PROTOCOL_STORAGE_ACK, PROTOCOL_SYNC, SYSTEM_CONTEXT_GRAPHS, type OperationContext } from '@origintrail-official/dkg-core';

interface SyncOnConnectContext {
  remotePeer: string;
  syncingPeers: Set<string>;
  getPeerProtocols: (peerId: string) => Promise<string[]>;
  knownCorePeerIds: Set<string>;
  getSyncContextGraphs: () => string[];
  syncFromPeer: (peerId: string, contextGraphIds?: string[]) => Promise<number>;
  refreshMetaSyncedFlags: (contextGraphIds: Iterable<string>) => Promise<void>;
  discoverContextGraphsFromStore: () => Promise<number>;
  syncSharedMemoryFromPeer: (peerId: string, contextGraphIds: string[]) => Promise<number>;
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
   * Optional. Called after a successful sync (durable + SWM, including
   * the newly-discovered-CGs second pass). The orchestrator stamps the
   * peer's `lastSuccessfulSyncAt` so the periodic reconciler can decide
   * whether the peer is overdue for another retry.
   */
  onPeerSynced?: (peerId: string) => void;
}

export async function runSyncOnConnect(context: SyncOnConnectContext): Promise<void> {
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

  if (syncingPeers.has(remotePeer)) return;
  syncingPeers.add(remotePeer);

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
      return;
    }

    logInfo(ctx, `Syncing from peer ${shortPeer}...`);
    const knownCgsBefore = new Set(getSyncContextGraphs() ?? []);
    const synced = await syncFromPeer(remotePeer);
    logInfo(ctx, `Synced ${synced} data triples from peer ${shortPeer}`);

    const syncScope = new Set<string>([
      SYSTEM_CONTEXT_GRAPHS.AGENTS,
      SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      ...(getSyncContextGraphs() ?? []),
    ]);
    await refreshMetaSyncedFlags(syncScope);

    await discoverContextGraphsFromStore();

    const allCgsAfter = getSyncContextGraphs() ?? [];
    const newlyDiscovered = allCgsAfter.filter((id) => !knownCgsBefore.has(id));
    if (newlyDiscovered.length > 0) {
      logInfo(ctx, `Discovered ${newlyDiscovered.length} new CG(s) — syncing durable data from ${shortPeer}`);
      const discoverSynced = await syncFromPeer(remotePeer, newlyDiscovered);
      logInfo(ctx, `Synced ${discoverSynced} durable triples for newly discovered CG(s) from ${shortPeer}`);
      await refreshMetaSyncedFlags(newlyDiscovered);
    }

    const wsContextGraphIds = getSyncContextGraphs() ?? [];
    if (syncSharedMemoryOnConnect && wsContextGraphIds.length > 0) {
      const wsSynced = await syncSharedMemoryFromPeer(remotePeer, wsContextGraphIds);
      logInfo(ctx, `Synced ${wsSynced} shared memory triples from peer ${shortPeer}`);
    } else if (!syncSharedMemoryOnConnect && wsContextGraphIds.length > 0) {
      logInfo(ctx, `Skipping shared memory sync from peer ${shortPeer} (syncSharedMemoryOnConnect=false)`);
    }

    context.onPeerSynced?.(remotePeer);
  } finally {
    syncingPeers.delete(remotePeer);
  }
}
