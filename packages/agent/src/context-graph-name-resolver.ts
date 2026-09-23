// SPDX-License-Identifier: Apache-2.0

/**
 * Background resolution of Context Graph subscriptions that this node knows
 * only by their on-chain name hash.
 *
 * A node that learned a public graph from `ContextGraphCreated` holds a
 * hash-keyed placeholder row; every holder keys the data by the cleartext id,
 * so a subscription to that row syncs nothing until the cleartext is known.
 * This resolver collects candidate ids and hands a verified one to the
 * adoption hook, which promotes the row to its cleartext identity.
 *
 * Candidate sources, cheapest first:
 *  1. `local-store`   ontology definitions and gossiped agent profiles this
 *                      node already stores (no network).
 *  2. `peer-protocol`  `/dkg/10.0.0/context-graph-name/1` on connected peers
 *                      that advertise it (upgraded peers only; old peers are
 *                      skipped without being dialed).
 *  3. `peer-ontology`  the `ontology` system graph pulled over the existing
 *                      sync protocol and scanned in memory. Works against
 *                      10.0.17/10.0.18 peers.
 *
 * Only graphs whose on-chain access policy is public are attempted. Every
 * candidate, whatever its source, must satisfy
 * `keccak256(utf8(candidate)) === nameHash` before it reaches `adopt`.
 */

import {
  findVerifiedContextGraphName,
  normalizeContextGraphNameHash,
  verifyContextGraphNameCandidate,
} from './context-graph-name-candidate.js';

export type ContextGraphNameSource = 'local-store' | 'peer-protocol' | 'peer-ontology';
export type ContextGraphNamePolicy = 'public' | 'private' | 'unknown';
export type ContextGraphNamePendingOutcome =
  | 'not-attempted'
  | 'policy-unavailable'
  | 'no-peers'
  | 'not-found';

export interface ContextGraphNameTarget {
  /** Lowercase name hash; also the placeholder row's local id. */
  readonly nameHash: string;
  readonly onChainId: string;
}

export type ContextGraphNameResolutionEntry =
  | {
    readonly state: 'pending';
    readonly nameHash: string;
    readonly onChainId: string;
    readonly attempts: number;
    readonly lastOutcome: ContextGraphNamePendingOutcome;
    readonly lastAttemptAt?: number;
    readonly nextAttemptAt?: number;
    /** Connected peers that advertised the name protocol on the last attempt. */
    readonly peersSupportingProtocol: number;
  }
  | {
    readonly state: 'private';
    readonly nameHash: string;
    readonly onChainId: string;
  }
  | {
    readonly state: 'resolved';
    readonly nameHash: string;
    readonly onChainId: string;
    readonly contextGraphId: string;
    readonly source: ContextGraphNameSource;
    readonly resolvedAt: number;
  };

export interface ContextGraphNameResolverDeps {
  /** Hash-only rows that currently want a cleartext id. */
  listTargets(): readonly ContextGraphNameTarget[];
  /** Re-checked after every await: is this still a hash-only row? */
  isTargetCurrent(target: ContextGraphNameTarget): boolean;
  /** Fail closed: anything not provably public or private is `unknown`. */
  classifyPolicy(target: ContextGraphNameTarget, signal: AbortSignal): Promise<ContextGraphNamePolicy>;
  /** Unverified candidates from this node's own store. */
  findLocalCandidates(target: ContextGraphNameTarget, signal: AbortSignal): Promise<readonly string[]>;
  /** Connected, not-rejected peers, most promising first. */
  listPeers(): readonly string[];
  /** true / false from the peer's identify record; undefined while unknown. */
  peerSupportsNameProtocol(peerId: string): Promise<boolean | undefined>;
  /** The peer's unverified answer, or null. Must not throw for old peers. */
  askPeer(peerId: string, target: ContextGraphNameTarget, signal: AbortSignal): Promise<string | null>;
  /**
   * Pull the peer's ontology graph once and return unverified candidates per
   * requested name hash. Null when the pull could not complete.
   */
  pullPeerOntology(
    peerId: string,
    nameHashes: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, string> | null>;
  /** Promote the row. False when the row changed and the adoption was skipped. */
  adopt(target: ContextGraphNameTarget, contextGraphId: string, source: ContextGraphNameSource): Promise<boolean>;
  readonly log: {
    info(message: string): void;
    debug(message: string): void;
  };
  readonly now?: () => number;
}

export interface ContextGraphNameResolverOptions {
  readonly maxPeersPerAttempt?: number;
  readonly maxOntologyPullsPerAttempt?: number;
  readonly peerAskTtlMs?: number;
  readonly ontologyPullCooldownMs?: number;
  readonly ontologyPullFailureCooldownMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
}

const CONTEXT_GRAPH_NAME_MAX_PEERS_PER_ATTEMPT = 8;
const CONTEXT_GRAPH_NAME_MAX_ONTOLOGY_PULLS_PER_ATTEMPT = 2;
const CONTEXT_GRAPH_NAME_PEER_ASK_TTL_MS = 10 * 60_000;
const CONTEXT_GRAPH_NAME_ONTOLOGY_PULL_COOLDOWN_MS = 30 * 60_000;
const CONTEXT_GRAPH_NAME_ONTOLOGY_PULL_FAILURE_COOLDOWN_MS = 2 * 60_000;
const CONTEXT_GRAPH_NAME_RETRY_BASE_MS = 30_000;
const CONTEXT_GRAPH_NAME_RETRY_MAX_MS = 10 * 60_000;
/** Bounds on remembered state; oldest entries are evicted first. */
const MAX_REMEMBERED_ASKS = 4_096;
const MAX_REMEMBERED_RESOLUTIONS = 256;
const MAX_QUEUED_PEERS_PER_TARGET = 64;

function short(nameHash: string): string {
  return `${nameHash.slice(0, 18)}…`;
}

function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, bound: number): void {
  map.delete(key);
  while (map.size >= bound) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  map.set(key, value);
}

export class ContextGraphNameResolver {
  private readonly entries = new Map<string, ContextGraphNameResolutionEntry>();
  private readonly inflight = new Map<string, Promise<ContextGraphNameResolutionEntry | undefined>>();
  /** `${nameHash}\0${peerId}` -> when the peer was last asked for that hash. */
  private readonly askedAt = new Map<string, number>();
  /** peerId -> until when its ontology graph is not pulled again. */
  private readonly ontologyPullBlockedUntil = new Map<string, number>();
  /** nameHash -> newly identified peers waiting for the in-flight attempt. */
  private readonly queuedPeers = new Map<string, Set<string>>();
  private readonly lifetime = new AbortController();
  private readonly now: () => number;
  private readonly maxPeersPerAttempt: number;
  private readonly maxOntologyPullsPerAttempt: number;
  private readonly peerAskTtlMs: number;
  private readonly ontologyPullCooldownMs: number;
  private readonly ontologyPullFailureCooldownMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerDueAt = Number.POSITIVE_INFINITY;
  private pass: Promise<void> | undefined;
  private passRequested = false;

  constructor(
    private readonly deps: ContextGraphNameResolverDeps,
    options: ContextGraphNameResolverOptions = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.maxPeersPerAttempt = options.maxPeersPerAttempt ?? CONTEXT_GRAPH_NAME_MAX_PEERS_PER_ATTEMPT;
    this.maxOntologyPullsPerAttempt = options.maxOntologyPullsPerAttempt
      ?? CONTEXT_GRAPH_NAME_MAX_ONTOLOGY_PULLS_PER_ATTEMPT;
    this.peerAskTtlMs = options.peerAskTtlMs ?? CONTEXT_GRAPH_NAME_PEER_ASK_TTL_MS;
    this.ontologyPullCooldownMs = options.ontologyPullCooldownMs
      ?? CONTEXT_GRAPH_NAME_ONTOLOGY_PULL_COOLDOWN_MS;
    this.ontologyPullFailureCooldownMs = options.ontologyPullFailureCooldownMs
      ?? CONTEXT_GRAPH_NAME_ONTOLOGY_PULL_FAILURE_COOLDOWN_MS;
    this.retryBaseMs = options.retryBaseMs ?? CONTEXT_GRAPH_NAME_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? CONTEXT_GRAPH_NAME_RETRY_MAX_MS;
  }

  /** Current entry for one name hash (any case). */
  entryFor(nameHash: string): ContextGraphNameResolutionEntry | undefined {
    const normalized = normalizeContextGraphNameHash(nameHash);
    return normalized === null ? undefined : this.entries.get(normalized);
  }

  /** Every remembered entry: pending and private targets, recent resolutions. */
  entriesSnapshot(): readonly ContextGraphNameResolutionEntry[] {
    return [...this.entries.values()];
  }

  /** Run a pass over all targets soon. Idempotent; passes never overlap. */
  request(): void {
    if (this.lifetime.signal.aborted) return;
    this.schedule(0);
  }

  /**
   * A peer's identify record changed. Ask it soon for every pending hash it
   * has not answered recently; old peers are filtered by the deps. A peer
   * that shows up while an attempt runs is queued, not dropped.
   */
  onPeerUpdated(peerId: string): void {
    if (this.lifetime.signal.aborted) return;
    for (const entry of this.entries.values()) {
      if (entry.state !== 'pending') continue;
      let queued = this.queuedPeers.get(entry.nameHash);
      if (queued === undefined) {
        queued = new Set();
        this.queuedPeers.set(entry.nameHash, queued);
      }
      if (queued.size < MAX_QUEUED_PEERS_PER_TARGET) queued.add(peerId);
      this.drainQueuedPeers({ nameHash: entry.nameHash, onChainId: entry.onChainId });
    }
  }

  private drainQueuedPeers(target: ContextGraphNameTarget): void {
    if (this.lifetime.signal.aborted || this.inflight.has(target.nameHash)) return;
    const queued = this.queuedPeers.get(target.nameHash);
    this.queuedPeers.delete(target.nameHash);
    if (queued === undefined || queued.size === 0) return;
    if (this.entries.get(target.nameHash)?.state !== 'pending') return;
    void this.attempt(target, [...queued]).catch(() => undefined);
  }

  /**
   * Resolve one target now, bounded by the caller's signal. The target may be
   * a placeholder the caller is about to subscribe. The attempt itself belongs
   * to the resolver's lifetime, so a caller that stops waiting does not waste
   * the work.
   */
  async resolveNow(
    requested: ContextGraphNameTarget,
    options: { signal?: AbortSignal } = {},
  ): Promise<ContextGraphNameResolutionEntry | undefined> {
    const normalized = normalizeContextGraphNameHash(requested.nameHash);
    if (normalized === null || this.lifetime.signal.aborted) return undefined;
    const target = { nameHash: normalized, onChainId: requested.onChainId };
    const attempt = (async () => {
      // An attempt already in flight may have started before the peers that
      // are connected now: let it finish, then make one fresh attempt. An
      // explicit request also skips the per-peer cooldowns.
      const joined = this.inflight.get(target.nameHash);
      if (joined !== undefined) {
        const entry = await joined.catch(() => undefined);
        if (entry?.state !== 'pending') return entry;
      }
      return this.attempt(target, undefined, { ignoreBackoff: true, ignorePeerCooldowns: true });
    })();
    const signal = options.signal;
    if (signal === undefined) return attempt;
    if (signal.aborted) return this.entries.get(normalized);
    return new Promise((resolve) => {
      const onAbort = () => resolve(this.entries.get(normalized));
      signal.addEventListener('abort', onAbort, { once: true });
      attempt.then(
        (entry) => {
          signal.removeEventListener('abort', onAbort);
          resolve(entry);
        },
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve(this.entries.get(normalized));
        },
      );
    });
  }

  stop(): void {
    this.lifetime.abort(new DOMException('Context Graph name resolver stopped', 'AbortError'));
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    if (this.lifetime.signal.aborted) return;
    const dueAt = this.now() + Math.max(0, delayMs);
    if (this.timer !== undefined && this.timerDueAt <= dueAt) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerDueAt = Number.POSITIVE_INFINITY;
      this.runPass();
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private runPass(): void {
    if (this.pass !== undefined) {
      this.passRequested = true;
      return;
    }
    this.pass = this.passOnce()
      .catch((error: unknown) => {
        this.deps.log.debug(
          `Context Graph name resolution pass failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.pass = undefined;
        if (this.passRequested) {
          this.passRequested = false;
          this.schedule(0);
        } else {
          this.scheduleNextDue();
        }
      });
  }

  private async passOnce(): Promise<void> {
    const targets = this.deps.listTargets();
    const current = new Set(targets.map((target) => target.nameHash));
    // Forget pending/private bookkeeping for rows that went away; resolutions
    // stay (bounded) so status can explain what happened to a hash.
    for (const [nameHash, entry] of this.entries) {
      if (entry.state !== 'resolved' && !current.has(nameHash)) this.entries.delete(nameHash);
    }
    for (const target of targets) {
      if (this.lifetime.signal.aborted) return;
      await this.attempt(target).catch(() => undefined);
    }
  }

  private scheduleNextDue(): void {
    let next = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      if (entry.state === 'pending' && entry.nextAttemptAt !== undefined) {
        next = Math.min(next, entry.nextAttemptAt);
      }
    }
    if (Number.isFinite(next)) this.schedule(next - this.now());
  }

  private attempt(
    target: ContextGraphNameTarget,
    onlyPeers?: readonly string[],
    options: { ignoreBackoff?: boolean; ignorePeerCooldowns?: boolean } = {},
  ): Promise<ContextGraphNameResolutionEntry | undefined> {
    const existing = this.inflight.get(target.nameHash);
    if (existing !== undefined) return existing;
    const entry = this.entries.get(target.nameHash);
    if (entry?.state === 'resolved' || entry?.state === 'private') return Promise.resolve(entry);
    if (
      onlyPeers === undefined
      && options.ignoreBackoff !== true
      && entry?.state === 'pending'
      && entry.nextAttemptAt !== undefined
      && entry.nextAttemptAt > this.now()
    ) {
      return Promise.resolve(entry);
    }
    const run = this.attemptOnce(target, onlyPeers, options.ignorePeerCooldowns === true).finally(() => {
      if (this.inflight.get(target.nameHash) === run) this.inflight.delete(target.nameHash);
      this.drainQueuedPeers(target);
    });
    this.inflight.set(target.nameHash, run);
    return run;
  }

  private async attemptOnce(
    target: ContextGraphNameTarget,
    onlyPeers: readonly string[] | undefined,
    ignorePeerCooldowns = false,
  ): Promise<ContextGraphNameResolutionEntry | undefined> {
    const signal = this.lifetime.signal;
    const previous = this.entries.get(target.nameHash);
    if (!this.deps.isTargetCurrent(target)) return previous;
    if (previous === undefined) {
      this.deps.log.info(
        `Context Graph ${short(target.nameHash)} (on-chain ${target.onChainId}) is known only by its name hash; `
        + 'looking for its cleartext id',
      );
    }

    const policy = await this.deps.classifyPolicy(target, signal).catch(() => 'unknown' as const);
    signal.throwIfAborted();
    if (policy === 'private') {
      const privateEntry: ContextGraphNameResolutionEntry = {
        state: 'private',
        nameHash: target.nameHash,
        onChainId: target.onChainId,
      };
      this.entries.set(target.nameHash, privateEntry);
      return privateEntry;
    }
    if (policy === 'unknown') return this.pending(target, 'policy-unavailable', 0);

    if (onlyPeers === undefined) {
      const local = findVerifiedContextGraphName(
        await this.deps.findLocalCandidates(target, signal).catch(() => []),
        target.nameHash,
      );
      signal.throwIfAborted();
      if (local !== null) return this.adopt(target, local, 'local-store');
    }

    // Peers asked (or pulled) recently are skipped without consuming the
    // per-attempt budget, so successive attempts walk past the first few.
    const peers = onlyPeers ?? this.deps.listPeers();
    let supporting = 0;
    let asks = 0;
    for (const peerId of peers) {
      if (asks >= this.maxPeersPerAttempt) break;
      signal.throwIfAborted();
      if (!this.deps.isTargetCurrent(target)) return this.entries.get(target.nameHash);
      const supports = await this.deps.peerSupportsNameProtocol(peerId).catch(() => undefined);
      if (supports !== true) continue;
      supporting += 1;
      const askKey = `${target.nameHash}\u0000${peerId}`;
      const askedAt = this.askedAt.get(askKey);
      if (!ignorePeerCooldowns && askedAt !== undefined && this.now() - askedAt < this.peerAskTtlMs) continue;
      rememberBounded(this.askedAt, askKey, this.now(), MAX_REMEMBERED_ASKS);
      asks += 1;
      const answer = await this.deps.askPeer(peerId, target, signal).catch(() => null);
      signal.throwIfAborted();
      const verified = verifyContextGraphNameCandidate(answer, target.nameHash);
      if (verified !== null) return this.adopt(target, verified, 'peer-protocol', peerId);
      if (answer !== null) {
        // Never echo an unverified value: it may be attacker-chosen.
        this.deps.log.debug(
          `Peer ${peerId.slice(-8)} answered ${short(target.nameHash)} with an id that does not match the name hash`,
        );
      }
    }

    let pulls = 0;
    for (const peerId of peers) {
      if (pulls >= this.maxOntologyPullsPerAttempt) break;
      signal.throwIfAborted();
      if (!this.deps.isTargetCurrent(target)) return this.entries.get(target.nameHash);
      const blockedUntil = this.ontologyPullBlockedUntil.get(peerId);
      if (!ignorePeerCooldowns && blockedUntil !== undefined && this.now() < blockedUntil) continue;
      pulls += 1;
      const pending = this.pendingNameHashes(target.nameHash);
      const candidates = await this.deps.pullPeerOntology(peerId, pending, signal).catch(() => null);
      // A pull cut short by shutdown leaves no cooldown behind.
      signal.throwIfAborted();
      // A completed scan rests the peer for the full cooldown; a failed one
      // only briefly, so frequent identify updates cannot hammer it.
      rememberBounded(
        this.ontologyPullBlockedUntil,
        peerId,
        this.now() + (candidates === null ? this.ontologyPullFailureCooldownMs : this.ontologyPullCooldownMs),
        MAX_REMEMBERED_ASKS,
      );
      if (candidates === null) continue;
      let adoptedHere: ContextGraphNameResolutionEntry | undefined;
      for (const nameHash of pending) {
        const verified = verifyContextGraphNameCandidate(candidates.get(nameHash), nameHash);
        if (verified === null) continue;
        const pendingTarget = nameHash === target.nameHash
          ? target
          : this.targetFor(nameHash);
        if (pendingTarget === undefined) continue;
        const adopted = await this.adopt(pendingTarget, verified, 'peer-ontology', peerId);
        if (nameHash === target.nameHash) adoptedHere = adopted;
      }
      if (adoptedHere?.state === 'resolved') return adoptedHere;
    }

    return this.pending(target, peers.length === 0 ? 'no-peers' : 'not-found', supporting);
  }

  /** The current hash and every other pending hash: one pull serves all. */
  private pendingNameHashes(primary: string): string[] {
    const hashes = new Set<string>([primary]);
    for (const entry of this.entries.values()) {
      if (entry.state === 'pending') hashes.add(entry.nameHash);
    }
    return [...hashes];
  }

  private targetFor(nameHash: string): ContextGraphNameTarget | undefined {
    const entry = this.entries.get(nameHash);
    return entry?.state === 'pending'
      ? { nameHash: entry.nameHash, onChainId: entry.onChainId }
      : undefined;
  }

  private async adopt(
    target: ContextGraphNameTarget,
    contextGraphId: string,
    source: ContextGraphNameSource,
    peerId?: string,
  ): Promise<ContextGraphNameResolutionEntry | undefined> {
    const adopted = await this.deps.adopt(target, contextGraphId, source);
    if (!adopted) return this.entries.get(target.nameHash);
    const entry: ContextGraphNameResolutionEntry = {
      state: 'resolved',
      nameHash: target.nameHash,
      onChainId: target.onChainId,
      contextGraphId,
      source,
      resolvedAt: this.now(),
    };
    this.entries.delete(target.nameHash);
    let resolvedCount = 0;
    for (const existing of this.entries.values()) if (existing.state === 'resolved') resolvedCount += 1;
    if (resolvedCount >= MAX_REMEMBERED_RESOLUTIONS) {
      for (const [key, existing] of this.entries) {
        if (existing.state === 'resolved') {
          this.entries.delete(key);
          break;
        }
      }
    }
    this.entries.set(target.nameHash, entry);
    this.deps.log.info(
      `Resolved Context Graph name hash ${short(target.nameHash)} to "${contextGraphId}" `
      + `(source ${source}${peerId === undefined ? '' : `, peer ${peerId.slice(-8)}`})`,
    );
    return entry;
  }

  private pending(
    target: ContextGraphNameTarget,
    outcome: ContextGraphNamePendingOutcome,
    peersSupportingProtocol: number,
  ): ContextGraphNameResolutionEntry {
    const previous = this.entries.get(target.nameHash);
    const attempts = (previous?.state === 'pending' ? previous.attempts : 0) + 1;
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(attempts - 1, 16));
    const now = this.now();
    const entry: ContextGraphNameResolutionEntry = {
      state: 'pending',
      nameHash: target.nameHash,
      onChainId: target.onChainId,
      attempts,
      lastOutcome: outcome,
      lastAttemptAt: now,
      nextAttemptAt: now + delay,
      peersSupportingProtocol,
    };
    this.entries.set(target.nameHash, entry);
    this.deps.log.debug(
      `Context Graph ${short(target.nameHash)} still has no verified cleartext id `
      + `(${outcome}, attempt ${attempts}); retrying in ${Math.round(delay / 1000)}s`,
    );
    this.schedule(delay);
    return entry;
  }
}
