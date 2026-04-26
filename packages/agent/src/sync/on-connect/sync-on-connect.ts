import { createOperationContext, PROTOCOL_STORAGE_ACK, PROTOCOL_SYNC, SYSTEM_PARANETS, type OperationContext } from '@origintrail-official/dkg-core';

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
  logInfo: (ctx: OperationContext, message: string) => void;
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
      return;
    }

    logInfo(ctx, `Syncing from peer ${shortPeer}...`);
    const knownCgsBefore = new Set(getSyncContextGraphs() ?? []);
    const synced = await syncFromPeer(remotePeer);
    logInfo(ctx, `Synced ${synced} data triples from peer ${shortPeer}`);

    const syncScope = new Set<string>([
      SYSTEM_PARANETS.AGENTS,
      SYSTEM_PARANETS.ONTOLOGY,
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
    if (wsContextGraphIds.length > 0) {
      const wsSynced = await syncSharedMemoryFromPeer(remotePeer, wsContextGraphIds);
      logInfo(ctx, `Synced ${wsSynced} shared memory triples from peer ${shortPeer}`);
    }
  } finally {
    syncingPeers.delete(remotePeer);
  }
}
