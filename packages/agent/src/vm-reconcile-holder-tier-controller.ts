// SPDX-License-Identifier: Apache-2.0

/**
 * The holder tier's per-graph state and lifecycle: one remembered holder set per
 * public graph, the policy gate that decides whether a graph has a tier at all,
 * and the operations the SWM host forwards (refresh, a phonebook arrival, a
 * removed graph, pruning, shutdown), each of which keeps the graph entries and
 * the shared resolver in step. Also the pure pieces of that state model: the
 * entry transition and the roster append.
 */

import {
  VM_HOLDER_TIER_FAILURE_RETRY_MS,
  VM_HOLDER_TIER_POLICY_TIMEOUT_MS,
  VM_HOLDER_TIER_RESOLUTION_TTL_MS,
  VM_HOLDER_TIER_STALE_MAX_MS,
  type VmHolderHintDeps,
  type VmHolderHintResolution,
} from './vm-reconcile-holder-tier-types.js';
import {
  VmHolderHintResolver,
  cutShort,
  runWithinDeadline,
  type VmHolderHintResolverOptions,
} from './vm-reconcile-holder-tier-resolver.js';

/**
 * One graph's remembered holder set: what its roster reads synchronously.
 * `peerIds` is empty for a graph that is not public or has no hinted holder.
 */
export interface VmHolderTierEntry {
  readonly peerIds: readonly string[];
  /** When `peerIds` was last resolved from the chain and phonebook. */
  readonly resolvedAt: number;
  /** Earliest time the next refresh may read again. */
  readonly nextCheckAt: number;
}

/** What one refresh learned about a graph's holder tier. */
export type VmHolderTierOutcome =
  | VmHolderHintResolution
  | { readonly kind: 'not-public' };

/**
 * Decide a graph's next entry from a refresh outcome.
 *
 * - resolved: replace the entry (an empty set is a real, cacheable answer); one
 *   cut short by the lookup bound is re-read on the failure spacing instead;
 * - not-public: an empty set, re-checked at the normal cadence;
 * - unavailable: keep a previous non-empty set for a bounded time so a chain
 *   blip does not remove and re-add holders, which would restart the proof
 *   cycle of every target on the graph; otherwise none. Either way the next
 *   read waits the shorter failure spacing.
 */
export function nextVmHolderTierEntry(
  previous: VmHolderTierEntry | undefined,
  outcome: VmHolderTierOutcome,
  now: number,
): VmHolderTierEntry {
  if (outcome.kind === 'resolved') {
    return {
      peerIds: outcome.peerIds,
      resolvedAt: now,
      nextCheckAt: now + (cutShort(outcome)
        ? VM_HOLDER_TIER_FAILURE_RETRY_MS
        : VM_HOLDER_TIER_RESOLUTION_TTL_MS),
    };
  }
  if (outcome.kind === 'not-public') {
    return { peerIds: [], resolvedAt: now, nextCheckAt: now + VM_HOLDER_TIER_RESOLUTION_TTL_MS };
  }
  const nextCheckAt = now + VM_HOLDER_TIER_FAILURE_RETRY_MS;
  if (
    previous !== undefined
    && previous.peerIds.length > 0
    && now - previous.resolvedAt < VM_HOLDER_TIER_STALE_MAX_MS
  ) {
    // Staleness is measured from the last resolution that actually read the
    // chain, so an outage cannot keep a set alive indefinitely.
    return { ...previous, nextCheckAt };
  }
  return { peerIds: [], resolvedAt: now, nextCheckAt };
}

/** Same members, ignoring order. */
export function sameVmHolderPeerIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const members = new Set(left);
  return right.every((peerId) => members.has(peerId));
}

/**
 * Append the holder tier behind an already-composed roster (curators, then
 * connected peers). The existing tiers keep their members, order and caps
 * byte for byte: hinted peers only ever fill capacity those tiers left free,
 * are deduplicated against them and never include this node.
 */
export function appendVmHolderTier(
  roster: readonly string[],
  holderPeerIds: readonly string[],
  selfPeerId: string,
  maxRoster: number,
): string[] {
  const budget = Math.max(0, maxRoster - roster.length);
  if (budget === 0 || holderPeerIds.length === 0) return [...roster];
  const taken = new Set(roster);
  const holders: string[] = [];
  for (const peerId of holderPeerIds) {
    if (holders.length >= budget) break;
    if (peerId === selfPeerId || taken.has(peerId)) continue;
    taken.add(peerId);
    holders.push(peerId);
  }
  return [...roster, ...holders];
}

/** The graph's public-policy fact: whether hint-derived peers may be asked about it. */
export type VmHolderGraphPolicy = 'public' | 'not-public' | 'unknown';

export interface VmHolderTierControllerDeps {
  /** Whether the tier is on for this agent right now; asked again on every refresh. */
  enabled(): boolean;
  /**
   * The graph's public-policy fact. Read inside the policy deadline: a read that
   * rejects, returns anything else or outlives the deadline is `unknown`.
   */
  readPolicy(localCgId: string, signal: AbortSignal): Promise<VmHolderGraphPolicy>;
  /**
   * What every resolution reads. Its `now` also clocks the per-graph entries, so
   * one clock decides every cadence.
   */
  readonly hints: VmHolderHintDeps;
  /** One operator-visible line (info level). */
  log(message: string): void;
  readonly resolver?: VmHolderHintResolverOptions;
  readonly policyTimeoutMs?: number;
}

/**
 * Owns the holder tier's whole state and lifecycle for one node: the shared
 * resolver (the hints cache) and every graph's remembered entry. The SWM host
 * asks it to refresh a graph, reads a graph's peers, and forwards the lifecycle
 * events (a phonebook arrival, a graph's state being removed, a bound on the
 * per-graph state, shutdown) to the operation that keeps BOTH caches in step:
 *
 * | operation          | graph entries               | shared hints (answer, walk, carried) |
 * | ------------------ | --------------------------- | ------------------------------------ |
 * | `refresh`          | writes this graph's entry   | reads / fills / advances the walk    |
 * | `invalidateHints`  | drops the affected graphs'  | answer forgotten, walk kept: rows behind it are read when it wraps (a read still running can no longer move it) |
 * | `deleteGraph`      | drops this graph's          | kept (graph-independent)             |
 * | `prune`            | drops the oldest over a bound | kept                               |
 * | `close`            | drops all                   | all forgotten, the walk starts over  |
 *
 * The state model is explicit: every expected failure of a dependency is an
 * outcome (`unavailable`) at the boundary where it happens, so an entry only
 * ever moves through {@link nextVmHolderTierEntry}. A caller abort writes
 * nothing; anything else is a defect and rejects.
 */
export class VmHolderTierController {
  readonly #deps: VmHolderTierControllerDeps;
  /** Insertion order is recency: a refreshed graph moves to the end, `prune` evicts from the front. */
  readonly #entries = new Map<string, VmHolderTierEntry>();
  #resolver: VmHolderHintResolver | undefined;

  constructor(deps: VmHolderTierControllerDeps) {
    this.#deps = deps;
  }

  /** The graph's hinted holders: what its roster reads synchronously. Empty until a refresh says otherwise. */
  peerIdsFor(localCgId: string): readonly string[] {
    return this.#entries.get(localCgId)?.peerIds ?? [];
  }

  /** The graph's remembered entry: when it was resolved and when it is next due. */
  entryFor(localCgId: string): VmHolderTierEntry | undefined {
    return this.#entries.get(localCgId);
  }

  /**
   * Refresh one graph's entry when it is due. Advisory and bounded: each time the
   * entry is due it reads the graph's public policy (one bounded authority read,
   * capped at the policy deadline, for every graph separately and outside the
   * shared resolver's bounds), then takes the shared resolution (cached by the
   * resolver for every graph) and writes only this graph's entry, so no other
   * graph's roster moves. An entry is due again five minutes after a complete
   * resolution or a private graph, and a minute after a resolution that was cut
   * short or unavailable or a policy that is unknown. A private graph gets an
   * empty tier (hint-derived peers are never asked about it).
   */
  async refresh(
    localCgId: string,
    options: { signal?: AbortSignal; isCurrent: () => boolean },
  ): Promise<void> {
    const { signal, isCurrent } = options;
    const now = this.#deps.hints.now ?? Date.now;
    if (!this.#deps.enabled()) {
      this.#entries.delete(localCgId);
      return;
    }
    const previous = this.#entries.get(localCgId);
    if (previous !== undefined && now() < previous.nextCheckAt) return;

    const policy = await this.#readPolicy(localCgId, signal);
    if (policy === 'caller-aborted' || !isCurrent()) return;

    let outcome: VmHolderTierOutcome;
    if (policy === 'public') {
      const resolver = this.#resolverForUse();
      const hintGeneration = resolver.generation;
      try {
        outcome = await resolver.resolve(signal);
      } catch (error) {
        // `resolve` reports its dependency failures as outcomes and rejects only
        // for this caller's own abort; anything else is a defect and surfaces.
        if (signal?.aborted === true) return;
        throw error;
      }
      // The hints were invalidated while this read was in flight: what it read
      // may predate the profile that invalidated them, and that arrival already
      // dropped this graph's entry and asked for a recovery. Remembering the
      // older answer would hide the new holder for a full period, so the next
      // pass asks for a new resolution instead (which resumes where the walk
      // stands: a row the walk has already passed is read when it wraps).
      if (resolver.generation !== hintGeneration) return;
    } else {
      outcome = policy === 'not-public'
        ? { kind: 'not-public' }
        : { kind: 'unavailable', reason: 'policy-unknown' };
    }
    if (!isCurrent()) return;

    const next = nextVmHolderTierEntry(previous, outcome, now());
    this.#entries.delete(localCgId);
    this.#entries.set(localCgId, next);
    if (outcome.kind === 'resolved' && !sameVmHolderPeerIds(previous?.peerIds ?? [], next.peerIds)) {
      const { stats } = outcome;
      this.#deps.log(
        `VM exact fetch holder tier for "${localCgId}": ${next.peerIds.length} hinted `
          + `ShardingTable holder(s) [peers=${next.peerIds.map((peerId) => peerId.slice(-8)).join(',')}] `
          + `across ${stats.identities} identit${stats.identities === 1 ? 'y' : 'ies'} `
          + `(profiles=${stats.profiles} unbound=${stats.unbound} `
          + `unmatched=${stats.unmatched} pages=${stats.pages} `
          + `lookups=${stats.lookups} stop=${stats.stopped}); `
          + 'routing hints only, data is still verified against on-chain roots',
      );
    }
  }

  /**
   * The phonebook gained profiles (the host calls this when the Edge's on-demand
   * `agents` phonebook fetch resolved curators): the shared resolution is stale
   * for every graph, and the listed graphs (the ones with a recovery to re-run)
   * forget their entries, so the first of them to run again asks for a new
   * resolution.
   * That resolution resumes where the walk stands (see
   * {@link VmHolderHintResolver.invalidate}): a profile that arrives or changes in
   * rows the walk has already passed is read when the walk wraps, up to one pass
   * later.
   */
  invalidateHints(affectedGraphs: readonly string[]): void {
    this.#resolver?.invalidate();
    for (const localCgId of affectedGraphs) this.#entries.delete(localCgId);
  }

  /** A graph's recovery state is being removed. The shared hints do not depend on it and stay. */
  deleteGraph(localCgId: string): void {
    this.#entries.delete(localCgId);
  }

  /** Keep at most `maxEntries` graphs, dropping the least recently refreshed. The shared hints stay. */
  prune(maxEntries: number): void {
    while (this.#entries.size > maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  /** Shutdown: forget every graph's entry and the shared resolution together. */
  close(): void {
    this.#entries.clear();
    this.#resolver?.reset();
  }

  #resolverForUse(): VmHolderHintResolver {
    this.#resolver ??= new VmHolderHintResolver(this.#deps.hints, this.#deps.resolver);
    return this.#resolver;
  }

  /**
   * The graph's public-policy fact, read at the boundary where it can fail:
   * a read that rejects, answers something else or outlives its bound (even one
   * that ignores its signal) is `unknown`. Only the caller's own abort is
   * reported apart, because it is not a fact about the graph.
   */
  async #readPolicy(
    localCgId: string,
    signal: AbortSignal | undefined,
  ): Promise<VmHolderGraphPolicy | 'caller-aborted'> {
    try {
      const read = await runWithinDeadline(
        (policySignal) => this.#deps.readPolicy(
          localCgId,
          signal === undefined ? policySignal : AbortSignal.any([signal, policySignal]),
        ),
        this.#deps.policyTimeoutMs ?? VM_HOLDER_TIER_POLICY_TIMEOUT_MS,
      );
      return read.kind === 'settled' && (read.value === 'public' || read.value === 'not-public')
        ? read.value
        : 'unknown';
    } catch {
      return signal?.aborted === true ? 'caller-aborted' : 'unknown';
    }
  }
}
