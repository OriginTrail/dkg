// SPDX-License-Identifier: Apache-2.0

/**
 * On-demand, bounded fetch of the `agents` phonebook for nodes that do not
 * sync it on every connect (Edge nodes by default).
 *
 * VM exact recovery ranks a wallet-scoped Context Graph's holders through its
 * curator tier: owner wallet -> `agents` profile -> peer id plus the relay or
 * circuit addresses the profile advertises. An Edge keeps no durable copy of
 * the phonebook by default (`resolveAutomaticSystemContextGraphSync`), so for
 * a public graph whose only holder is the publisher's own Edge that tier is
 * empty and recovery asks only the peers it already happens to be connected
 * to. This module fetches the phonebook once, when a public graph actually
 * needs it, instead of making every Edge sync it on every connect.
 *
 * Bounds, all per process:
 *  - at most one fetch in flight; concurrent requests join it;
 *  - one fetch tries at most `maxPeers` connected, network-admitted peers
 *    (known Cores first) inside one shared wall-clock budget;
 *  - a cooldown after every fetch that reached a peer, longer after one that
 *    obtained data than after one that failed;
 *  - a graph whose curator a complete Core phonebook did not contain stops
 *    asking for hours (live `agents` gossip still delivers later profiles);
 *    an empty or near-empty "complete" answer does not count as one;
 *  - finding no usable peer starts no cooldown, and its re-check is bounded.
 *
 * Only wallet-scoped (`0x<wallet>/<slug>`) graphs whose on-chain access policy
 * is public can trigger a fetch: the phonebook feeds the curator tier only
 * through the owner wallet, and curated graphs are never resolved through it.
 */

import { getMetrics, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { parseBooleanEnv } from './agents-meta-policy.js';
import {
  resolveAutomaticSystemContextGraphSync,
  type AutomaticSystemContextGraphSyncOptions,
} from './system-context-graph-policy.js';

/** What asked for the phonebook. A closed set: it is also a metric label. */
export type AgentsPhonebookFetchTrigger = 'subscribe' | 'startup' | 'vm-reconcile';

export type AgentsPhonebookAccessPolicy = 'public' | 'not-public' | 'unknown';

export interface OnDemandAgentsPhonebookPolicyOptions extends AutomaticSystemContextGraphSyncOptions {
  /** `DKGAgentConfig.onDemandAgentsPhonebook`. */
  onDemandConfigValue?: boolean;
  /** `DKG_ON_DEMAND_AGENTS_PHONEBOOK`. */
  onDemandEnvValue?: string;
}

/**
 * Whether this node may fetch the phonebook on demand.
 *
 * A node that already syncs the system graphs on every connect (Cores by
 * default, or `DKG_SYNC_SYSTEM_CONTEXT_GRAPHS_ON_CONNECT=1`) has nothing to
 * fetch. Otherwise the kill switch follows the same precedence as that flag:
 * the environment wins over config, and the default is on.
 */
export function resolveOnDemandAgentsPhonebookFetch(
  options: OnDemandAgentsPhonebookPolicyOptions,
): boolean {
  if (resolveAutomaticSystemContextGraphSync(options)) return false;
  const envValue = parseBooleanEnv(options.onDemandEnvValue);
  if (envValue !== undefined) return envValue;
  return options.onDemandConfigValue ?? true;
}

/**
 * Minimum spacing between fetches that obtained data. A full fetch is one
 * durable sync of the whole `agents` graph (~75k triples, ~24 s from one Core
 * on Base mainnet in September 2026). Profiles are re-published every 20
 * minutes and arrive over live `agents` gossip while the node is online, so a
 * phonebook fetched less than 30 minutes ago is not meaningfully stale; this
 * caps the worst case at two full fetches per hour per node.
 */
export const AGENTS_PHONEBOOK_FETCH_COOLDOWN_MS = 30 * 60_000;
/** Spacing after a fetch that reached peers but obtained nothing. */
export const AGENTS_PHONEBOOK_FETCH_FAILURE_COOLDOWN_MS = 10 * 60_000;
/** Wall-clock budget one fetch shares across every peer it tries. */
export const AGENTS_PHONEBOOK_FETCH_BUDGET_MS = 120_000;
/** Peers one fetch may transfer from. */
export const AGENTS_PHONEBOOK_FETCH_MAX_PEERS = 3;
/** Connected peers one fetch may examine (admission and protocol checks). */
export const AGENTS_PHONEBOOK_FETCH_MAX_CANDIDATES = 8;
/**
 * How long a graph stops asking after a complete Core phonebook did not
 * contain its curator. Fetching the same phonebook again cannot add a profile
 * that live gossip has not already delivered.
 */
export const AGENTS_PHONEBOOK_CURATOR_MISS_SUPPRESSION_MS = 6 * 60 * 60_000;
/**
 * Triples a known Core's complete answer must carry before it counts as the
 * network's phonebook: before it ends the peer walk or earns a graph the
 * miss suppression above. "Known Core" only means the peer advertises the
 * storage-ACK protocol, and a just-started Core, one with a reset store, or
 * one that does not sync `agents` answers a full scan as complete with no
 * rows, or with little more than its own profile. Base mainnet's phonebook
 * was 75,141 triples (about 39 per profile), so this is roughly 25 profiles.
 */
export const AGENTS_PHONEBOOK_MIN_NETWORK_TRIPLES = 1_000;
/** Re-check cadence while wanted graphs wait for a first usable peer. */
export const AGENTS_PHONEBOOK_NO_PEER_RETRY_MS = 30_000;
/** Consecutive no-peer re-checks before waiting for the next trigger. */
export const AGENTS_PHONEBOOK_NO_PEER_MAX_RETRIES = 20;
/** Reuse window for an on-chain access-policy answer. */
export const AGENTS_PHONEBOOK_POLICY_VERDICT_TTL_MS = 30 * 60_000;
/** Bound for every per-graph map this module keeps. */
export const AGENTS_PHONEBOOK_STATE_MAX_ENTRIES = 1_024;
/**
 * New dials one catch-up connection-priming walk may attempt on a node in
 * on-demand mode. Such a node ends up holding every relay-advertising profile
 * (1,910 on Base mainnet in September 2026), and the unbounded walk dialled
 * 150-500 relay circuits per minute there, against about 6 per minute on an
 * Edge without the phonebook. Catch-up peers still come from admitted
 * connections and the curator tier.
 */
export const AGENTS_PHONEBOOK_PRIME_MAX_DIALS = 8;

export interface AgentsPhonebookCandidatePeer {
  readonly peerId: string;
  /** A known Core; Cores hold the complete phonebook. */
  readonly core: boolean;
}

export interface AgentsPhonebookPeerSyncResult {
  readonly fetchedTriples: number;
  readonly insertedTriples: number;
  /** Every requested graph reached a verified terminal state. */
  readonly complete: boolean;
}

export interface OnDemandAgentsPhonebookDeps {
  /** Kill switch, role policy and runtime state; read on every request. */
  isEnabled(): boolean;
  /**
   * Owner wallet of a wallet-scoped graph this node does not curate itself,
   * otherwise null. Synchronous and O(1): it runs on the subscribe path.
   */
  remoteCuratorWallet(contextGraphId: string): string | null;
  /** The graph is still an active subscription (or hosting obligation). */
  isActiveSubscription(contextGraphId: string): boolean;
  /** The local phonebook maps the wallet to at least one peer. */
  phonebookHasWallet(wallet: string, signal: AbortSignal): Promise<boolean>;
  /** On-chain access policy of the graph. */
  readAccessPolicy(contextGraphId: string, signal: AbortSignal): Promise<AgentsPhonebookAccessPolicy>;
  /** Currently connected peers. Must not dial or probe. */
  listConnectedPeers(): readonly AgentsPhonebookCandidatePeer[];
  /** Network admission plus sync-protocol readiness of one connected peer. */
  preparePeer(peerId: string, signal: AbortSignal): Promise<boolean>;
  /** One durable sync of the `agents` graph from one peer. */
  syncAgentsFromPeer(
    peerId: string,
    options: { signal: AbortSignal; totalTimeoutMs: number },
  ): Promise<AgentsPhonebookPeerSyncResult>;
  /** The wanted graphs whose curator now resolves; schedule their recovery. */
  onCuratorsResolved(contextGraphIds: readonly string[]): void;
  logInfo(message: string): void;
  logDebug(message: string): void;
}

export interface OnDemandAgentsPhonebookOptions {
  now?: () => number;
  cooldownMs?: number;
  failureCooldownMs?: number;
  budgetMs?: number;
  maxPeers?: number;
  maxCandidates?: number;
  curatorMissSuppressionMs?: number;
  minNetworkTriples?: number;
  noPeerRetryMs?: number;
  noPeerMaxRetries?: number;
  policyVerdictTtlMs?: number;
  maxStateEntries?: number;
}

type FetchOutcome = 'complete' | 'partial' | 'empty' | 'failed' | 'no-peers';

const SYSTEM_CONTEXT_GRAPH_IDS = new Set<string>(Object.values(SYSTEM_CONTEXT_GRAPHS));

function shortPeerId(peerId: string): string {
  return peerId.slice(-8);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setBounded<V>(map: Map<string, V>, key: string, value: V, maxEntries: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Process-local owner of on-demand phonebook fetches. */
export class OnDemandAgentsPhonebookFetcher {
  readonly #deps: OnDemandAgentsPhonebookDeps;
  readonly #now: () => number;
  readonly #cooldownMs: number;
  readonly #failureCooldownMs: number;
  readonly #budgetMs: number;
  readonly #maxPeers: number;
  readonly #maxCandidates: number;
  readonly #curatorMissSuppressionMs: number;
  readonly #minNetworkTriples: number;
  readonly #noPeerRetryMs: number;
  readonly #noPeerMaxRetries: number;
  readonly #policyVerdictTtlMs: number;
  readonly #maxStateEntries: number;

  #closed = false;
  #lifetime = new AbortController();
  #inFlight: Promise<void> | undefined;
  #nextEligibleAt = 0;
  /** Graph -> first trigger that wanted it; drained by the next fetch. */
  readonly #wants = new Map<string, AgentsPhonebookFetchTrigger>();
  readonly #evaluating = new Set<string>();
  readonly #evaluations = new Set<Promise<void>>();
  readonly #curatorMissUntil = new Map<string, number>();
  readonly #policyVerdicts = new Map<string, { publicPolicy: boolean; expiresAt: number }>();
  #recheckTimer: ReturnType<typeof setTimeout> | undefined;
  #rechecks = 0;

  constructor(deps: OnDemandAgentsPhonebookDeps, options: OnDemandAgentsPhonebookOptions = {}) {
    this.#deps = deps;
    this.#now = options.now ?? Date.now;
    this.#cooldownMs = options.cooldownMs ?? AGENTS_PHONEBOOK_FETCH_COOLDOWN_MS;
    this.#failureCooldownMs = options.failureCooldownMs ?? AGENTS_PHONEBOOK_FETCH_FAILURE_COOLDOWN_MS;
    this.#budgetMs = options.budgetMs ?? AGENTS_PHONEBOOK_FETCH_BUDGET_MS;
    this.#maxPeers = options.maxPeers ?? AGENTS_PHONEBOOK_FETCH_MAX_PEERS;
    this.#maxCandidates = options.maxCandidates ?? AGENTS_PHONEBOOK_FETCH_MAX_CANDIDATES;
    this.#curatorMissSuppressionMs = options.curatorMissSuppressionMs
      ?? AGENTS_PHONEBOOK_CURATOR_MISS_SUPPRESSION_MS;
    this.#minNetworkTriples = options.minNetworkTriples ?? AGENTS_PHONEBOOK_MIN_NETWORK_TRIPLES;
    this.#noPeerRetryMs = options.noPeerRetryMs ?? AGENTS_PHONEBOOK_NO_PEER_RETRY_MS;
    this.#noPeerMaxRetries = options.noPeerMaxRetries ?? AGENTS_PHONEBOOK_NO_PEER_MAX_RETRIES;
    this.#policyVerdictTtlMs = options.policyVerdictTtlMs ?? AGENTS_PHONEBOOK_POLICY_VERDICT_TTL_MS;
    this.#maxStateEntries = options.maxStateEntries ?? AGENTS_PHONEBOOK_STATE_MAX_ENTRIES;
  }

  /**
   * Ask for the phonebook on behalf of one graph. Synchronous, O(1) and never
   * throws: the subscribe path calls it. Everything that reads the store, the
   * chain or the network runs detached.
   */
  request(contextGraphId: string, trigger: AgentsPhonebookFetchTrigger): void {
    try {
      if (this.#closed || SYSTEM_CONTEXT_GRAPH_IDS.has(contextGraphId)) return;
      if (!this.#deps.isEnabled()) return;
      const wallet = this.#deps.remoteCuratorWallet(contextGraphId);
      if (wallet === null) return;
      const now = this.#now();
      if ((this.#curatorMissUntil.get(contextGraphId) ?? 0) > now) return;
      if (this.#wants.has(contextGraphId) || this.#evaluating.has(contextGraphId)) return;
      // An in-flight fetch still adopts a graph that qualifies; a cooling-down
      // one does not, and the graph's next reconcile pass asks again later.
      if (this.#inFlight === undefined && now < this.#nextEligibleAt) return;
      this.#evaluating.add(contextGraphId);
      // Start on a later turn, so a caller's synchronous path (subscribe, a
      // VM recovery pass) does no store or chain work here.
      const evaluation = Promise.resolve()
        .then(() => this.#evaluate(contextGraphId, wallet, trigger))
        .catch((error: unknown) => {
          this.#deps.logDebug(
            `On-demand agents phonebook check for "${contextGraphId}" failed: ${errorMessage(error)}`,
          );
        })
        .finally(() => {
          this.#evaluating.delete(contextGraphId);
          this.#evaluations.delete(evaluation);
        });
      this.#evaluations.add(evaluation);
    } catch {
      // The trigger is advisory; a broken dependency must never fail its caller.
    }
  }

  /** Resolves once no evaluation or fetch started before this call is running. */
  async whenIdle(): Promise<void> {
    while (this.#evaluations.size > 0 || this.#inFlight !== undefined) {
      await Promise.allSettled([...this.#evaluations, this.#inFlight]);
    }
  }

  /** Abort the in-flight fetch and the no-peer re-check; resolves once idle. */
  close(): Promise<void> {
    this.#closed = true;
    this.#lifetime.abort(new DOMException('On-demand agents phonebook closed', 'AbortError'));
    this.#clearRecheck();
    this.#wants.clear();
    return this.whenIdle();
  }

  /** Admit requests again after a restart. Cooldowns and suppressions survive. */
  reopen(): void {
    if (!this.#closed) return;
    this.#closed = false;
    this.#lifetime = new AbortController();
    this.#rechecks = 0;
  }

  async #evaluate(
    contextGraphId: string,
    wallet: string,
    trigger: AgentsPhonebookFetchTrigger,
  ): Promise<void> {
    const signal = this.#lifetime.signal;
    if (!this.#deps.isActiveSubscription(contextGraphId)) return;
    if (await this.#deps.phonebookHasWallet(wallet, signal)) return;
    if (this.#closed) return;
    if (!(await this.#isPublic(contextGraphId, signal))) return;
    if (this.#closed || !this.#deps.isActiveSubscription(contextGraphId)) return;
    if (!this.#wants.has(contextGraphId)) {
      setBounded(this.#wants, contextGraphId, trigger, this.#maxStateEntries);
    }
    this.#maybeStart();
  }

  async #isPublic(contextGraphId: string, signal: AbortSignal): Promise<boolean> {
    const now = this.#now();
    const cached = this.#policyVerdicts.get(contextGraphId);
    if (cached !== undefined && cached.expiresAt > now) return cached.publicPolicy;
    const policy = await this.#deps.readAccessPolicy(contextGraphId, signal);
    // An unanswered read is not a verdict: the next trigger reads again.
    if (policy === 'unknown') return false;
    const publicPolicy = policy === 'public';
    setBounded(
      this.#policyVerdicts,
      contextGraphId,
      { publicPolicy, expiresAt: now + this.#policyVerdictTtlMs },
      this.#maxStateEntries,
    );
    return publicPolicy;
  }

  #maybeStart(): void {
    if (this.#closed || this.#inFlight !== undefined || this.#wants.size === 0) return;
    if (this.#now() < this.#nextEligibleAt) {
      this.#wants.clear();
      return;
    }
    this.#clearRecheck();
    const fetch = this.#fetch()
      .catch((error: unknown) => {
        this.#deps.logDebug(`On-demand agents phonebook fetch stopped: ${errorMessage(error)}`);
      })
      .finally(() => {
        if (this.#inFlight === fetch) this.#inFlight = undefined;
        if (this.#closed || this.#wants.size === 0) return;
        // A graph that qualified after this fetch read its wanted list must
        // not stay parked there. Inside the cooldown it is dropped and asks
        // again on its next trigger; otherwise a bounded re-check picks it up.
        if (this.#now() < this.#nextEligibleAt) this.#wants.clear();
        else this.#scheduleRecheck();
      });
    this.#inFlight = fetch;
  }

  async #fetch(): Promise<void> {
    const lifetime = this.#lifetime.signal;
    const startedAt = this.#now();
    const trigger = this.#wants.values().next().value ?? 'vm-reconcile';
    const candidates = [...this.#deps.listConnectedPeers()]
      .sort((left, right) => Number(right.core) - Number(left.core)
        || left.peerId.localeCompare(right.peerId))
      .slice(0, this.#maxCandidates);

    const budget = new AbortController();
    const abortBudget = () => budget.abort(lifetime.reason);
    lifetime.addEventListener('abort', abortBudget, { once: true });
    const budgetTimer = setTimeout(() => {
      budget.abort(new DOMException('On-demand agents phonebook budget exhausted', 'TimeoutError'));
    }, this.#budgetMs);
    budgetTimer.unref?.();

    const peerSummaries: string[] = [];
    let attemptedPeers = 0;
    let fetchedTriples = 0;
    let insertedTriples = 0;
    let answeredEmpty = false;
    // A known Core's complete answer that carried a real phonebook. Only this
    // ends the walk early or suppresses a graph whose owner it lacks.
    let networkPhonebook = false;
    try {
      for (const { peerId, core } of candidates) {
        if (attemptedPeers >= this.#maxPeers || budget.signal.aborted) break;
        let ready = false;
        try {
          ready = await this.#deps.preparePeer(peerId, budget.signal);
        } catch {
          ready = false;
        }
        if (budget.signal.aborted) break;
        if (!ready) continue;
        const remainingMs = startedAt + this.#budgetMs - this.#now();
        if (remainingMs <= 0) break;
        attemptedPeers += 1;
        const role = core ? 'core' : 'peer';
        try {
          const result = await this.#deps.syncAgentsFromPeer(peerId, {
            signal: budget.signal,
            totalTimeoutMs: remainingMs,
          });
          fetchedTriples += result.fetchedTriples;
          insertedTriples += result.insertedTriples;
          if (result.fetchedTriples === 0) answeredEmpty = true;
          if (core && result.complete && result.fetchedTriples >= this.#minNetworkTriples) {
            networkPhonebook = true;
          }
          peerSummaries.push(
            `${shortPeerId(peerId)}:${role}:${result.complete ? 'complete' : 'partial'}:${result.fetchedTriples}`,
          );
        } catch (error) {
          peerSummaries.push(`${shortPeerId(peerId)}:${role}:failed`);
          this.#deps.logDebug(
            `On-demand agents phonebook sync from ${shortPeerId(peerId)} failed: ${errorMessage(error)}`,
          );
        }
        // A complete Core phonebook is the network's phonebook; another Core
        // would send the same rows. An empty or near-empty "complete" answer
        // is not. Also stop once every wanted curator is in.
        if (networkPhonebook || budget.signal.aborted) break;
        if ((await this.#unresolvedWants(budget.signal)).length === 0) break;
      }
    } finally {
      clearTimeout(budgetTimer);
      lifetime.removeEventListener('abort', abortBudget);
    }
    if (lifetime.aborted) return;

    if (attemptedPeers === 0) {
      // Nothing was asked of any peer: keep the wanted graphs and re-check
      // soon, without starting a cooldown.
      this.#recordMetrics(trigger, 'no-peers', false, this.#now() - startedAt);
      this.#deps.logDebug(
        `On-demand agents phonebook fetch deferred: no usable connected peer `
          + `(trigger=${trigger} candidates=${candidates.length} wanted=${this.#wants.size})`,
      );
      this.#scheduleRecheck();
      return;
    }
    this.#rechecks = 0;

    // Graphs that asked while this fetch ran are served by the same phonebook.
    const wanted = [...this.#wants.keys()];
    this.#wants.clear();
    const unresolved = new Set(await this.#unresolvedWantsOf(wanted, lifetime));
    // Closed (stop()) while checking: a closed fetcher reports nothing, meters
    // nothing and schedules no recovery for a host that is shutting down.
    if (lifetime.aborted) return;
    const resolved = wanted.filter((contextGraphId) => !unresolved.has(contextGraphId));
    const now = this.#now();
    // `empty`: peers answered but served no rows (a just-started or lean Core);
    // like `failed`, it keeps the short cooldown so another peer is asked soon.
    const outcome: FetchOutcome = networkPhonebook || (fetchedTriples > 0 && unresolved.size === 0)
      ? 'complete'
      : fetchedTriples > 0 ? 'partial' : answeredEmpty ? 'empty' : 'failed';
    this.#nextEligibleAt = now + (outcome === 'failed' || outcome === 'empty'
      ? this.#failureCooldownMs
      : this.#cooldownMs);
    if (networkPhonebook) {
      for (const contextGraphId of unresolved) {
        setBounded(
          this.#curatorMissUntil,
          contextGraphId,
          now + this.#curatorMissSuppressionMs,
          this.#maxStateEntries,
        );
      }
    }
    const durationMs = now - startedAt;
    this.#recordMetrics(trigger, outcome, resolved.length > 0, durationMs);
    const firstWanted = wanted[0] ?? 'none';
    this.#deps.logInfo(
      `On-demand agents phonebook fetch: trigger=${trigger} `
        + `graph=${firstWanted}${wanted.length > 1 ? ` (+${wanted.length - 1})` : ''} `
        + `peers=[${peerSummaries.join(' ')}] fetched=${fetchedTriples} inserted=${insertedTriples} `
        + `durationMs=${durationMs} `
        + `curatorResolved=${resolved.length}/${wanted.length} outcome=${outcome} `
        + `nextFetchInMs=${this.#nextEligibleAt - now}`,
    );
    if (resolved.length > 0) this.#deps.onCuratorsResolved(resolved);
  }

  async #unresolvedWants(signal: AbortSignal): Promise<string[]> {
    return this.#unresolvedWantsOf([...this.#wants.keys()], signal);
  }

  async #unresolvedWantsOf(
    contextGraphIds: readonly string[],
    signal: AbortSignal,
  ): Promise<string[]> {
    const unresolved: string[] = [];
    for (const contextGraphId of contextGraphIds) {
      const wallet = this.#deps.remoteCuratorWallet(contextGraphId);
      if (wallet === null) continue;
      const known = await this.#deps.phonebookHasWallet(wallet, signal).catch(() => false);
      if (!known) unresolved.push(contextGraphId);
    }
    return unresolved;
  }

  /** Re-check the wanted graphs later; bounded, and a no-op while one is armed. */
  #scheduleRecheck(): void {
    if (this.#closed || this.#recheckTimer !== undefined) return;
    if (this.#rechecks >= this.#noPeerMaxRetries) {
      // Stop polling; the next subscribe or reconcile pass asks again.
      this.#wants.clear();
      return;
    }
    this.#rechecks += 1;
    const timer = setTimeout(() => {
      if (this.#recheckTimer === timer) this.#recheckTimer = undefined;
      this.#maybeStart();
    }, this.#noPeerRetryMs);
    timer.unref?.();
    this.#recheckTimer = timer;
  }

  #clearRecheck(): void {
    if (this.#recheckTimer === undefined) return;
    clearTimeout(this.#recheckTimer);
    this.#recheckTimer = undefined;
  }

  #recordMetrics(
    trigger: AgentsPhonebookFetchTrigger,
    outcome: FetchOutcome,
    curatorResolved: boolean,
    durationMs: number,
  ): void {
    try {
      const metrics = getMetrics();
      metrics.agentsPhonebookFetchTotal.add(1, {
        trigger,
        outcome,
        curator_resolved: curatorResolved ? 'true' : 'false',
      });
      if (outcome !== 'no-peers') {
        metrics.agentsPhonebookFetchDurationMs.record(durationMs, { trigger, outcome });
      }
    } catch {
      // Telemetry never changes fetch behaviour.
    }
  }
}

/**
 * One fetcher per agent-like host, created on first use. Keyed by host
 * identity rather than stored on the class, so prototype-bound test hosts own
 * one exactly as a constructed agent does (the same pattern as the finalized
 * authority cold-resolution runtime).
 */
const fetchersByHost = new WeakMap<object, OnDemandAgentsPhonebookFetcher>();

export function onDemandAgentsPhonebookFor(
  host: object,
  create: () => OnDemandAgentsPhonebookFetcher,
): OnDemandAgentsPhonebookFetcher {
  let fetcher = fetchersByHost.get(host);
  if (fetcher === undefined) {
    fetcher = create();
    fetchersByHost.set(host, fetcher);
  }
  return fetcher;
}

/** The host's fetcher if one was ever created; lifecycle hooks never create one. */
export function peekOnDemandAgentsPhonebook(
  host: object,
): OnDemandAgentsPhonebookFetcher | undefined {
  return fetchersByHost.get(host);
}
