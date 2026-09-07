export interface PeerSyncConnection {
  direction: 'inbound' | 'outbound';
  remoteAddr?: { toString(): string };
  remotePeer: { toString(): string };
}

export interface PeerConnectionPorts {
  localPeerId(): string;
  replayContextGraphIds(): readonly string[];
  markReplayPending(contextGraphId: string, peerId: string): void;
  clearReplayPending(contextGraphId: string, peerId: string): void;
  ensureAdmitted(peerId: string, signal: AbortSignal): Promise<boolean>;
  enrich(connection: PeerSyncConnection): Promise<void>;
  drainSenderKeys(peerId: string): Promise<number>;
  reannounce(peerId: string): Promise<unknown>;
  requestReplays(contextGraphId: string): Promise<{ failed: number }>;
  queueSync(peerId: string, onError: (peerId: string, error: unknown) => void): boolean;
  retireSyncState(): void;
  log: { info(message: string): void; warn(message: string): void };
}

/**
 * Owns connection-open ordering and the continuation fence for one node lifetime.
 * close() removes listeners, cancels queued sync and prevents late bookkeeping.
 * It does not claim physical task draining: admission, transport, sender-key and
 * catalog operations retain their subsystem-owned shutdown/drain contracts.
 */
export class PeerConnectionCoordinator {
  private readonly controller = new AbortController();
  private readonly cleanups = new Set<() => void>();
  readonly signal = this.controller.signal;

  constructor(private readonly ports: PeerConnectionPorts) {}

  close(): void {
    if (this.signal.aborted) return;
    this.controller.abort();
    this.ports.retireSyncState();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.clear();
  }

  onClose(cleanup: () => void): () => void {
    if (this.signal.aborted) { cleanup(); return () => {}; }
    this.cleanups.add(cleanup);
    return () => { this.cleanups.delete(cleanup); };
  }

  /** Cooperative continuation fencing; physical operations are owned by ports. */
  run(work: (signal: AbortSignal) => Promise<void>, onError: (error: unknown) => void): void {
    if (this.signal.aborted) return;
    void work(this.signal).catch((error: unknown) => {
      if (!this.signal.aborted) onError(error);
    });
  }

  connectionOpened(connection: PeerSyncConnection): void {
    this.run(() => this.runConnection(connection), (error) => this.ports.log.warn(
      `Sync-on-connect failed for ${connection.remotePeer.toString().slice(-8)}: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }

  private async runConnection(connection: PeerSyncConnection): Promise<void> {
    const { signal } = this;
    signal.throwIfAborted();
    const remotePeer = connection.remotePeer.toString();
    if (remotePeer === this.ports.localPeerId()) return;
    const replayContextGraphIds = this.ports.replayContextGraphIds();
    for (const contextGraphId of replayContextGraphIds) {
      this.ports.markReplayPending(contextGraphId, remotePeer);
    }
    const releaseCleanup = this.onClose(() => {
      for (const contextGraphId of replayContextGraphIds) {
        this.ports.clearReplayPending(contextGraphId, remotePeer);
      }
    });
    try {
      let admitted = false;
      try {
        admitted = await this.ports.ensureAdmitted(remotePeer, signal);
      } catch (err: unknown) {
        signal.throwIfAborted();
        const message = err instanceof Error ? err.message : String(err);
        this.ports.log.warn(`Network admission probe failed for ${remotePeer.slice(-8)} on connect: ${message}`);
        for (const contextGraphId of replayContextGraphIds) {
          this.ports.clearReplayPending(contextGraphId, remotePeer);
        }
        return;
      }
      signal.throwIfAborted();
      if (!admitted) {
        for (const contextGraphId of replayContextGraphIds) {
          this.ports.clearReplayPending(contextGraphId, remotePeer);
        }
        return;
      }
      try {
        await this.ports.enrich(connection);
      } catch (err: unknown) {
        signal.throwIfAborted();
        const message = err instanceof Error ? err.message : String(err);
        this.ports.log.warn(`Reverse-path peerStore enrichment failed for ${remotePeer}: ${message}`);
      }
      signal.throwIfAborted();
      // PR-2 (SWM-fanout plan): drain pending sender-key packages
      // that were queued because the recipient had no advertised
      // peerId at publish time. Tolerant of profile-lookup failure
      // (the next connection:open will retry).
      try {
        const drained = await this.ports.drainSenderKeys(remotePeer);
        signal.throwIfAborted();
        if (drained > 0) {
          this.ports.log.info(`Drained ${drained} pending SWM sender-key package(s) for ${remotePeer}`);
        }
      } catch (err: unknown) {
        signal.throwIfAborted();
        const message = err instanceof Error ? err.message : String(err);
        this.ports.log.warn(`Pending SWM sender-key drain on connect failed for ${remotePeer}: ${message}`);
      }
      signal.throwIfAborted();
      // The receiver owns replay completeness. Provider-initiated pushes do
      // not carry a promised-head manifest and can otherwise leave a brief
      // A-applied/B-undiscovered window reporting complete. Request every
      // active CG through the completion-capable scoped protocol instead.
      // Keep the 10.0.15 rolling-upgrade direction alive: legacy receivers
      // cannot request V2 completion, but they can still consume ordinary
      // head announcements. Upgraded receivers remain fenced by the scoped
      // pull below and never interpret this compatibility push as complete.
      const reannouncement = this.ports.reannounce(remotePeer).catch((err: unknown) => {
        if (signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        this.ports.log.warn(`RFC-64 compatibility re-announcement failed for ${remotePeer.slice(-8)}: ${message}`);
      });
      const replays = replayContextGraphIds.map((contextGraphId) =>
        this.ports.requestReplays(contextGraphId).then((result) => {
          if (signal.aborted) return;
          if (result.failed > 0) {
            this.ports.log.warn(`RFC-64 catalog replay incomplete for "${contextGraphId}" after ${remotePeer.slice(-8)} connected`);
          }
        }).catch((err: unknown) => {
          if (signal.aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          this.ports.log.warn(`RFC-64 catalog replay failed after ${remotePeer.slice(-8)} connected: ${message}`);
        }),
      );
      this.ports.queueSync(remotePeer, (peer, error) => {
        this.ports.log.warn(`Sync-on-connect failed for ${peer.slice(-8)}: ${error instanceof Error ? error.message : String(error)}`);
      });
      // Catalog operations have their own runtime drain. Keep this connection's
      // pending-fence cleanup registered until those terminal promises settle.
      await Promise.all([reannouncement, ...replays]);
    } finally {
      releaseCleanup();
    }
  }
}
