// SPDX-License-Identifier: Apache-2.0

/**
 * Read graphs in the agent: the builder that backfills, rebuilds and repairs
 * the read graphs the node keeps, run with the agent's other background
 * workloads, and the node's working-memory identity rule, which it sets on the
 * store's read-graph runtime before it builds.
 *
 * Which read graphs the node keeps comes from a mode per read graph: `off`,
 * `build` or `serve`. The node's settings carry no modes yet, so every read
 * graph is `off` ({@link READ_GRAPHS_OFF}): the builder does not start, and
 * the start-up before the first write (`startReadGraphs`) marks every read
 * graph it finds dirty, as before.
 */

import {
  MemoryLayer,
  isReadGraphEligibleContextGraphId,
  parseReadGraphIri,
  readScope,
  type OperationContext,
  type ReadGraphKey,
  type ReadScope,
} from '@origintrail-official/dkg-core';
import {
  ReadGraphBuilder,
  markReadGraphDirty,
  readGraphRuntimeOf,
  readReadGraphRegistry,
  registeredSubGraphNames,
  workingMemoryIdentityRule,
  type ReadGraphBuilderStatus,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

export type ReadGraphMode = 'off' | 'build' | 'serve';

/** The modes until the node's settings carry them: every read graph is off. */
export const READ_GRAPHS_OFF: ReadGraphModesV1 = Object.freeze({ modeOf: () => 'off', keepsAny: () => false });

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
  readonly modes?: ReadGraphModesV1;
  /** The time between the builder's passes. */
  readonly intervalMs?: number;
}

const SHARED_LAYERS = [MemoryLayer.VerifiableMemory, MemoryLayer.SharedWorkingMemory] as const;

/** The agent's read-graph builder, as one of its background workloads. */
export class ReadGraphWorkloadOwnerV1 {
  readonly #agent: ReadGraphAgentViewV1;
  readonly #options: ReadGraphWorkloadOptionsV1;
  readonly #modes: ReadGraphModesV1;
  #builder: ReadGraphBuilder | undefined;
  #identity: string | undefined;

  constructor(agent: ReadGraphAgentViewV1, options: ReadGraphWorkloadOptionsV1) {
    this.#agent = agent;
    this.#options = options;
    this.#modes = options.modes ?? READ_GRAPHS_OFF;
  }

  /** Start the builder, when any read graph may be kept. */
  start(ctx: OperationContext): void {
    if (this.#builder || !this.#modes.keepsAny()) return;
    const { logger } = this.#options;
    this.#builder = new ReadGraphBuilder({
      store: this.#agent.store,
      dataDir: this.#options.dataDir,
      wanted: (signal) => this.wanted(signal),
      intervalMs: this.#options.intervalMs,
      log: (line) => logger.info(ctx, line),
      warn: (line) => logger.warn(ctx, line),
    });
    this.#builder.start();
  }

  whenIdle(): Promise<void> {
    return this.#builder?.whenIdle() ?? Promise.resolve();
  }

  /** Stop the builder: no new pass, and the job in progress is aborted and waited for. */
  async close(): Promise<void> {
    const builder = this.#builder;
    this.#builder = undefined;
    await builder?.close();
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

  /**
   * Set the node's identity rule on the store's read-graph runtime. When it
   * changes after it was first set, every working-memory read graph is marked
   * dirty before the new rule applies, because it was built under the old one.
   * Start-up has already marked them dirty once.
   */
  async syncIdentity(signal?: AbortSignal): Promise<void> {
    const runtime = readGraphRuntimeOf(this.#agent.store);
    if (!runtime) return;
    const node = { defaultAgentAddress: this.#agent.getDefaultAgentAddress(), peerId: this.#agent.peerId };
    const identity = JSON.stringify([node.defaultAgentAddress ?? null, node.peerId]);
    if (identity === this.#identity) return;
    if (this.#identity !== undefined) {
      for (const row of runtime.mirror.rows()) {
        if (parseReadGraphIri(row.readGraph)?.layer !== MemoryLayer.WorkingMemory) continue;
        await markReadGraphDirty({ store: this.#agent.store, dataDir: this.#options.dataDir, ...(signal ? { signal } : {}) }, row.readGraph);
      }
    }
    runtime.workingMemoryIdentity = workingMemoryIdentityRule(node);
    this.#identity = identity;
  }
}

/** The agent's read-graph workload. */
export function createReadGraphWorkloadV1(agent: ReadGraphAgentViewV1, options: ReadGraphWorkloadOptionsV1): ReadGraphWorkloadOwnerV1 {
  return new ReadGraphWorkloadOwnerV1(agent, options);
}
