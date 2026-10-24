// SPDX-License-Identifier: Apache-2.0

import type {
  Rfc64CatalogReplayPeerDemandV1,
  Rfc64CatalogReplayPeerFenceLeaseV1,
  Rfc64CatalogReplayRecoveryStatusV1,
} from './catalog-replay-recovery-runtime-v1.js';

/** What one replay run reports; every demand that joins the run gets this one object. */
export type Rfc64CatalogConnectionReplayResultV1 = Readonly<{ requested?: number; failed: number }>;

export interface Rfc64CatalogReplayConnectionRuntimePortsV1 {
  selectContextGraphIds(): readonly string[];
  acquireFence(
    contextGraphId: string,
    peerId: string,
  ): Rfc64CatalogReplayPeerFenceLeaseV1 | null;
  reannounce(peerId: string): Promise<unknown>;
  replay(
    contextGraphId: string,
    demand: Rfc64CatalogReplayPeerDemandV1,
  ): Promise<Rfc64CatalogConnectionReplayResultV1>;
  /**
   * The graph's replay status as its runs left it, or null when it has none
   * under the graph's accepted policy.
   */
  replayStatus(
    contextGraphId: string,
  ): Readonly<Pick<Rfc64CatalogReplayRecoveryStatusV1, 'failed' | 'unresolvedPeerCount'>> | null;
  log(level: 'warn' | 'debug', message: string): void;
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
  /** Runs already reported: one run answers every demand that joined it. */
  readonly #reportedRuns = new WeakSet<Rfc64CatalogConnectionReplayResultV1>();
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

  /** End debounce ownership only after the peer's final live connection closes. */
  peerDisconnected(peerId: string): void {
    this.#byPeer.delete(peerId);
  }

  reset(): void {
    this.#byPeer.clear();
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
    const replayDemands = contextGraphIds.flatMap((contextGraphId) => {
      const demand = this.#ports.acquireFence(contextGraphId, peerId);
      return demand === null ? [] : [{ contextGraphId, demand }];
    });
    let settled = false;
    const release = (): void => {
      if (settled) return;
      settled = true;
      for (const { demand } of replayDemands) demand.release();
      if (this.#byPeer.get(peerId)?.token === token) this.#byPeer.delete(peerId);
    };
    return Object.freeze({
      reject: release,
      admit: () => {
        if (settled) return;
        settled = true;
        void this.#ports.reannounce(peerId).catch((error: unknown) => {
          this.#ports.log(
            'warn',
            `RFC-64 compatibility re-announcement failed for ${peerId.slice(-8)}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
        for (const { contextGraphId, demand } of replayDemands) {
          void this.#ports.replay(contextGraphId, demand).then((result) => {
            if (result.failed > 0) this.#reportUnfinishedRun(contextGraphId, peerId, result);
          }).catch((error: unknown) => {
            this.#ports.log(
              'warn',
              `RFC-64 catalog replay failed after ${peerId.slice(-8)} connected: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }
      },
    });
  }

  /**
   * Say once per run what a replay that could not finish means. A warning is
   * kept for evidence that this node's catalog may lack heads its peers hold:
   * the graph's replay status then holds a full-replay witness (a promised
   * head this node has not applied, or a run that could not cover its peers).
   * Peers that could not be replayed from, because they were busy or did not
   * answer, or because this node's catalog service was not available, are
   * asked again by later replays and say nothing about this node's rows.
   */
  #reportUnfinishedRun(
    contextGraphId: string,
    peerId: string,
    result: Rfc64CatalogConnectionReplayResultV1,
  ): void {
    if (this.#reportedRuns.has(result)) return;
    this.#reportedRuns.add(result);
    const status = this.#ports.replayStatus(contextGraphId);
    const counts = `${result.requested ?? 0} peer(s) answered, ${result.failed} failed, ${
      status?.unresolvedPeerCount ?? 'unknown'
    } retried later`;
    if (status !== null && !status.failed) {
      this.#ports.log(
        'debug',
        `RFC-64 catalog replay for "${contextGraphId}" after ${peerId.slice(-8)} connected could not `
          + `replay from every peer (busy, no answer, or no local catalog service); later replays ask `
          + `again (${counts})`,
      );
      return;
    }
    this.#ports.log(
      'warn',
      `RFC-64 catalog replay incomplete for "${contextGraphId}" after ${peerId.slice(-8)} connected: ${
        status === null
          ? 'its replay status is not available'
          : 'this node may lack catalog heads its peers hold until a full replay passes'
      } (${counts})`,
    );
  }
}
