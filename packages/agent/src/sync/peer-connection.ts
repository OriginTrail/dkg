import type { Logger, OperationContext } from '@origintrail-official/dkg-core';
import type { PeerSyncConnection } from '../p2p/peer-connection.js';
import type { PeerSyncSession } from './peer-sync-session.js';

export interface PeerConnectionSyncPorts {
  readonly localPeerId: string;
  /** Canonical RFC-64 owner has already applied responsibility and authority policy. */
  listActiveCatalogReplayContextGraphIds(): readonly string[];
  markReplayPending(contextGraphId: string, remotePeer: string): void;
  clearReplayPending(contextGraphId: string, remotePeer: string): void;
  ensureAdmitted(remotePeer: string, ctx: OperationContext, signal: AbortSignal): Promise<boolean>;
  enrichPeerStore(connection: PeerSyncConnection): Promise<void>;
  drainPendingSenderKey(remotePeer: string, ctx: OperationContext): Promise<number>;
  reannounceCatalogHeads(remotePeer: string): Promise<unknown>;
  requestCatalogReplay(contextGraphId: string): Promise<{ failed: number }>;
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
  const replayContextGraphIds = ports.listActiveCatalogReplayContextGraphIds();
  for (const contextGraphId of replayContextGraphIds) {
    ports.markReplayPending(contextGraphId, remotePeer);
  }
  const releaseCleanup = session.onClose(() => {
    for (const contextGraphId of replayContextGraphIds) {
      ports.clearReplayPending(contextGraphId, remotePeer);
    }
  });
  try {
    let admitted = false;
    try {
      admitted = await session.step(() => ports.ensureAdmitted(remotePeer, ctx, signal));
    } catch (err: unknown) {
      signal.throwIfAborted();
      const message = err instanceof Error ? err.message : String(err);
      log.warn(ctx, `Network admission probe failed for ${remotePeer.slice(-8)} on connect: ${message}`);
      for (const contextGraphId of replayContextGraphIds) {
        ports.clearReplayPending(contextGraphId, remotePeer);
      }
      return;
    }
    if (!admitted) {
      for (const contextGraphId of replayContextGraphIds) {
        ports.clearReplayPending(contextGraphId, remotePeer);
      }
      return;
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
    // The receiver owns replay completeness. Provider-initiated pushes do
    // not carry a promised-head manifest and can otherwise leave a brief
    // A-applied/B-undiscovered window reporting complete. Request every
    // active CG through the completion-capable scoped protocol instead.
    // Keep the 10.0.15 rolling-upgrade direction alive: legacy receivers
    // cannot request V2 completion, but they can still consume ordinary
    // head announcements. Upgraded receivers remain fenced by the scoped
    // pull below and never interpret this compatibility push as complete.
    const reannouncement = ports.reannounceCatalogHeads(remotePeer).catch((err: unknown) => {
      session.commit(() => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(ctx, `RFC-64 compatibility re-announcement failed for ${remotePeer.slice(-8)}: ${message}`);
      });
    });
    const replays = replayContextGraphIds.map((contextGraphId) =>
      ports.requestCatalogReplay(contextGraphId).then((result) => {
        session.commit(() => {
          if (result.failed > 0) {
            log.warn(ctx, `RFC-64 catalog replay incomplete for "${contextGraphId}" after ${remotePeer.slice(-8)} connected`);
          }
        });
      }).catch((err: unknown) => {
        session.commit(() => {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(ctx, `RFC-64 catalog replay failed after ${remotePeer.slice(-8)} connected: ${message}`);
        });
      }),
    );
    session.commit(() => ports.queueSync(remotePeer, (peer, error) => session.commit(() => {
      log.warn(ctx, `Sync-on-connect failed for ${peer.slice(-8)}: ${error instanceof Error ? error.message : String(error)}`);
    })));
    // Catalog operations have their own runtime drain. Keep this connection's
    // pending-fence cleanup registered until those terminal promises settle.
    await session.step(() => Promise.all([reannouncement, ...replays]));
  } finally {
    releaseCleanup();
  }
}
