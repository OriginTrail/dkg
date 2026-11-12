// SPDX-License-Identifier: Apache-2.0

/**
 * Read graphs in the agent: the builder that backfills, rebuilds and repairs
 * the read graphs the node keeps, run with the agent's other background
 * workloads, and the node's working-memory identity rule, which it sets on the
 * store's read-graph runtime before it builds.
 *
 * Beside the builder run the checks of the read graphs it keeps (sampled ones,
 * and a full pass at a long interval), and on request a check of every ready
 * read graph, whose results the status keeps.
 *
 * Which read graphs the node keeps comes from a mode per read graph: `off`,
 * `build` or `serve`, from the node's settings (`query.readGraphs`) on the
 * store's read-graph runtime. With every read graph `off`, or a store without
 * a read-graph layer ({@link READ_GRAPHS_OFF}), the builder does not start,
 * and the start-up before the first write (`startReadGraphs`) marks every
 * read graph it finds dirty, as before. The builder removes the read graphs
 * whose mode is `off`, and starts for them alone when the start-up found
 * some.
 *
 * The modes can be switched while the node runs ({@link
 * ReadGraphWorkloadOwnerV1.applyReadGraphModes}): the builder starts once a
 * switch leaves something to build or to remove, and runs a pass at once.
 */

import {
  MemoryLayer,
  createOperationContext,
  isReadGraphEligibleContextGraphId,
  readScope,
  type OperationContext,
  type ReadGraphKey,
  type ReadScope,
} from '@origintrail-official/dkg-core';
import {
  ReadGraphBuilder,
  applyReadGraphModes,
  checkReadGraph,
  installWorkingMemoryIdentity,
  keepsAnyReadGraph,
  readGraphLayerOf,
  readGraphWork,
  readGraphModeOf,
  readGraphRuntimeOf,
  readReadGraphRegistry,
  registeredSubGraphNames,
  startReadGraphChecks,
  withReadGraphBackgroundSlot,
  type ReadGraphBuilderStatus,
  type ReadGraphCheckMode,
  type ReadGraphCheckResult,
  type ReadGraphCheckSchedule,
  type ReadGraphMode,
  type ReadGraphModeChange,
  type ReadGraphModeDeferral,
  type ReadGraphModes,
  type ReadGraphState,
  type TripleStore,
  type ViewSemanticsSettings,
} from '@origintrail-official/dkg-storage';

export type { ReadGraphMode };

/** Every read graph off: the modes of a store without a read-graph layer. */
export const READ_GRAPHS_OFF: ReadGraphModesV1 = Object.freeze({ modeOf: () => 'off', keepsAny: () => false });

/** The modes the node's settings (`query.readGraphs`) give on the store's read-graph runtime, read when asked. */
export function readGraphModesOfStore(store: TripleStore): ReadGraphModesV1 {
  const runtime = readGraphRuntimeOf(store);
  if (!runtime) return READ_GRAPHS_OFF;
  return { modeOf: (key) => readGraphModeOf(runtime.modes, key), keepsAny: () => keepsAnyReadGraph(runtime.modes) };
}

export interface ReadGraphModesV1 {
  /** The mode of one read graph. A sub-graph's read graph follows its context graph's. */
  modeOf(key: ReadGraphKey): ReadGraphMode;
  /** Whether any read graph may be at `build` or `serve`. */
  keepsAny(): boolean;
}

/** The parts of the agent the read-graph workload reads. */
export interface ReadGraphAgentViewV1 {
  readonly store: TripleStore;
  readonly peerId: string;
  getDefaultAgentAddress(): string | undefined;
  getSubscribedContextGraphs(): ReadonlyMap<string, unknown>;
  listLocalAgents(): ReadonlyArray<{ readonly agentAddress: string }>;
}

export interface ReadGraphWorkloadOptionsV1 {
  readonly dataDir?: string;
  readonly logger: { info(ctx: OperationContext, message: string): void; warn(ctx: OperationContext, message: string): void };
  /** The time between the builder's passes. */
  readonly intervalMs?: number;
}

const SHARED_LAYERS = [MemoryLayer.VerifiableMemory, MemoryLayer.SharedWorkingMemory] as const;

/** A check of the node's ready read graphs, run on request. */
export interface ReadGraphCheckReportV1 {
  readonly mode: ReadGraphCheckMode;
  /** When it ended, in milliseconds since the epoch. */
  readonly at: number;
  readonly results: readonly ReadGraphCheckResult[];
}

/** The node's read graphs, for `dkg store read-graphs status`. */
export interface ReadGraphStatusV1 {
  /**
   * Each read graph, once this process has built it with the triples it held
   * then and its member graphs that the build found by listing the store (the
   * asset or draft graphs, not the fixed graphs its membership names). Writes
   * since then make both drift.
   */
  readonly readGraphs: ReadonlyArray<{
    readonly readGraph: string;
    readonly state: ReadGraphState;
    readonly generation: number;
    readonly triples?: number;
    readonly members?: number;
  }>;
  /** What the builder does; `undefined` while it does not run. */
  readonly builder: ReadGraphBuilderStatus | undefined;
  /** Whether the background checks run. */
  readonly checking: boolean;
  /** The last check run on request. */
  readonly lastCheck: ReadGraphCheckReportV1 | undefined;
}

/** The read-graph workload of each agent, so that requests from outside reach it. */
const OWNERS = new WeakMap<object, ReadGraphWorkloadOwnerV1>();

/** The read-graph workload an agent created, if any. */
export function readGraphWorkloadOf(agent: object): ReadGraphWorkloadOwnerV1 | undefined {
  return OWNERS.get(agent);
}

/** The agent's read-graph builder, as one of its background workloads. */
export class ReadGraphWorkloadOwnerV1 {
  readonly #agent: ReadGraphAgentViewV1;
  readonly #options: ReadGraphWorkloadOptionsV1;
  readonly #modes: ReadGraphModesV1;
  #builder: ReadGraphBuilder | undefined;
  #checks: ReadGraphCheckSchedule | undefined;
  #lastCheck: ReadGraphCheckReportV1 | undefined;
  /** The checks run on request, each with the controller that ends it when the workload stops. */
  readonly #requested = new Map<AbortController, Promise<unknown>>();
  #closing = 0;
  /** The context the workload was started in, until it stops: a live switch starts the builder in it. */
  #started: OperationContext | undefined;

  constructor(agent: ReadGraphAgentViewV1, options: ReadGraphWorkloadOptionsV1) {
    this.#agent = agent;
    this.#options = options;
    // The runtime's settings, which a live switch changes: the workload decides from what it applies.
    this.#modes = readGraphModesOfStore(agent.store);
    OWNERS.set(agent, this);
  }

  /** Start the builder, when any read graph may be kept or work a switch or the start-up left waits for it. */
  start(ctx: OperationContext): void {
    this.#started = ctx;
    if (this.#builder || !(this.#modes.keepsAny() || this.#workAsked())) return;
    const { logger } = this.#options;
    this.#builder = new ReadGraphBuilder({
      store: this.#agent.store,
      dataDir: this.#options.dataDir,
      wanted: (signal) => this.wanted(signal),
      off: (key) => this.#modes.modeOf(key) === 'off',
      intervalMs: this.#options.intervalMs,
      log: (line) => logger.info(ctx, line),
      warn: (line) => logger.warn(ctx, line),
    });
    this.#builder.start();
    this.#checks = startReadGraphChecks(this.#agent.store, {
      onError: (error, readGraph) => logger.warn(ctx, `A read-graph check${readGraph ? ` of <${readGraph}>` : ''} failed: ${messageOf(error)}`),
      alert: (message) => logger.warn(ctx, message),
    });
  }

  whenIdle(): Promise<void> {
    return this.#builder?.whenIdle() ?? Promise.resolve();
  }

  /** Run a build pass as soon as the one in progress ends, rather than at the interval. Nothing before start or after close. */
  request(): void {
    this.#builder?.request();
  }

  /**
   * Stop the builder and the checks: no new pass, and what runs, a check run
   * on request included, is aborted and waited for. A check asked for while
   * this runs is refused.
   */
  async close(): Promise<void> {
    const builder = this.#builder;
    const checks = this.#checks;
    this.#builder = undefined;
    this.#checks = undefined;
    this.#started = undefined;
    this.#closing += 1;
    try {
      const requested = [...this.#requested];
      for (const [stop] of requested) stop.abort(new Error('The read-graph checks are stopping'));
      await Promise.all([
        checks?.close(),
        builder?.close(),
        ...requested.map(([, run]) => run.then(() => undefined, () => undefined)),
      ]);
    } finally {
      this.#closing -= 1;
    }
  }

  /**
   * Check every ready read graph now, against its member graphs, and keep the
   * results for {@link readGraphStatus}: for `dkg store read-graphs check`. A
   * full check compares every triple; a mismatch marks the read graph dirty.
   * Each check runs in the backend's background slot, so it never overlaps a
   * build or a scheduled check. Stopping the workload ends it.
   */
  async checkNow(options: { readonly mode?: ReadGraphCheckMode; readonly signal?: AbortSignal } = {}): Promise<ReadGraphCheckReportV1> {
    if (this.#closing > 0) throw new Error('The read-graph checks are stopping');
    const stop = new AbortController();
    const caller = options.signal;
    const forward = () => stop.abort(caller?.reason);
    if (caller?.aborted) forward();
    else caller?.addEventListener('abort', forward, { once: true });
    const run = this.#check(options.mode ?? 'full', stop.signal);
    this.#requested.set(stop, run);
    try {
      return await run;
    } finally {
      this.#requested.delete(stop);
      caller?.removeEventListener('abort', forward);
    }
  }

  async #check(mode: ReadGraphCheckMode, signal: AbortSignal): Promise<ReadGraphCheckReportV1> {
    const store = this.#agent.store;
    const layer = readGraphLayerOf(store);
    const results: ReadGraphCheckResult[] = [];
    if (layer) {
      const ready = layer.runtime.mirror.rows().filter((row) => row.state === 'ready').map((row) => row.readGraph).sort();
      for (const readGraph of ready) {
        signal.throwIfAborted();
        results.push(await withReadGraphBackgroundSlot(layer.runtime, async () => {
          signal.throwIfAborted();
          return checkReadGraph(store, readGraph, mode, { signal });
        }));
      }
    }
    const report: ReadGraphCheckReportV1 = { mode, at: Date.now(), results };
    this.#lastCheck = report;
    return report;
  }

  /**
   * Switch the node's read graphs to `next`, the whole settings, while it
   * runs (`applyReadGraphModes`): for the node-admin settings API. A layer
   * switched on gets its rows at once, for the node's subscribed context
   * graphs and local agents, and the builder backfills them; a layer switched
   * off leaves service at once, and the builder removes it. Once the workload
   * runs, a switch that leaves anything to build or remove starts the builder
   * or runs its next pass at once.
   */
  async applyReadGraphModes(
    next: ReadGraphModes,
    options: { readonly signal?: AbortSignal; readonly viewSemantics?: ViewSemanticsSettings } = {},
  ): Promise<readonly ReadGraphModeChange[]> {
    const changes = await applyReadGraphModes(this.#agent.store, next, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.viewSemantics ? { viewSemantics: options.viewSemantics } : {}),
      ...(this.#options.dataDir !== undefined ? { dataDir: this.#options.dataDir } : {}),
      contextGraphIds: [...this.#agent.getSubscribedContextGraphs().keys()],
      wanted: () => this.wanted(),
      source: 'agent.readGraphModes',
      onDeferred: (deferral) => this.#options.logger.warn(this.#started ?? createOperationContext('system'), deferredMessage(deferral)),
    });
    // From the settings now in force, not from the changes listed: a node default switched on lists no context graph
    // before the first subscription, and the builder must run for the ones that come.
    if (this.#builder) this.#builder.request();
    else if (this.#started) this.start(this.#started);
    return changes;
  }

  /** Whether work a switch or the start-up left waits for the builder (`readGraphWork`). */
  #workAsked(): boolean {
    const runtime = readGraphRuntimeOf(this.#agent.store);
    return runtime !== undefined && readGraphWork(runtime).length > 0;
  }

  /** The node's read graphs, what the builder does, and the last check run on request: for `dkg store read-graphs status`. */
  readGraphStatus(): ReadGraphStatusV1 {
    const rows = readGraphLayerOf(this.#agent.store)?.runtime.mirror.rows() ?? [];
    return {
      readGraphs: rows.map(({ readGraph, state, generation }) => ({ readGraph, state, generation, ...this.#builder?.atLastBuild(readGraph) }))
        .sort((left, right) => (left.readGraph < right.readGraph ? -1 : left.readGraph > right.readGraph ? 1 : 0)),
      builder: this.#builder?.status(),
      checking: this.#checks !== undefined,
      lastCheck: this.#lastCheck,
    };
  }

  /** What the builder is doing, or `undefined` while it does not run. */
  status(): ReadGraphBuilderStatus | undefined {
    return this.#builder?.status();
  }

  /**
   * The read graphs the node keeps: for each context graph it subscribes to,
   * the whole graph and each registered sub-graph, in every layer whose mode
   * is not `off`, and in working memory once per local agent. The identity
   * rule is brought up to date first.
   */
  async wanted(signal?: AbortSignal): Promise<ReadGraphKey[]> {
    await this.syncIdentity(signal);
    const agents = [...new Set(this.#agent.listLocalAgents().map((agent) => agent.agentAddress))];
    const kept = (scope: ReadScope): ReadGraphKey[] => [
      ...SHARED_LAYERS.map((layer): ReadGraphKey => ({ scope, layer })),
      ...agents.map((agentAddress): ReadGraphKey => ({ scope, layer: MemoryLayer.WorkingMemory, agentAddress })),
    ].filter((key) => this.#modes.modeOf(key) !== 'off');
    const keys: ReadGraphKey[] = [];
    for (const contextGraphId of this.#agent.getSubscribedContextGraphs().keys()) {
      if (!isReadGraphEligibleContextGraphId(contextGraphId)) continue;
      const whole = kept(readScope(contextGraphId));
      // A sub-graph follows its context graph: one that keeps nothing needs no registry read.
      if (whole.length === 0) continue;
      const registry = await readReadGraphRegistry(this.#agent.store, contextGraphId, { priority: 'background', ...(signal ? { signal } : {}) });
      keys.push(...whole, ...registeredSubGraphNames(registry).flatMap((name) => kept(readScope(contextGraphId, name))));
    }
    return keys;
  }

  /** Install the node's working-memory identity rule; storage marks the read graphs built under another one dirty. */
  async syncIdentity(signal?: AbortSignal): Promise<void> {
    await installWorkingMemoryIdentity(
      { store: this.#agent.store, dataDir: this.#options.dataDir, ...(signal ? { signal } : {}) },
      { defaultAgentAddress: this.#agent.getDefaultAgentAddress(), peerId: this.#agent.peerId },
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEFERRED_STEPS: Readonly<Record<ReadGraphModeDeferral['step'], string>> = {
  retire: 'take out of service',
  admit: 'take into service',
  wanted: 'list the read graphs it keeps for',
  registry: 'read the registry of',
};

/** The warning for a step of a switch that the builder takes over. */
function deferredMessage(deferral: ReadGraphModeDeferral): string {
  const what = deferral.readGraph ?? deferral.contextGraphId ?? 'the switched layers';
  return `A read-graph switch could not ${DEFERRED_STEPS[deferral.step]} ${what} at once, and leaves it to the builder: ${messageOf(deferral.error)}`;
}
