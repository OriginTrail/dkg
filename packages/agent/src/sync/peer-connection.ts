import type { Logger, OperationContext } from '@origintrail-official/dkg-core';
import type { PeerSyncConnection } from '../p2p/peer-connection.js';
import type { PeerSyncSession } from './peer-sync-session.js';

export interface PeerConnectionSyncPorts {
  readonly localPeerId: string;
  /** Reserve the catalog-owned replay transition before asynchronous admission. */
  prepareCatalogReplay(remotePeer: string): Readonly<{
    admit(): void;
    reject(): void;
  }> | null;
  ensureAdmitted(remotePeer: string, ctx: OperationContext, signal: AbortSignal): Promise<boolean>;
  enrichPeerStore(connection: PeerSyncConnection): Promise<void>;
  drainPendingSenderKey(remotePeer: string, ctx: OperationContext): Promise<number>;
  queueSync(remotePeer: string, onError: (peer: string, error: unknown) => void): boolean;
}

export interface PeerConnectionSyncContext {
  ports: PeerConnectionSyncPorts;
  session: PeerSyncSession;
  ctx: OperationContext;
  log: Pick<Logger, 'info' | 'warn'>;
}

/** Connection policy belongs to sync; the generic lifetime owns only supervision. */
export async function syncOpenedPeerConnection(
  context: PeerConnectionSyncContext,
  connection: PeerSyncConnection,
): Promise<void> {
  const { ports, session, ctx, log } = context;
  const { signal } = session;
  signal.throwIfAborted();
  const remotePeer = connection.remotePeer.toString();
  if (remotePeer === ports.localPeerId) return;
  const catalogReplay = ports.prepareCatalogReplay(remotePeer);
  let catalogReplaySettled = catalogReplay === null;
  const rejectCatalogReplay = (): void => {
    if (catalogReplaySettled || catalogReplay === null) return;
    catalogReplaySettled = true;
    catalogReplay.reject();
  };
  const releaseCleanup = session.onClose(rejectCatalogReplay);
  try {
    let admitted = false;
    try {
      admitted = await session.step(() => ports.ensureAdmitted(remotePeer, ctx, signal));
    } catch (err: unknown) {
      signal.throwIfAborted();
      const message = err instanceof Error ? err.message : String(err);
      log.warn(ctx, `Network admission probe failed for ${remotePeer.slice(-8)} on connect: ${message}`);
      rejectCatalogReplay();
      return;
    }
    if (!admitted) {
      rejectCatalogReplay();
      return;
    }
    signal.throwIfAborted();
    // Network admission is the only prerequisite for catalog replay. Settle
    // the reservation before unrelated best-effort connection maintenance so
    // a stalled enrichment or sender-key drain cannot suppress completeness.
    if (catalogReplay !== null) {
      catalogReplay.admit();
      catalogReplaySettled = true;
    }
    try {
      await session.step(() => ports.enrichPeerStore(connection));
    } catch (err: unknown) {
      signal.throwIfAborted();
      const message = err instanceof Error ? err.message : String(err);
      log.warn(ctx, `Reverse-path peerStore enrichment failed for ${remotePeer}: ${message}`);
    }
    signal.throwIfAborted();
    // PR-2 (SWM-fanout plan): drain pending sender-key packages
    // that were queued because the recipient had no advertised
    // peerId at publish time. Tolerant of profile-lookup failure
    // (the next connection:open will retry).
    try {
      const drained = await session.step(() => ports.drainPendingSenderKey(remotePeer, ctx));
      if (drained > 0) {
        log.info(ctx, `Drained ${drained} pending SWM sender-key package(s) for ${remotePeer}`);
      }
    } catch (err: unknown) {
      signal.throwIfAborted();
      const message = err instanceof Error ? err.message : String(err);
      log.warn(ctx, `Pending SWM sender-key drain on connect failed for ${remotePeer}: ${message}`);
    }
    session.commit(() => ports.queueSync(remotePeer, (peer, error) => session.commit(() => {
      log.warn(ctx, `Sync-on-connect failed for ${peer.slice(-8)}: ${error instanceof Error ? error.message : String(error)}`);
    })));
  } finally {
    releaseCleanup();
    rejectCatalogReplay();
  }
}
