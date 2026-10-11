// SPDX-License-Identifier: Apache-2.0

import type {
  Rfc64CatalogReplayPeerDemandV1,
  Rfc64CatalogReplayPeerReservationV1,
} from './catalog-replay-recovery-runtime-v1.js';

export interface Rfc64CatalogReplayConnectionRuntimePortsV1 {
  selectContextGraphIds(): readonly string[];
  reserveFence(contextGraphId: string, peerId: string): Rfc64CatalogReplayPeerReservationV1 | null;
  reannounce(peerId: string, contextGraphId: string, signal: AbortSignal): Promise<Readonly<{ failed: number }>>;
  replay(contextGraphId: string, demand: Rfc64CatalogReplayPeerDemandV1,
    signal: AbortSignal): Promise<Readonly<{ failed: number }>>;
  /** Two stream keys plus one independent, abortable eligibility notifier. */
  schedule(slot: 0 | 1 | 'deadline', work: (signal: AbortSignal) => Promise<void>): boolean;
  wait(signal: AbortSignal, delayMs: number): Promise<void>;
  warn(message: string): void;
}

export interface Rfc64CatalogReplayConnectionReservationV1 {
  admit(): void;
  reject(): void;
}

type PendingScopeV1 = Readonly<{ state: 'reserved'; lease: Rfc64CatalogReplayPeerReservationV1 }>
  | Readonly<{ state: 'admitted'; lease: Rfc64CatalogReplayPeerReservationV1 }>;

interface ScopeV1 {
  readonly contextGraphId: string;
  pending: PendingScopeV1 | null;
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
  continuation: { after: string | null; through: string } | null;
  readonly activated: Set<string>;
}

const DEFAULT_DEBOUNCE_MS = 60_000;
const DEFAULT_MAX_PEERS = 256;
const MAX_SCOPES_PER_PEER = 256;
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
 * Staged completeness fences are acquired synchronously before network admission;
 * overflow selection resumes after that admission succeeds. Each
 * peer has one serial stream owner; at most two peers run on the node. Short
 * disconnects retain scope backoff, while bounded turns allow other peers to
 * progress. A new graph activation adds only that graph, even during a pass.
 */
export class Rfc64CatalogReplayConnectionRuntimeV1 {
  readonly #byPeer = new Map<string, PeerV1>();
  readonly #ports: Rfc64CatalogReplayConnectionRuntimePortsV1;
  readonly #debounceMs: number;
  readonly #maxPeers: number;
  #closed = false;
  #suppressed = 0;

  constructor(ports: Rfc64CatalogReplayConnectionRuntimePortsV1,
    debounceMs = DEFAULT_DEBOUNCE_MS, maxPeers = DEFAULT_MAX_PEERS) {
    this.#ports = ports;
    this.#debounceMs = debounceMs;
    this.#maxPeers = maxPeers;
  }

  /** Called only after the lifecycle background owner has physically drained. */
  reset(): void {
    for (const peer of this.#byPeer.values()) {
      for (const scope of peer.scopes.values()) {
        this.#settle(scope);
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
        + [...peer.scopes.values()].filter(scope => scope.pending !== null).length, 0),
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
    const active = [...new Set(this.#ports.selectContextGraphIds())].sort();
    const selected = contextGraphId === undefined ? active : active.includes(contextGraphId) ? [contextGraphId] : [];
    if (selected.length === 0) return null;
    let peer = this.#byPeer.get(peerId);
    if (peer === undefined) {
      if (this.#byPeer.size >= this.#maxPeers) {
        const idle = [...this.#byPeer.values()].filter(candidate => !candidate.active
          && candidate.continuation === null && candidate.activated.size === 0
          && ![...candidate.scopes.values()].some(scope => scope.pending !== null))
          .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
        if (idle === undefined) { this.#suppressed++; return null; }
        this.#byPeer.delete(idle.peerId);
      }
      peer = { peerId, scopes: new Map(), active: false, lastUsedAt: nowMs,
        started: 0, failed: 0, windowStartedAt: nowMs, windowStarted: 0, continuation: null, activated: new Set() };
      this.#byPeer.set(peerId, peer);
    }
    peer.lastUsedAt = nowMs;
    const reservations: { scope: ScopeV1; pending: PendingScopeV1 }[] = [];
    const deferred: string[] = [];
    let after: string | null = null;
    for (const id of selected) {
      const scope = this.#scope(peer, id, nowMs);
      if (scope === null) { deferred.push(id); continue; }
      if (scope.pending !== null) {
        if (deferred.length === 0) after = id;
        this.#suppressed++; continue;
      }
      const pending = this.#stage(scope, peerId, 'reserved');
      if (pending === null) { deferred.push(id); continue; }
      reservations.push({ scope, pending });
      if (deferred.length === 0) after = id;
    }
    if (reservations.length === 0 && deferred.length === 0) return null;
    let settled = false;
    const release = (): void => {
      for (const { scope, pending } of reservations) this.#settle(scope, pending);
    };
    return Object.freeze({
      reject: () => { if (!settled) { settled = true; release(); } },
      admit: () => {
        if (settled) return;
        settled = true;
        if (this.#closed) { release(); return; }
        for (const { scope, pending } of reservations) {
          if (scope.pending === pending) scope.pending = { state: 'admitted', lease: pending.lease };
        }
        if (deferred.length > 0) {
          if (contextGraphId === undefined) {
            // Only a sorted cursor is retained, not a lease/array for every graph.
            peer.continuation ??= { after, through: selected[selected.length - 1] };
          } else peer.activated.add(contextGraphId);
        }
        this.#schedule();
      },
    });
  }

  #scope(peer: PeerV1, id: string, nowMs: number): ScopeV1 | null {
    let scope = peer.scopes.get(id);
    if (scope !== undefined) return scope;
    if (peer.scopes.size >= MAX_SCOPES_PER_PEER) {
      const idle = [...peer.scopes.values()].find(candidate => candidate.pending === null
        && candidate.eligibleAt <= nowMs);
      if (idle === undefined) return null;
      peer.scopes.delete(idle.contextGraphId);
    }
    scope = { contextGraphId: id, pending: null, failures: 0, eligibleAt: 0 };
    peer.scopes.set(id, scope);
    return scope;
  }

  #stage(scope: ScopeV1, peerId: string, state: PendingScopeV1['state']): PendingScopeV1 | null {
    const lease = this.#ports.reserveFence(scope.contextGraphId, peerId);
    if (lease === null) return null;
    const pending: PendingScopeV1 = state === 'reserved'
      ? { state: 'reserved', lease } : { state: 'admitted', lease };
    scope.pending = pending;
    return pending;
  }

  #settle(scope: ScopeV1, pending = scope.pending): void {
    if (pending === null || scope.pending !== pending) return;
    pending.lease.release();
    scope.pending = null;
  }

  #continue(peer: PeerV1, now: number): void {
    if (peer.continuation === null && peer.activated.size === 0) return;
    const selected = [...new Set(this.#ports.selectContextGraphIds())].sort();
    const stage = (id: string): boolean => {
      const scope = this.#scope(peer, id, now);
      return scope !== null && (scope.pending !== null || this.#stage(scope, peer.peerId, 'admitted') !== null);
    };
    // Exact activation staging is bounded by the authoritative active graph set.
    for (const id of peer.activated) {
      if (!selected.includes(id)) { peer.activated.delete(id); continue; }
      if (!stage(id)) return;
      peer.activated.delete(id);
    }
    const continuation = peer.continuation;
    if (continuation === null) return;
    for (const id of selected) {
      if ((continuation.after !== null && id <= continuation.after) || id > continuation.through) continue;
      if (!stage(id)) return;
      continuation.after = id;
    }
    peer.continuation = null;
  }

  #runnable(peer: PeerV1, now: number): readonly { scope: ScopeV1; pending: PendingScopeV1 }[] {
    return [...peer.scopes.values()].flatMap(scope => scope.pending?.state === 'admitted'
      && scope.eligibleAt <= now ? [{ scope, pending: scope.pending }] : []);
  }

  #ready(peer: PeerV1, now: number): boolean {
    return !peer.active && this.#runnable(peer, now).length > 0;
  }

  #nextDeadline(): number {
    let deadline = Infinity;
    const now = Date.now();
    for (const peer of this.#byPeer.values()) {
      if ((peer.continuation !== null || peer.activated.size > 0) && this.#runnable(peer, now).length === 0) {
        deadline = Math.min(deadline, now + 1_000);
      }
      for (const scope of peer.scopes.values()) {
        if (scope.pending?.state === 'admitted' && scope.eligibleAt > now) {
          deadline = Math.min(deadline, scope.eligibleAt);
        }
        if ((peer.continuation !== null || peer.activated.size > 0) && scope.pending === null) {
          deadline = Math.min(deadline, scope.eligibleAt > now ? scope.eligibleAt : now + 1_000);
        }
      }
    }
    return deadline;
  }


  #schedule(): void {
    if (this.#closed) return;
    const worker = async (signal: AbortSignal): Promise<void> => {
      try {
        if (signal.aborted || this.#closed) return;
        const now = Date.now();
        for (const peer of this.#byPeer.values()) this.#continue(peer, now);
        const peer = [...this.#byPeer.values()].find(candidate => this.#ready(candidate, now));
        if (peer === undefined) return;
        await this.#runTurn(peer, signal);
        // Move a completed turn behind the other ready peers.
        this.#byPeer.delete(peer.peerId); this.#byPeer.set(peer.peerId, peer);
        if (!signal.aborted) this.#schedule();
      } finally { if (signal.aborted) this.#retire(); }
    };
    for (const slot of [0, 1] as const) {
      if (!this.#ports.schedule(slot, worker)) { this.#retire(); return; }
    }
    if (this.#nextDeadline() !== Infinity && !this.#ports.schedule('deadline', async signal => {
      try {
        while (!signal.aborted && !this.#closed) {
          const deadline = this.#nextDeadline();
          if (deadline === Infinity) return;
          // One owned notifier; stream slots never wait for future eligibility.
          await this.#ports.wait(signal, Math.min(1_000, Math.max(1, deadline - Date.now())));
          for (const peer of this.#byPeer.values()) this.#continue(peer, Date.now());
          if ([...this.#byPeer.values()].some(peer => this.#ready(peer, Date.now()))) this.#schedule();
        }
      } finally { if (signal.aborted) this.#retire(); }
    })) this.#retire();
  }

  #retire(): void {
    this.#closed = true;
    if (![...this.#byPeer.values()].some(peer => peer.active)) this.reset();
  }

  async #runTurn(peer: PeerV1, signal: AbortSignal): Promise<void> {
    peer.active = true;
    try {
      const scopes = this.#runnable(peer, Date.now()).slice(0, MAX_SCOPES_PER_TURN);
      for (const { scope, pending } of scopes) {
        if (signal.aborted || this.#closed) return;
        const demand = pending.lease;
        let failed = false;
        peer.started++;
        const now = Date.now();
        if (now - peer.windowStartedAt >= 60_000) {
          peer.windowStartedAt = now;
          peer.windowStarted = 0;
        }
        peer.windowStarted++;
        try {
          demand.admit();
          try { failed = (await this.#ports.reannounce(peer.peerId, scope.contextGraphId, signal)).failed > 0; }
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
          this.#settle(scope, pending);
        }
      }
    } finally { peer.active = false; if (this.#closed) this.#retire(); }
  }
}
