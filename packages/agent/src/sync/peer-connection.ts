import type { Logger, OperationContext } from '@origintrail-official/dkg-core';
import type { PeerSyncConnection } from '../p2p/peer-connection.js';
import { NetworkAdmissionProbeError } from '../p2p/network-admission-coordinator.js';
import type { PeerSyncSession } from './peer-sync-session.js';

export interface PeerConnectionSyncPorts {
  readonly localPeerId: string;
  /**
   * Whether `connection` is a second circuit to an admitted peer
   * ({@link isRedundantLimitedConnection}): it only records its way back.
   */
  isRedundantConnection(connection: PeerSyncConnection): boolean;
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

/** The parts of a libp2p connection {@link isRedundantLimitedConnection} reads. */
export interface OpenedConnectionView {
  readonly id?: string;
  readonly status?: string;
  readonly limits?: unknown;
}

/**
 * A limited connection to a peer that already holds another open connection
 * adds no route: it is a second circuit, mostly a dial that libp2p aborts at
 * once as a duplicate of the open one, or a parallel path through another
 * relay. Once the peer is admitted, admission, the catalog replay and
 * sync-on-connect have run for it; running them again for each such circuit
 * would start another round of them, at both ends, for every request to a
 * relay-only peer. A peer that is not admitted gets them again, so a failed
 * attempt is retried. The circuit's way back through its relay is recorded
 * either way.
 */
export function isRedundantLimitedConnection(
  connection: OpenedConnectionView,
  peerConnections: readonly OpenedConnectionView[],
): boolean {
  if (connection.limits == null) return false;
  return peerConnections.some((other) => other !== connection
    && (other.id === undefined || other.id !== connection.id)
    && (other.status === undefined || other.status === 'open'));
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
  if (ports.isRedundantConnection(connection)) {
    await enrichPeerStore(context, connection, remotePeer);
    return;
  }
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
      // The coordinator logs a failed probe itself, once, with the reason and
      // the backoff it starts (see NetworkAdmissionProbeError). Logging the
      // error again here ran once per connection callback, including every
      // reconnect skipped inside that backoff, which made this the hottest
      // network-churn warning (GH#1578). Any other failure has no owner that
      // reports it, so it is still logged here.
      if (!(err instanceof NetworkAdmissionProbeError)) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(ctx, `Network admission probe failed for ${remotePeer.slice(-8)} on connect: ${message}`);
      }
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
    await enrichPeerStore(context, connection, remotePeer);
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

/**
 * Remember when the last live connection to a peer is gone. A3 keeps
 * `lastSuccessfulSyncAt` and reconciler backoff across relay flaps, but
 * the next `connection:open` must not suppress catch-up using a sync
 * timestamp from before an offline gap. `lastSyncDisconnectedAt` is the
 * boundary that distinguishes stale pre-disconnect success from a fresh
 * sync in the current live session. Catalog replay uses the same boundary.
 */
export function syncClosedPeerConnection(input: Readonly<{
  remotePeer: string;
  localPeerId: string;
  connectedPeers: readonly { toString(): string }[];
  onLastConnectionClosed(remotePeer: string): void;
}>): void {
  if (input.remotePeer === input.localPeerId
    || input.connectedPeers.some(peer => peer.toString() === input.remotePeer)) return;
  input.onLastConnectionClosed(input.remotePeer);
}

/** Record the connection's way back through its relay; best-effort, so a failure is only logged. */
async function enrichPeerStore(
  { ports, session, ctx, log }: PeerConnectionSyncContext,
  connection: PeerSyncConnection,
  remotePeer: string,
): Promise<void> {
  try {
    await session.step(() => ports.enrichPeerStore(connection));
  } catch (err: unknown) {
    session.signal.throwIfAborted();
    const message = err instanceof Error ? err.message : String(err);
    log.warn(ctx, `Reverse-path peerStore enrichment failed for ${remotePeer}: ${message}`);
  }
}
