// SPDX-License-Identifier: Apache-2.0

import type {
  Rfc64CatalogReplayPeerDemandV1,
  Rfc64CatalogReplayPeerReservationV1,
} from './catalog-replay-recovery-runtime-v1.js';
import { Rfc64CatalogReplayScopeLifecycleV1, type Rfc64CatalogReplayScopeAdmissionV1 } from './catalog-replay-scope-lifecycle-v1.js';

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

type ScopeV1 = Rfc64CatalogReplayScopeLifecycleV1;

interface PeerV1 {
  readonly peerId: string;
  readonly scopes: Map<string, ScopeV1>;
  /** Scheduling placement only; lifecycle and completeness custody stay in scopes. */
  readonly executable: Set<string>;
  active: boolean;
  lastUsedAt: number;
  started: number;
  failed: number;
  windowStartedAt: number;
  windowStarted: number;
  connected: boolean;
  connectionGeneration: number;
}

const DEFAULT_DEBOUNCE_MS = 60_000;
const DEFAULT_MAX_PEERS = 256;
const MAX_SCOPES_PER_PEER = 256;
const MAX_SCOPES_PER_TURN = 8;
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
        scope.releaseAll();
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
        + [...peer.scopes.values()].reduce((count, scope) => count
          + scope.outstanding, 0), 0),
      suppressed: this.#suppressed,
      peers: Object.freeze([...this.#byPeer.values()].map(peer => Object.freeze({
        peerIdSuffix: peer.peerId.slice(-8), started: peer.started, failed: peer.failed,
        startedLastMinute: now - peer.windowStartedAt < 60_000 ? peer.windowStarted : 0,
        nextEligibleAt: Math.min(...this.#windowScopes(peer).map(scope => scope.eligibleAt)),
      }))),
    });
  }

  prepareConnectionOpen(peerId: string, nowMs = Date.now()): Rfc64CatalogReplayConnectionReservationV1 | null {
    return this.#prepare(peerId, nowMs, { kind: 'connection-open' });
  }

  prepareGraphActivation(peerId: string, contextGraphId: string, nowMs = Date.now()): Rfc64CatalogReplayConnectionReservationV1 | null {
    return this.#prepare(peerId, nowMs, { kind: 'graph-activated', contextGraphId });
  }

  #prepare(peerId: string, nowMs: number, event: Readonly<{ kind: 'connection-open' }>
    | Readonly<{ kind: 'graph-activated'; contextGraphId: string }>): Rfc64CatalogReplayConnectionReservationV1 | null {
    if (this.#closed) return null;
    const active = [...new Set(this.#ports.selectContextGraphIds())].sort();
    const selection = new Set(active);
    for (const existing of this.#byPeer.values()) this.#pruneSelection(existing, selection);
    const selected = event.kind === 'connection-open' ? active
      : active.includes(event.contextGraphId) ? [event.contextGraphId] : [];
    if (selected.length === 0) return null;
    let peer = this.#byPeer.get(peerId);
    if (peer === undefined) {
      if (this.#byPeer.size >= this.#maxPeers) {
        const idle = [...this.#byPeer.values()].filter(candidate => !candidate.active
          && ![...candidate.scopes.values()].some(scope => scope.outstanding > 0))
          .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
        if (idle === undefined) { this.#suppressed++; return null; }
        this.#byPeer.delete(idle.peerId);
      }
      peer = { peerId, scopes: new Map(), executable: new Set(), active: false, lastUsedAt: nowMs,
        started: 0, failed: 0, windowStartedAt: nowMs, windowStarted: 0,
        connected: true, connectionGeneration: 1 };
      this.#byPeer.set(peerId, peer);
    }
    peer.lastUsedAt = nowMs;
    if (event.kind === 'connection-open' && !peer.connected) {
      peer.connected = true; peer.connectionGeneration++;
    }
    const reservations: Rfc64CatalogReplayScopeAdmissionV1[] = [];
    for (const id of selected) {
      const scope = this.#scope(peer, id, nowMs);
      const reservation = scope.reserve(peer.connectionGeneration, () => this.#ports.reserveFence(id, peer.peerId));
      if (reservation === null) this.#suppressed++;
      else reservations.push(reservation);
    }
    if (reservations.length === 0) return null;
    let settled = false;
    const release = (): void => { for (const reservation of reservations) reservation.reject(); };
    return Object.freeze({
      reject: () => { if (!settled) { settled = true; release(); } },
      admit: () => {
        if (settled) return;
        settled = true;
        if (this.#closed) { release(); return; }
        for (const reservation of reservations) reservation.admit();
        this.#schedule();
      },
    });
  }

  /** Only the lifecycle's last-live-connection close opens a new generation. */
  disconnected(peerId: string): void {
    const peer = this.#byPeer.get(peerId);
    if (peer !== undefined) peer.connected = false;
  }

  #scope(peer: PeerV1, id: string, nowMs: number): ScopeV1 {
    const existing = peer.scopes.get(id);
    if (existing !== undefined) return existing;
    const scope = new Rfc64CatalogReplayScopeLifecycleV1(id, peer.peerId, this.#debounceMs);
    peer.scopes.set(id, scope);
    this.#installScope(peer, scope, nowMs);
    return scope;
  }

  #installScope(peer: PeerV1, scope: ScopeV1, now: number): boolean {
    if (peer.executable.has(scope.contextGraphId)) return true;
    if (peer.executable.size >= MAX_SCOPES_PER_PEER) {
      if (peer.active) return false;
      const candidates = this.#windowScopes(peer);
      const displaced = candidates.find(candidate => candidate.canEvict(now))
        ?? candidates.find(candidate => candidate.canDefer(now));
      if (displaced === undefined) return false;
      peer.executable.delete(displaced.contextGraphId);
    }
    peer.executable.add(scope.contextGraphId);
    return true;
  }

  #pruneSelection(peer: PeerV1, selected: ReadonlySet<string>): void {
    for (const [id, scope] of peer.scopes) {
      if (selected.has(id)) continue;
      scope.retireSelection();
      if (!scope.executing) { peer.scopes.delete(id); peer.executable.delete(id); }
    }
  }

  #continue(peer: PeerV1, now: number, selected: ReadonlySet<string>): void {
    this.#pruneSelection(peer, selected);
    for (const scope of peer.scopes.values()) {
      scope.retryFence(() => this.#ports.reserveFence(scope.contextGraphId, peer.peerId));
    }
    // A physical turn retains its captured scopes. Snapshot overflow so a displaced
    // scope cannot be promoted again in this same synchronous sweep.
    if (peer.active) return;
    const deferred = [...peer.scopes.values()].filter(scope => !peer.executable.has(scope.contextGraphId));
    for (const scope of deferred) {
      if (scope.ready(now)) this.#installScope(peer, scope, now);
    }
  }

  #windowScopes(peer: PeerV1): readonly ScopeV1[] {
    return Array.from(peer.executable).flatMap(id => {
      const scope = peer.scopes.get(id);
      return scope === undefined ? [] : [scope];
    });
  }

  #runnable(peer: PeerV1, now: number): readonly ScopeV1[] {
    return this.#windowScopes(peer).filter(scope => scope.ready(now));
  }

  #ready(peer: PeerV1, now: number): boolean {
    return !peer.active && this.#runnable(peer, now).length > 0;
  }

  #nextDeadline(): number {
    let deadline = Infinity;
    const now = Date.now();
    for (const peer of this.#byPeer.values()) {
      const deferred = [...peer.scopes.values()].some(scope => !peer.executable.has(scope.contextGraphId)
        && scope.outstanding > 0);
      if (deferred && this.#runnable(peer, now).length === 0) {
        deadline = Math.min(deadline, now + 1_000);
      }
      for (const scope of this.#windowScopes(peer)) {
        if (scope.awaitingFence()) deadline = Math.min(deadline, now + 1_000);
        if (scope.queued && scope.eligibleAt > now) {
          deadline = Math.min(deadline, scope.eligibleAt);
        }
        if (deferred && scope.outstanding === 0) {
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
        const selected = new Set(this.#ports.selectContextGraphIds());
        for (const peer of this.#byPeer.values()) this.#continue(peer, now, selected);
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
          const now = Date.now();
          const selected = new Set(this.#ports.selectContextGraphIds());
          for (const peer of this.#byPeer.values()) this.#continue(peer, now, selected);
          if ([...this.#byPeer.values()].some(peer => this.#ready(peer, now))) this.#schedule();
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
      for (const scope of scopes) {
        if (signal.aborted || this.#closed) return;
        this.#pruneSelection(peer, new Set(this.#ports.selectContextGraphIds()));
        const execution = scope.begin(Date.now());
        if (execution === null) continue;
        const demand = execution.lease;
        let failed = false;
        peer.started++;
        const now = Date.now();
        if (now - peer.windowStartedAt >= 60_000) {
          peer.windowStartedAt = now;
          peer.windowStarted = 0;
        }
        peer.windowStarted++;
        try {
          try { failed = (await this.#ports.reannounce(peer.peerId, scope.contextGraphId, signal)).failed > 0; }
          catch (error) {
            failed = true;
            if (!signal.aborted) this.#ports.warn(`RFC-64 compatibility re-announcement failed for ${peer.peerId.slice(-8)}: ${error instanceof Error ? error.message : String(error)}`);
          }
          signal.throwIfAborted();
          demand.admit();
          failed = (await this.#ports.replay(scope.contextGraphId, demand, signal)).failed > 0 || failed;
          if (failed) this.#ports.warn(`RFC-64 catalog replay incomplete for "${scope.contextGraphId}" after ${peer.peerId.slice(-8)} connected`);
        } catch (error) {
          failed = true;
          if (!signal.aborted) this.#ports.warn(`RFC-64 catalog replay failed after ${peer.peerId.slice(-8)} connected: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          if (failed) peer.failed++;
          scope.finish(execution, failed, Date.now());
        }
      }
    } finally { peer.active = false; if (this.#closed) this.#retire(); }
  }
}
