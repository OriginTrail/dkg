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

import { rememberBounded } from './bounded-map.js';
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
  | 'not-found'
  /** The attempt threw (an adoption that failed midway, say); retried with backoff. */
  | 'attempt-failed';

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
  }
  | {
    /**
     * A verified cleartext id was found, but the adoption hook refused it
     * while the row still wanted one (on the agent: this node already binds
     * that id to a different on-chain graph). Not re-attempted while the
     * refusal holds; a background pass re-attempts once it no longer does,
     * and an explicit request checks at once.
     */
    readonly state: 'declined';
    readonly nameHash: string;
    readonly onChainId: string;
    readonly contextGraphId: string;
    readonly source: ContextGraphNameSource;
    readonly declinedAt: number;
    /** When a background pass next checks (cheaply) whether the refusal still holds. */
    readonly nextCheckAt: number;
  };

export interface ContextGraphNameResolverDeps {
  /** Hash-only rows that currently want a cleartext id. */
  listTargets(): readonly ContextGraphNameTarget[];
  /**
   * Re-checked after every await: is this still a hash-only row? A
   * synchronous in-memory check that is not expected to throw; the resolver
   * still guards every call the same way (see `isCurrent`).
   */
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
  /**
   * Promote the row. False when the adoption was declined: either the row
   * changed under the attempt, or the adopter refuses this id for the row
   * as it stands (a binding conflict).
   */
  adopt(target: ContextGraphNameTarget, contextGraphId: string, source: ContextGraphNameSource): Promise<boolean>;
  /**
   * Would `adopt` still refuse this id for this row? A cheap synchronous
   * check of the refusal's cause (on the agent: the cleartext row is still
   * bound to another on-chain id). Not expected to throw.
   */
  isRefusalCurrent(target: ContextGraphNameTarget, contextGraphId: string): boolean;
  readonly log: {
    info(message: string): void;
    debug(message: string): void;
    warn(message: string): void;
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
  /** A failure is logged at warn at most once per this interval per hash (debug otherwise). */
  readonly failureWarnIntervalMs?: number;
}

const CONTEXT_GRAPH_NAME_MAX_PEERS_PER_ATTEMPT = 8;
const CONTEXT_GRAPH_NAME_MAX_ONTOLOGY_PULLS_PER_ATTEMPT = 2;
const CONTEXT_GRAPH_NAME_PEER_ASK_TTL_MS = 10 * 60_000;
const CONTEXT_GRAPH_NAME_ONTOLOGY_PULL_COOLDOWN_MS = 30 * 60_000;
const CONTEXT_GRAPH_NAME_ONTOLOGY_PULL_FAILURE_COOLDOWN_MS = 2 * 60_000;
const CONTEXT_GRAPH_NAME_RETRY_BASE_MS = 30_000;
const CONTEXT_GRAPH_NAME_RETRY_MAX_MS = 10 * 60_000;
const CONTEXT_GRAPH_NAME_FAILURE_WARN_INTERVAL_MS = 30 * 60_000;
/** Bounds on remembered state; oldest entries are evicted first. */
const MAX_REMEMBERED_ASKS = 4_096;
const MAX_REMEMBERED_RESOLUTIONS = 256;
const MAX_QUEUED_PEERS_PER_TARGET = 64;
const MAX_REMEMBERED_FAILURE_WARNINGS = 256;

function short(nameHash: string): string {
  return `${nameHash.slice(0, 18)}…`;
}

/** The error's class and message (`TypeError: x is not a function`), or the thrown value. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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
  /** failure kind + name hash -> when a failure of that kind last went out at warn. */
  private readonly failureWarnedAt = new Map<string, number>();
  private readonly lifetime = new AbortController();
  private readonly now: () => number;
  private readonly maxPeersPerAttempt: number;
  private readonly maxOntologyPullsPerAttempt: number;
  private readonly peerAskTtlMs: number;
  private readonly ontologyPullCooldownMs: number;
  private readonly ontologyPullFailureCooldownMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly failureWarnIntervalMs: number;
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
    this.failureWarnIntervalMs = options.failureWarnIntervalMs ?? CONTEXT_GRAPH_NAME_FAILURE_WARN_INTERVAL_MS;
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
        this.reportFailure('pass', `Context Graph name resolution pass failed: ${describeError(error)}`);
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
      } else if (entry.state === 'declined') {
        next = Math.min(next, entry.nextCheckAt);
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
    // A declined adoption is declined again for as long as its cause holds,
    // so a background pass only checks that cause (cheaply, no scan, no log).
    // Once it is gone, the pass adopts the id the entry already verified: its
    // source may be gone (a peer that disconnected, an ontology graph scanned
    // in memory), and the hash has no other preimage to find. Refused again,
    // it is declined again. An explicit request (the operator subscribing
    // again) re-attempts at once. The refusal belongs to the binding it
    // refused; a row re-bound to another slot is a new question.
    if (
      entry?.state === 'declined'
      && entry.onChainId === target.onChainId
      && options.ignoreBackoff !== true
    ) {
      if (this.refusalHolds(target, entry.contextGraphId)) {
        if (entry.nextCheckAt > this.now()) return Promise.resolve(entry);
        const rechecked: ContextGraphNameResolutionEntry = { ...entry, nextCheckAt: this.now() + this.retryMaxMs };
        this.entries.set(target.nameHash, rechecked);
        return Promise.resolve(rechecked);
      }
      return this.track(target, this.adopt(target, entry.contextGraphId, entry.source));
    }
    if (
      onlyPeers === undefined
      && options.ignoreBackoff !== true
      && entry?.state === 'pending'
      && entry.nextAttemptAt !== undefined
      && entry.nextAttemptAt > this.now()
    ) {
      return Promise.resolve(entry);
    }
    return this.track(target, this.attemptOnce(target, onlyPeers, options.ignorePeerCooldowns === true));
  }

  /** Run one attempt as this hash's in-flight attempt; a failure stays on the retry schedule. */
  private track(
    target: ContextGraphNameTarget,
    work: Promise<ContextGraphNameResolutionEntry | undefined>,
  ): Promise<ContextGraphNameResolutionEntry | undefined> {
    const run = work
      .catch((error: unknown) => this.failedAttempt(target, error))
      .finally(() => {
        if (this.inflight.get(target.nameHash) === run) this.inflight.delete(target.nameHash);
        this.drainQueuedPeers(target);
      });
    this.inflight.set(target.nameHash, run);
    return run;
  }

  /**
   * An attempt that throws (an adoption that failed midway, a dependency
   * that is restarting) must still leave the hash on the retry schedule:
   * retries are driven only by pending entries, so without one nothing would
   * ever attempt this hash again. Shutdown is the one failure not retried.
   * Whatever threw, it is reported (see `reportFailure`), so a defect cannot
   * pass for "not found yet".
   */
  private failedAttempt(target: ContextGraphNameTarget, error: unknown): ContextGraphNameResolutionEntry | undefined {
    if (this.lifetime.signal.aborted) throw error;
    this.reportFailure(
      `attempt\u0000${target.nameHash}`,
      `Context Graph ${short(target.nameHash)} name resolution attempt failed (retrying with backoff): `
      + describeError(error),
    );
    return this.pendingIfCurrent(target, 'attempt-failed');
  }

  /**
   * Every failure goes out at warn, at most once per interval for the same
   * kind and hash; repeats in between go to debug. The class of the error
   * says nothing reliable about its cause (a peer payload fails `JSON.parse`
   * with a SyntaxError, a defect can throw a plain Error), so none is
   * singled out: a persistent failure stays visible without flooding the log.
   */
  private reportFailure(key: string, message: string): void {
    const now = this.now();
    const warnedAt = this.failureWarnedAt.get(key);
    if (warnedAt !== undefined && now - warnedAt < this.failureWarnIntervalMs) {
      this.deps.log.debug(message);
      return;
    }
    rememberBounded(this.failureWarnedAt, key, now, MAX_REMEMBERED_FAILURE_WARNINGS);
    this.deps.log.warn(message);
  }

  /** Schedule a retry while the row still wants a cleartext id. */
  private pendingIfCurrent(
    target: ContextGraphNameTarget,
    outcome: ContextGraphNamePendingOutcome,
  ): ContextGraphNameResolutionEntry | undefined {
    return this.isCurrent(target) ? this.pending(target, outcome, 0) : this.entries.get(target.nameHash);
  }

  /** Guarded like `isCurrent`; a throw keeps the refusal (no retry loop). */
  private refusalHolds(target: ContextGraphNameTarget, contextGraphId: string): boolean {
    try {
      return this.deps.isRefusalCurrent(target, contextGraphId);
    } catch (error: unknown) {
      this.reportFailure(
        `refusal-check\u0000${target.nameHash}`,
        `Context Graph ${short(target.nameHash)} refusal check failed; keeping the refusal: ${describeError(error)}`,
      );
      return true;
    }
  }

  /**
   * Every `isTargetCurrent` call goes through here. A throw is reported and
   * read as "still current", since unknown is not gone. That keeps the hash
   * on the retry schedule, and nothing is changed on the strength of it: the
   * adoption hook re-validates the row itself.
   */
  private isCurrent(target: ContextGraphNameTarget): boolean {
    try {
      return this.deps.isTargetCurrent(target);
    } catch (error: unknown) {
      this.reportFailure(
        `row-check\u0000${target.nameHash}`,
        `Context Graph ${short(target.nameHash)} row check failed; treating the row as still wanting `
        + `a cleartext id: ${describeError(error)}`,
      );
      return true;
    }
  }

  private async attemptOnce(
    target: ContextGraphNameTarget,
    onlyPeers: readonly string[] | undefined,
    ignorePeerCooldowns = false,
  ): Promise<ContextGraphNameResolutionEntry | undefined> {
    const signal = this.lifetime.signal;
    const previous = this.entries.get(target.nameHash);
    if (!this.isCurrent(target)) return previous;
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
      if (!this.isCurrent(target)) return this.entries.get(target.nameHash);
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
      if (!this.isCurrent(target)) return this.entries.get(target.nameHash);
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
      // Like the other sources: once this target's own adoption has settled
      // (resolved, declined, or the row changed under it), the attempt is
      // over. Parking it as pending would re-schedule a decline forever.
      let ownAdoptionSettled = false;
      let ownAdoption: ContextGraphNameResolutionEntry | undefined;
      for (const nameHash of pending) {
        const verified = verifyContextGraphNameCandidate(candidates.get(nameHash), nameHash);
        if (verified === null) continue;
        const pendingTarget = nameHash === target.nameHash
          ? target
          : this.targetFor(nameHash);
        if (pendingTarget === undefined) continue;
        const adopted = await this.adopt(pendingTarget, verified, 'peer-ontology', peerId);
        if (nameHash === target.nameHash) {
          ownAdoptionSettled = true;
          ownAdoption = adopted;
        }
      }
      if (ownAdoptionSettled) return ownAdoption;
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
    if (!adopted) return this.declined(target, contextGraphId, source);
    const entry: ContextGraphNameResolutionEntry = {
      state: 'resolved',
      nameHash: target.nameHash,
      onChainId: target.onChainId,
      contextGraphId,
      source,
      resolvedAt: this.now(),
    };
    this.entries.delete(target.nameHash);
    // Unlike rememberBounded, only resolutions count toward this bound:
    // pending and private entries are already bounded by the live targets.
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

  /**
   * The adoption hook refused a verified id. A row that changed under the
   * attempt (went away, or was re-bound) records nothing; the next pass
   * sees it as it is now. A row that still wants an id was refused for the
   * id itself, and that id is the hash's only preimage, so every source
   * would offer it again and every retry would repeat the refusal while
   * its cause holds: it is recorded as declined, and background passes only
   * check the cause until it is gone (see `attempt`).
   */
  private declined(
    target: ContextGraphNameTarget,
    contextGraphId: string,
    source: ContextGraphNameSource,
  ): ContextGraphNameResolutionEntry | undefined {
    if (!this.isCurrent(target)) return this.entries.get(target.nameHash);
    const entry: ContextGraphNameResolutionEntry = {
      state: 'declined',
      nameHash: target.nameHash,
      onChainId: target.onChainId,
      contextGraphId,
      source,
      declinedAt: this.now(),
      nextCheckAt: this.now() + this.retryMaxMs,
    };
    this.entries.set(target.nameHash, entry);
    this.deps.log.info(
      `Context Graph ${short(target.nameHash)}: the verified cleartext id was not adopted; `
      + 're-attempted once the refusal no longer holds (subscribing again checks at once)',
    );
    this.schedule(this.retryMaxMs);
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
