// SPDX-License-Identifier: Apache-2.0

/**
 * Safety-net pull of the shared memory of a public graph in use here (#3251).
 *
 * A member that already synced a public graph pulls its shared memory again
 * only when something else asks for it: a new connection, the peer
 * reconciler (every 5 min, for a peer last synced at least 10 min earlier, so
 * up to about 15 min for named sub-graphs; never on a node that runs without
 * it), or the RFC-64 authority refresh for the root scope (every 5 min, and
 * not at all while that refresh cannot complete). A write that only the
 * graph's owner holds, because its author is not connected to this member,
 * waits that long or for ever.
 *
 * While a graph is in use here, this scheduler pulls it from one connected
 * holder, the owner first, at a bounded interval. A graph is in use for
 * `activityWindowMs` after the caller says so ({@link noteActivity}: a
 * subscribe, a local write, a received write) or after a pull of it stored
 * new data.
 *
 * Bounds: one pull of a graph per `intervalMs` and never two at once,
 * `pullsPerTick` pulls per tick, one tick at a time, a tick waits at most
 * `pullWaitMs` for any one pull, and at most `maxGraphs` graphs are tracked.
 * The worst-case delay from a write reaching the owner to the pull that
 * fetches it is `intervalMs` plus one tick period plus that pull, as long as
 * no more than `pullsPerTick` graphs fall due together.
 */

export const RECENT_SHARED_MEMORY_PULL_TICK_MS = 30_000;
export const RECENT_SHARED_MEMORY_PULL_INTERVAL_MS = 60_000;
export const RECENT_SHARED_MEMORY_ACTIVITY_WINDOW_MS = 30 * 60_000;
export const RECENT_SHARED_MEMORY_PULLS_PER_TICK = 8;
export const RECENT_SHARED_MEMORY_PULL_WAIT_MS = 20_000;
export const RECENT_SHARED_MEMORY_MAX_GRAPHS = 256;

/** Connected peers one graph can be pulled from. */
export interface RecentSharedMemoryPullSources {
  /** The graph's owner, the peer that member writes reach first. */
  readonly owners: readonly string[];
  /** Other connected peers, taken in turn while no owner is connected. */
  readonly others: readonly string[];
}

export interface RecentSharedMemoryPullPorts {
  /** Still a subscription this node should pull: public, always-on, not owned here. */
  eligible(contextGraphId: string): Promise<boolean>;
  sources(contextGraphId: string): Promise<RecentSharedMemoryPullSources>;
  /** Pull the graph from one peer; resolves to the number of new data triples it stored. */
  pull(contextGraphId: string, peerId: string): Promise<number>;
  onPulled?(contextGraphId: string, peerId: string, stored: number): void;
  onError?(contextGraphId: string, error: unknown): void;
}

export interface RecentSharedMemoryPullOptions {
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly activityWindowMs?: number;
  readonly pullsPerTick?: number;
  readonly pullWaitMs?: number;
  readonly maxGraphs?: number;
}

interface GraphState {
  activeAt: number;
  pulledAt: number;
  inFlight: boolean;
  turn: number;
}

function waitAtMost(work: Promise<unknown>, ms: number, closed: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return Promise.race([work.then(() => undefined), elapsed, closed]).finally(() => clearTimeout(timer));
}

export class RecentSharedMemoryPulls {
  readonly #ports: RecentSharedMemoryPullPorts;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #activityWindowMs: number;
  readonly #pullsPerTick: number;
  readonly #pullWaitMs: number;
  readonly #maxGraphs: number;
  /** In order of last activity, oldest first. */
  readonly #graphs = new Map<string, GraphState>();
  readonly #closedSignal: Promise<void>;
  #markClosed!: () => void;
  #closed = false;
  #tickRun: Promise<number> | undefined;

  constructor(ports: RecentSharedMemoryPullPorts, options: RecentSharedMemoryPullOptions = {}) {
    this.#ports = ports;
    this.#now = options.now ?? Date.now;
    this.#intervalMs = options.intervalMs ?? RECENT_SHARED_MEMORY_PULL_INTERVAL_MS;
    this.#activityWindowMs = options.activityWindowMs ?? RECENT_SHARED_MEMORY_ACTIVITY_WINDOW_MS;
    this.#pullsPerTick = options.pullsPerTick ?? RECENT_SHARED_MEMORY_PULLS_PER_TICK;
    this.#pullWaitMs = options.pullWaitMs ?? RECENT_SHARED_MEMORY_PULL_WAIT_MS;
    this.#maxGraphs = options.maxGraphs ?? RECENT_SHARED_MEMORY_MAX_GRAPHS;
    this.#closedSignal = new Promise<void>((resolve) => { this.#markClosed = resolve; });
  }

  get trackedGraphCount(): number {
    return this.#graphs.size;
  }

  /**
   * The graph is in use here: pull it every interval for the activity window.
   * Its first pull comes one interval later; whatever marked it active (a
   * subscribe's catch-up, a write that just arrived) is that fresh already.
   */
  noteActivity(contextGraphId: string): void {
    if (this.#closed) return;
    const now = this.#now();
    const state = this.#graphs.get(contextGraphId);
    this.#graphs.delete(contextGraphId);
    if (state !== undefined) {
      state.activeAt = now;
      this.#graphs.set(contextGraphId, state);
      return;
    }
    this.#graphs.set(contextGraphId, { activeAt: now, pulledAt: now, inFlight: false, turn: 0 });
    // Never forget a graph whose pull runs: a new state for it would let a
    // second pull of the same graph start beside the first.
    for (const [oldest, oldestState] of this.#graphs) {
      if (this.#graphs.size <= this.#maxGraphs) break;
      if (!oldestState.inFlight) this.#graphs.delete(oldest);
    }
  }

  /** One round: pull every due graph, the longest unpulled first, within the bounds. */
  tick(): Promise<number> {
    if (this.#tickRun !== undefined) return Promise.resolve(0);
    const run = this.#tick().finally(() => {
      this.#tickRun = undefined;
    });
    this.#tickRun = run;
    return run;
  }

  /**
   * No pull starts after this. Resolves once the running tick has returned,
   * which it does at its next step: a pull it waits for keeps running on its
   * own and ends with the node's shutdown like any other sync.
   */
  close(): Promise<void> {
    this.#closed = true;
    this.#markClosed();
    return (this.#tickRun ?? Promise.resolve(0)).then(() => undefined);
  }

  async #tick(): Promise<number> {
    const now = this.#now();
    for (const [contextGraphId, state] of this.#graphs) {
      if (!state.inFlight && now - state.activeAt >= this.#activityWindowMs) {
        this.#graphs.delete(contextGraphId);
      }
    }
    const due = [...this.#graphs]
      .filter(([, state]) => !state.inFlight && now - state.pulledAt >= this.#intervalMs)
      .sort(([, left], [, right]) => left.pulledAt - right.pulledAt)
      .slice(0, this.#pullsPerTick);
    let pulls = 0;
    for (const [contextGraphId, state] of due) {
      if (this.#closed) break;
      if (this.#graphs.get(contextGraphId) !== state) continue;
      state.pulledAt = this.#now();
      if (await this.#pull(contextGraphId, state)) pulls += 1;
    }
    return pulls;
  }

  async #pull(contextGraphId: string, state: GraphState): Promise<boolean> {
    let peerId: string;
    try {
      if (!(await this.#ports.eligible(contextGraphId))) {
        if (this.#graphs.get(contextGraphId) === state) this.#graphs.delete(contextGraphId);
        return false;
      }
      if (this.#closed) return false;
      const { owners, others } = await this.#ports.sources(contextGraphId);
      const candidates = owners.length > 0 ? owners : others;
      if (this.#closed || candidates.length === 0) return false;
      peerId = candidates[state.turn % candidates.length]!;
      state.turn += 1;
    } catch (error) {
      this.#ports.onError?.(contextGraphId, error);
      return false;
    }
    state.inFlight = true;
    const pull = this.#ports.pull(contextGraphId, peerId).then(
      (stored) => {
        if (stored > 0) state.activeAt = this.#now();
        this.#ports.onPulled?.(contextGraphId, peerId, stored);
      },
      (error: unknown) => this.#ports.onError?.(contextGraphId, error),
    ).finally(() => {
      state.inFlight = false;
    });
    // A slow pull keeps its own graph busy but does not hold up the others.
    await waitAtMost(pull, this.#pullWaitMs, this.#closedSignal);
    return true;
  }
}
