import type { Rfc64CatalogConnectionReplayStatusV1 } from './catalog-selection-types-v1.js';
import type { Rfc64CatalogConnectionReplayResultV1 } from './catalog-replay-run-reporter-v1.js';
// SPDX-License-Identifier: Apache-2.0

import type {
  Rfc64CatalogReplayPeerDemandHandleV1,
} from './catalog-replay-recovery-runtime-v1.js';
import { Rfc64CatalogReplayScopeLifecycleV1, type Rfc64CatalogConnectionCustodyV1, type Rfc64CatalogReplayScopeAdmissionV1 } from './catalog-replay-scope-lifecycle-v1.js';

export interface Rfc64CatalogReplayConnectionRuntimePortsV1 {
  selectContextGraphIds(): readonly string[];
  /** Current topology filtered by completed network admission; never pending/rejected peers. */
  admittedConnectedPeerIds(): readonly string[];
  reserveDeferredFence(contextGraphId: string): Readonly<{ release(): void }> | null;
  reserveFence(contextGraphId: string, peerId: string): Rfc64CatalogConnectionCustodyV1 | null;
  reannounce(peerId: string, contextGraphId: string, signal: AbortSignal): Promise<Rfc64CatalogConnectionReplayResultV1>;
  replay(contextGraphId: string, demand: Rfc64CatalogReplayPeerDemandHandleV1,
    signal: AbortSignal): Promise<Rfc64CatalogConnectionReplayResultV1>;
  /** Two stream keys plus one independent, abortable eligibility notifier. */
  schedule(slot: 0 | 1 | 'deadline', work: (signal: AbortSignal) => Promise<void>): boolean;
  wait(signal: AbortSignal, delayMs: number): Promise<void>;
  warn(message: string): void;
  reportRun?(contextGraphId: string, peerId: string, result: Rfc64CatalogConnectionReplayResultV1): void;
}

export interface Rfc64CatalogReplayConnectionReservationV1 {
  admit(): void;
  reject(): void;
}

type ScopeV1 = Rfc64CatalogReplayScopeLifecycleV1;

interface PeerV1 {
  readonly peerId: string;
  readonly scopes: Map<string, ScopeV1>;
  active: boolean;
  lastUsedAt: number;
  started: number;
  failed: number;
  windowStartedAt: number;
  windowStarted: number;
  connected: boolean;
  connectionGeneration: number;
}

interface SchedulingSweepV1 { turns: Array<{ peer: PeerV1; scopes: readonly ScopeV1[] }>; nextWake: number }

/** One coalesced intent owns admission, its scan and all deferred graph leases. */
class OverflowIntentV1 {
  pending = 0;
  cursor: { after?: string } | null = null;
  retired = false;
  readonly #leases = new Map<string, Readonly<{ release(): void }>>();
  reserve(selected: readonly string[], reserve: Rfc64CatalogReplayConnectionRuntimePortsV1['reserveDeferredFence']):
  Rfc64CatalogReplayConnectionReservationV1 {
    for (const id of selected) {
      if (this.#leases.has(id)) continue;
      const lease = reserve(id); if (lease) this.#leases.set(id, lease);
    }
    this.pending++;
    let settled = false;
    const finish = (admitted: boolean) => {
      if (settled || this.retired) return;
      settled = true; this.pending--;
      if (admitted) this.cursor = {}; // New topology admission restarts this intent's scan.
    };
    return { admit: () => finish(true), reject: () => finish(false) };
  }
  prune(selected: ReadonlySet<string>): void {
    for (const [id, lease] of this.#leases) if (!selected.has(id)) {
      this.#leases.delete(id); lease.release();
    }
  }
  get idle(): boolean { return this.pending === 0 && this.cursor === null; }
  retire(): void {
    this.retired = true; this.cursor = null;
    for (const lease of this.#leases.values()) lease.release();
    this.#leases.clear();
  }
}

const DEFAULT_DEBOUNCE_MS = 60_000;
const DEFAULT_MAX_PEERS = 256;
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
  readonly #overflowIntents = new Map<string | null, OverflowIntentV1>();

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
    for (const intent of this.#overflowIntents.values()) intent.retire();
    this.#overflowIntents.clear();
  }

  status(): Rfc64CatalogConnectionReplayStatusV1 {
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
        nextEligibleAt: Math.min(...[...peer.scopes.values()].map(scope => scope.eligibleAt)),
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
    const reservations = this.#reserveSelected(peerId, selected, event.kind === 'connection-open', nowMs);
    if (reservations === null) {
      this.#suppressed++;
      const key = event.kind === 'connection-open' ? null : event.contextGraphId;
      let intent = this.#overflowIntents.get(key);
      if (!intent) { intent = new OverflowIntentV1(); this.#overflowIntents.set(key, intent); }
      const owned = intent;
      const admission = owned.reserve(selected, id => this.#ports.reserveDeferredFence(id));
      return Object.freeze({
        reject: () => { admission.reject(); this.#retireIdleOverflow(key, owned); },
        admit: () => {
          if (owned.retired) return;
          if (this.#closed) { admission.reject(); this.#retireIdleOverflow(key, owned); return; }
          admission.admit(); this.#schedule();
        },
      });
    }
    if (reservations.length === 0) return null;
    let settled = false;
    const release = (): void => { for (const reservation of reservations) reservation.reject(); };
    return Object.freeze({
      reject: () => { if (!settled) { settled = true; release(); if (this.#overflowIntents.size) this.#schedule(); } },
      admit: () => {
        if (settled) return;
        settled = true;
        if (this.#closed) { release(); return; }
        for (const reservation of reservations) reservation.admit();
        this.#schedule();
      },
    });
  }

  /** Synchronous reservation mutation; callers own admission and worker notification. */
  #reserveSelected(peerId: string, selected: readonly string[], connectionOpen: boolean, nowMs: number): Rfc64CatalogReplayScopeAdmissionV1[] | null {
    let peer = this.#byPeer.get(peerId);
    if (peer === undefined) {
      if (this.#byPeer.size >= this.#maxPeers) {
        const idle = [...this.#byPeer.values()].filter(candidate => !candidate.active
          && ![...candidate.scopes.values()].some(scope => scope.outstanding > 0))
          .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
        if (idle === undefined) return null;
        this.#byPeer.delete(idle.peerId);
      }
      peer = { peerId, scopes: new Map(), active: false, lastUsedAt: nowMs,
        started: 0, failed: 0, windowStartedAt: nowMs, windowStarted: 0,
        connected: true, connectionGeneration: 1 };
      this.#byPeer.set(peerId, peer);
    }
    peer.lastUsedAt = nowMs;
    if (connectionOpen && !peer.connected) {
      peer.connected = true; peer.connectionGeneration++;
    }
    const reservations: Rfc64CatalogReplayScopeAdmissionV1[] = [];
    for (const id of selected) {
      const scope = this.#scope(peer, id);
      const reservation = scope.reserve(peer.connectionGeneration, () => this.#ports.reserveFence(id, peer.peerId));
      if (reservation === null) this.#suppressed++;
      else reservations.push(reservation);
    }
    return reservations;
  }

  /** Only the lifecycle's last-live-connection close opens a new generation. */
  disconnected(peerId: string): void {
    const peer = this.#byPeer.get(peerId);
    if (peer !== undefined) peer.connected = false;
  }

  #scope(peer: PeerV1, id: string): ScopeV1 {
    const existing = peer.scopes.get(id);
    if (existing !== undefined) return existing;
    const scope = new Rfc64CatalogReplayScopeLifecycleV1(id, peer.peerId, this.#debounceMs);
    peer.scopes.set(id, scope);
    return scope;
  }

  #pruneSelection(peer: PeerV1, selected: ReadonlySet<string>): void {
    for (const [id, scope] of peer.scopes) {
      if (selected.has(id)) continue;
      scope.retireSelection();
      if (!scope.executing) { peer.scopes.delete(id); }
    }
  }

  #continue(peer: PeerV1, selected: ReadonlySet<string>): void {
    this.#pruneSelection(peer, selected);
    for (const scope of peer.scopes.values()) {
      scope.retryFence(() => this.#ports.reserveFence(scope.contextGraphId, peer.peerId));
    }
  }

  #retireIdleOverflow(key: string | null, intent: OverflowIntentV1): void {
    if (intent.retired || !intent.idle) return;
    intent.retire(); this.#overflowIntents.delete(key);
  }

  #resumeOverflow(): void {
    if (this.#closed || this.#overflowIntents.size === 0) return;
    const selected = new Set(this.#ports.selectContextGraphIds());
    const peers = [...new Set(this.#ports.admittedConnectedPeerIds())].sort();
    for (const [graph, intent] of this.#overflowIntents) {
      intent.prune(selected);
      if (graph !== null && !selected.has(graph)) {
        intent.retire(); this.#overflowIntents.delete(graph); continue;
      }
      const cursor = intent.cursor;
      if (cursor === null) continue; // Network admission still owns this intent.
      for (const peerId of peers) {
        if (cursor.after !== undefined && peerId <= cursor.after) continue;
        const missing = (graph === null ? [...selected] : [graph]).filter(id => !this.#byPeer.get(peerId)?.scopes.has(id));
        if (missing.length > 0) {
          const reservations = this.#reserveSelected(peerId, missing, graph === null, Date.now());
          if (reservations === null) return;
          for (const reservation of reservations) reservation.admit();
        }
        cursor.after = peerId;
      }
      intent.cursor = null; this.#retireIdleOverflow(graph, intent);
    }
  }

  /** Advance each peer's scheduling window once for this synchronous sweep. */
  #sweep(now: number): SchedulingSweepV1 {
    const selected = new Set(this.#ports.selectContextGraphIds());
    const turns: Array<{ peer: PeerV1; scopes: readonly ScopeV1[] }> = [];
    let nextWake = Infinity;
    for (const peer of this.#byPeer.values()) {
      this.#continue(peer, selected);
      const runnable: ScopeV1[] = [];
      for (const scope of peer.scopes.values()) {
        if (scope.awaitingFence()) nextWake = Math.min(nextWake, now + 1_000);
        if (scope.queued && scope.eligibleAt > now) nextWake = Math.min(nextWake, scope.eligibleAt);
        if (scope.ready(now) && runnable.length < MAX_SCOPES_PER_TURN) runnable.push(scope);
      }
      if (!peer.active && runnable.length > 0) turns.push({ peer, scopes: runnable });
    }
    return { turns, nextWake };
  }

  #schedule(): void {
    if (this.#closed) return;
    for (const slot of [0, 1, 'deadline'] as const) {
      if (!this.#ports.schedule(slot, slot === 'deadline' ? this.#deadline : this.#worker)) {
        this.#retire(); return;
      }
    }
  }

  readonly #worker = async (signal: AbortSignal): Promise<void> => {
    try {
      if (signal.aborted || this.#closed) return;
      this.#resumeOverflow();
      const turn = this.#sweep(Date.now()).turns[0];
      if (turn === undefined) return;
      const { peer, scopes } = turn;
      await this.#runTurn(peer, scopes, signal);
      // Move a completed turn behind the other ready peers.
      if (this.#byPeer.get(peer.peerId) === peer) {
        this.#byPeer.delete(peer.peerId); this.#byPeer.set(peer.peerId, peer);
      }
      if (!signal.aborted) { this.#resumeOverflow(); this.#schedule(); }
    } finally { if (signal.aborted) this.#retire(); }
  };

  readonly #deadline = async (signal: AbortSignal): Promise<void> => {
    try {
      while (!signal.aborted && !this.#closed) {
        const sweep = this.#sweep(Date.now());
        if (sweep.turns.length > 0) for (const slot of [0, 1] as const) {
          if (!this.#ports.schedule(slot, this.#worker)) { this.#retire(); return; }
        }
        if (sweep.nextWake === Infinity) return;
        // One owned notifier; stream slots never wait for future eligibility.
        await this.#ports.wait(signal, Math.min(1_000, Math.max(1, sweep.nextWake - Date.now())));
      }
    } finally { if (signal.aborted) this.#retire(); }
  };

  #retire(): void {
    this.#closed = true;
    if (![...this.#byPeer.values()].some(peer => peer.active)) this.reset();
  }

  async #runTurn(peer: PeerV1, scopes: readonly ScopeV1[], signal: AbortSignal): Promise<void> {
    peer.active = true;
    try {
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
          if (demand === 'announcement-only') continue;
          demand.admit();
          const result = await this.#ports.replay(scope.contextGraphId, demand, signal);
          failed = result.failed > 0 || failed;
          if (result.failed > 0) {
            if (this.#ports.reportRun) this.#ports.reportRun(scope.contextGraphId, peer.peerId, result);
            else this.#ports.warn(`RFC-64 catalog replay incomplete for "${scope.contextGraphId}" after ${peer.peerId.slice(-8)} connected`);
          }
        } catch (error) {
          failed = true;
          if (!signal.aborted) this.#ports.warn(`RFC-64 catalog replay failed after ${peer.peerId.slice(-8)} connected: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          if (failed) peer.failed++;
          scope.finish(execution, failed, Date.now());
          // The canonical collection also carries round-robin order.
          if (peer.scopes.get(scope.contextGraphId) === scope) {
            peer.scopes.delete(scope.contextGraphId); peer.scopes.set(scope.contextGraphId, scope);
          }
        }
      }
    } finally { peer.active = false; if (this.#closed) this.#retire(); }
  }
}
