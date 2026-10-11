// SPDX-License-Identifier: Apache-2.0

import type {
  Rfc64CatalogReplayRecoveryCommandV1,
  Rfc64CatalogReplayPeerDemandV1,
  Rfc64CatalogReplayPeerFenceLeaseV1,
} from './catalog-replay-recovery-runtime-v1.js';

export interface Rfc64CatalogReplayConnectionRuntimePortsV1 {
  selectContextGraphIds(): readonly string[];
  acquireFence(contextGraphId: string, peerId: string): Rfc64CatalogReplayPeerFenceLeaseV1 | null;
  reannounce(peerId: string, contextGraphId: string, signal: AbortSignal): Promise<unknown>;
  replay(contextGraphId: string, demand: Rfc64CatalogReplayPeerDemandV1,
    signal: AbortSignal): Promise<Readonly<{ failed: number }>>;
  /** Production schedules through the agent's abortable background owner. */
  schedule?(work: (signal: AbortSignal) => Promise<void>): boolean;
  warn(message: string): void;
}

export interface Rfc64CatalogReplayConnectionReservationV1 {
  admit(): void;
  reject(): void;
}

interface ScopeV1 {
  readonly contextGraphId: string;
  demand: Rfc64CatalogReplayPeerFenceLeaseV1 | null;
  admitted: boolean;
  failures: number;
  eligibleAt: number;
}

interface PeerV1 {
  readonly peerId: string;
  readonly scopes: Map<string, ScopeV1>;
  active: boolean;
  lastUsedAt: number;
  started: number;
  failed: number;
  windowStartedAt: number;
  windowStarted: number;
  selectionOffset: number;
}

const DEFAULT_DEBOUNCE_MS = 60_000;
const DEFAULT_MAX_PEERS = 256;
const MAX_SCOPES_PER_PEER = 256;
const MAX_ACTIVE_PEERS = 2;
const MAX_SCOPES_PER_TURN = 8;
const MAX_BACKOFF_MS = 10 * 60_000;

/** Stable peer/scope jitter cannot be reset by repeatedly reconnecting. */
function retryDelay(peerId: string, scope: ScopeV1, debounceMs: number): number {
  let hash = 0;
  for (const character of `${peerId}\0${scope.contextGraphId}`) {
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  }
  const base = Math.min(MAX_BACKOFF_MS, debounceMs * 2 ** Math.min(scope.failures - 1, 8));
  return Math.min(MAX_BACKOFF_MS, base + Math.floor(base * ((hash % 251) / 1000)));
}

/**
 * Owns reconnect replay admission, retained cooldowns and bounded physical work.
 * Completeness fences are acquired synchronously before network admission. Each
 * peer has one serial stream owner; at most two peers run on the node. Short
 * disconnects retain scope backoff, while bounded turns allow other peers to
 * progress. A new graph activation adds only that graph, even during a pass.
 */
export class Rfc64CatalogReplayConnectionRuntimeV1 {
  readonly #byPeer = new Map<string, PeerV1>();
  readonly #ports: Rfc64CatalogReplayConnectionRuntimePortsV1;
  readonly #debounceMs: number;
  readonly #maxPeers: number;
  #scheduled = false;
  #closed = false;
  #suppressed = 0;
  #wake: (() => void) | undefined;

  constructor(ports: Rfc64CatalogReplayConnectionRuntimePortsV1,
    debounceMs = DEFAULT_DEBOUNCE_MS, maxPeers = DEFAULT_MAX_PEERS) {
    this.#ports = ports;
    this.#debounceMs = debounceMs;
    this.#maxPeers = maxPeers;
  }

  /** Transport retirement does not erase replay-rate or failure history. */
  peerDisconnected(_peerId: string): void {}

  /** Called only after the lifecycle background owner has physically drained. */
  reset(): void {
    for (const peer of this.#byPeer.values()) {
      for (const scope of peer.scopes.values()) {
        scope.demand?.release();
        scope.demand = null;
      }
    }
    this.#byPeer.clear();
  }

  status(): Readonly<{
    activePeers: number; pendingScopes: number; suppressed: number;
    peers: readonly Readonly<{ peerIdSuffix: string; started: number; failed: number;
      startedLastMinute: number; nextEligibleAt: number }>[];
  }> {
    const now = Date.now();
    return Object.freeze({
      activePeers: [...this.#byPeer.values()].filter(peer => peer.active).length,
      pendingScopes: [...this.#byPeer.values()].reduce((count, peer) => count
        + [...peer.scopes.values()].filter(scope => scope.demand !== null).length, 0),
      suppressed: this.#suppressed,
      peers: Object.freeze([...this.#byPeer.values()].map(peer => Object.freeze({
        peerIdSuffix: peer.peerId.slice(-8), started: peer.started, failed: peer.failed,
        startedLastMinute: now - peer.windowStartedAt < 60_000 ? peer.windowStarted : 0,
        nextEligibleAt: Math.min(...[...peer.scopes.values()].map(scope => scope.eligibleAt)),
      }))),
    });
  }

  prepare(peerId: string, nowMs = Date.now(), contextGraphId?: string):
  Rfc64CatalogReplayConnectionReservationV1 | null {
    if (this.#closed) return null;
    const selected = contextGraphId === undefined
      ? [...new Set(this.#ports.selectContextGraphIds())].sort() : [contextGraphId];
    if (selected.length === 0) return null;
    let peer = this.#byPeer.get(peerId);
    if (peer === undefined) {
      if (this.#byPeer.size >= this.#maxPeers) {
        const idle = [...this.#byPeer.values()].filter(candidate => !candidate.active
          && ![...candidate.scopes.values()].some(scope => scope.demand !== null))
          .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
        if (idle === undefined) { this.#suppressed++; return null; }
        this.#byPeer.delete(idle.peerId);
      }
      peer = { peerId, scopes: new Map(), active: false, lastUsedAt: nowMs,
        started: 0, failed: 0, windowStartedAt: nowMs, windowStarted: 0, selectionOffset: 0 };
      this.#byPeer.set(peerId, peer);
    }
    peer.lastUsedAt = nowMs;
    const reservations: ScopeV1[] = [];
    let firstDeferred: number | undefined;
    const offset = contextGraphId === undefined ? peer.selectionOffset % selected.length : 0;
    for (let index = 0; index < selected.length; index++) {
      const selectedIndex = (offset + index) % selected.length;
      const id = selected[selectedIndex];
      let scope = peer.scopes.get(id);
      if (scope === undefined) {
        if (peer.scopes.size >= MAX_SCOPES_PER_PEER) {
          const idle = [...peer.scopes.values()].find(candidate => candidate.demand === null
            && candidate.eligibleAt <= nowMs);
          if (idle === undefined) { firstDeferred ??= selectedIndex; continue; }
          peer.scopes.delete(idle.contextGraphId);
        }
        scope = { contextGraphId: id, demand: null, admitted: false, failures: 0, eligibleAt: 0 };
        peer.scopes.set(id, scope);
      }
      if (scope.demand !== null || scope.eligibleAt > nowMs) { this.#suppressed++; continue; }
      const demand = this.#ports.acquireFence(id, peerId);
      if (demand === null) continue;
      scope.demand = demand;
      reservations.push(scope);
    }
    if (contextGraphId === undefined) peer.selectionOffset = firstDeferred ?? 0;
    if (reservations.length === 0) return null;
    let settled = false;
    return Object.freeze({
      reject: () => {
        if (settled) return;
        settled = true;
        for (const scope of reservations) {
          scope.demand?.release();
          scope.demand = null;
        }
      },
      admit: () => {
        if (settled) return;
        settled = true;
        if (this.#closed) {
          for (const scope of reservations) scope.demand?.release();
          return;
        }
        for (const scope of reservations) scope.admitted = true;
        this.#schedule();
      },
    });
  }


  #schedule(): void {
    if (this.#closed) return;
    if (this.#scheduled) { this.#wake?.(); return; }
    this.#scheduled = true;
    const work = async (signal: AbortSignal): Promise<void> => {
      const runs = new Set<Promise<void>>();
      const wake = (): void => { this.#wake?.(); };
      signal.addEventListener('abort', wake, { once: true });
      try {
        while (!signal.aborted && !this.#closed) {
          const peers = [...this.#byPeer.values()].filter(peer => !peer.active
            && [...peer.scopes.values()].some(scope => scope.admitted && scope.demand !== null))
            .slice(0, MAX_ACTIVE_PEERS - runs.size);
          for (const peer of peers) {
            let run!: Promise<void>;
            run = this.#runTurn(peer, signal).finally(() => {
              runs.delete(run);
              this.#byPeer.delete(peer.peerId);
              this.#byPeer.set(peer.peerId, peer);
            });
            runs.add(run);
          }
          if (runs.size === 0) return;
          await Promise.race([...runs, new Promise<void>(resolve => { this.#wake = resolve; })]);
          this.#wake = undefined;
        }
      } finally {
        signal.removeEventListener('abort', wake);
        this.#wake = undefined;
        // Cancellation fences queued work, but retirement waits physical streams.
        await Promise.allSettled(runs);
        this.#scheduled = false;
        if (signal.aborted || this.#closed) { this.#closed = true; this.reset(); }
      }
    };
    if (this.#ports.schedule === undefined) {
      void work(new AbortController().signal);
    } else if (!this.#ports.schedule(work)) {
      this.#scheduled = false;
      this.#closed = true;
      this.reset();
    }
  }

  async #runTurn(peer: PeerV1, signal: AbortSignal): Promise<void> {
    peer.active = true;
    try {
      const scopes = [...peer.scopes.values()].filter(scope => scope.admitted
        && scope.demand !== null).slice(0, MAX_SCOPES_PER_TURN);
      for (const scope of scopes) {
        if (signal.aborted || this.#closed) return;
        const demand = scope.demand!;
        let failed = false;
        peer.started++;
        const now = Date.now();
        if (now - peer.windowStartedAt >= 60_000) {
          peer.windowStartedAt = now;
          peer.windowStarted = 0;
        }
        peer.windowStarted++;
        try {
          try { await this.#ports.reannounce(peer.peerId, scope.contextGraphId, signal); }
          catch (error) {
            failed = true;
            if (!signal.aborted) this.#ports.warn(`RFC-64 compatibility re-announcement failed for ${peer.peerId.slice(-8)}: ${error instanceof Error ? error.message : String(error)}`);
          }
          signal.throwIfAborted();
          failed = (await this.#ports.replay(scope.contextGraphId, demand, signal)).failed > 0 || failed;
          if (failed) this.#ports.warn(`RFC-64 catalog replay incomplete for "${scope.contextGraphId}" after ${peer.peerId.slice(-8)} connected`);
        } catch (error) {
          failed = true;
          if (!signal.aborted) this.#ports.warn(`RFC-64 catalog replay failed after ${peer.peerId.slice(-8)} connected: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          if (failed) peer.failed++;
          scope.failures = failed ? scope.failures + 1 : 0;
          scope.eligibleAt = Date.now() + (failed
            ? retryDelay(peer.peerId, scope, this.#debounceMs) : this.#debounceMs);
          demand.release();
          scope.demand = null;
          scope.admitted = false;
        }
      }
    } finally { peer.active = false; }
  }
}

/** Translate the agent's request once into the replay owner's closed command. */
export function createRfc64CatalogReplayRecoveryCommandV1(
  scope: Readonly<{ contextGraphId: string; policyDigest: string; signal?: AbortSignal }>,
  request: Readonly<
    | { kind: 'connected-peers' }
    | { kind: 'pending-recovery' }
    | { kind: 'connection-demand'; replayDemand: Rfc64CatalogReplayPeerDemandV1 }
  >,
  connectedPeerIds: () => readonly string[],
): Rfc64CatalogReplayRecoveryCommandV1 {
  switch (request.kind) {
    case 'connected-peers':
      return { ...scope, kind: 'full-connected-peers', connectedPeerIds: connectedPeerIds() };
    case 'pending-recovery':
      return { ...scope, kind: 'pending-recovery' };
    case 'connection-demand':
      return { ...scope, kind: 'connection-demand', demand: request.replayDemand };
  }
}
