// SPDX-License-Identifier: Apache-2.0

/** Opaque lease that removes one exact pending replay generation. */
export interface Rfc64CatalogReplayConnectionFenceLeaseV1 {
  release(): void;
}

export interface Rfc64CatalogReplayConnectionRuntimePortsV1 {
  selectContextGraphIds(): readonly string[];
  acquireFence(
    contextGraphId: string,
    peerId: string,
  ): Rfc64CatalogReplayConnectionFenceLeaseV1 | null;
  reannounce(peerId: string): Promise<unknown>;
  replay(contextGraphId: string): Promise<Readonly<{ failed: number }>>;
  warn(message: string): void;
}

export interface Rfc64CatalogReplayConnectionReservationV1 {
  admit(): void;
  reject(): void;
}

interface DebounceEntryV1 {
  readonly startedAt: number;
  readonly token: object;
}

const DEFAULT_DEBOUNCE_MS = 60_000;
const DEFAULT_MAX_PEERS = 256;

/**
 * Owns the complete peer-connection replay transition. Preparing is
 * synchronous so graph completeness is fenced before admission awaits;
 * admitting starts compatibility and scoped replay; rejecting releases every
 * lease and the debounce token as one idempotent transition.
 */
export class Rfc64CatalogReplayConnectionRuntimeV1 {
  readonly #byPeer = new Map<string, DebounceEntryV1>();
  readonly #ports: Rfc64CatalogReplayConnectionRuntimePortsV1;
  readonly #debounceMs: number;
  readonly #maxPeers: number;

  constructor(
    ports: Rfc64CatalogReplayConnectionRuntimePortsV1,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    maxPeers = DEFAULT_MAX_PEERS,
  ) {
    this.#ports = ports;
    this.#debounceMs = debounceMs;
    this.#maxPeers = maxPeers;
  }

  prepare(
    peerId: string,
    nowMs = Date.now(),
  ): Rfc64CatalogReplayConnectionReservationV1 | null {
    const previous = this.#byPeer.get(peerId);
    if (previous !== undefined && nowMs - previous.startedAt < this.#debounceMs) return null;
    this.#byPeer.delete(peerId);
    while (this.#byPeer.size >= this.#maxPeers) {
      const oldestPeerId = this.#byPeer.keys().next().value as string | undefined;
      if (oldestPeerId === undefined) break;
      this.#byPeer.delete(oldestPeerId);
    }
    const token = Object.freeze({});
    this.#byPeer.set(peerId, Object.freeze({ startedAt: nowMs, token }));
    const contextGraphIds = [...new Set(this.#ports.selectContextGraphIds())].sort();
    if (contextGraphIds.length === 0) {
      if (this.#byPeer.get(peerId)?.token === token) this.#byPeer.delete(peerId);
      return null;
    }
    const leases = contextGraphIds.map((contextGraphId) =>
      this.#ports.acquireFence(contextGraphId, peerId));
    let settled = false;
    const release = (): void => {
      if (settled) return;
      settled = true;
      for (const lease of leases) lease?.release();
      if (this.#byPeer.get(peerId)?.token === token) this.#byPeer.delete(peerId);
    };
    return Object.freeze({
      reject: release,
      admit: () => {
        if (settled) return;
        settled = true;
        void this.#ports.reannounce(peerId).catch((error: unknown) => {
          this.#ports.warn(
            `RFC-64 compatibility re-announcement failed for ${peerId.slice(-8)}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
        for (const contextGraphId of contextGraphIds) {
          void this.#ports.replay(contextGraphId).then((result) => {
            if (result.failed > 0) {
              this.#ports.warn(
                `RFC-64 catalog replay incomplete for "${contextGraphId}" after ${peerId.slice(-8)} connected`,
              );
            }
          }).catch((error: unknown) => {
            this.#ports.warn(
              `RFC-64 catalog replay failed after ${peerId.slice(-8)} connected: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }
      },
    });
  }
}
