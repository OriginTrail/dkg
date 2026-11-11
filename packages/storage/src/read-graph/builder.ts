// SPDX-License-Identifier: Apache-2.0

/**
 * The read-graph builder: the background worker that keeps a node's read
 * graphs built. Each pass builds every read graph the node wants that has no
 * row, and every read graph in the backend's mirror that is not ready, one job
 * at a time (`buildReadGraph`). There is no wake-up from the layer: a pass
 * runs at start and then at an interval, and reads the mirror, which is in
 * memory.
 *
 * Each pass first refreshes the registry of every context graph with rows, so
 * a changed membership marks its read graphs dirty. Jobs run one at a time per
 * backend (`withReadGraphBackgroundSlot`), on the store's background lane.
 * A job that fails is tried again after a delay that doubles up to ten
 * minutes; one that a newer change of its row overtook is tried again at the
 * next pass. `close()` aborts the job in progress and waits for it.
 */

import { AsyncResource } from 'node:async_hooks';
import { CoalescingRecurringTask, compareCodePoint, parseReadGraphIri, readGraphIri, type ReadGraphKey } from '@origintrail-official/dkg-core';
import { withDefaultStoreWorkPriority } from '../store-priority-scheduler.js';
import type { TripleStore } from '../triple-store.js';
import { readGraphRuntimeOf } from './read-graph-store.js';
import { buildReadGraph, refreshReadGraphRegistry, type ReadGraphBatching, type ReadGraphJobResult } from './rebuild.js';
import { CURRENT_READ_GRAPH_VERSIONS, servingReadGraphGeneration, type ReadGraphVersions } from './state.js';
import { readGraphSizeQuery } from './statements.js';
import { readGraphPartitionMaintenanceStore } from '../read-graph-partition-store.js';

export const DEFAULT_READ_GRAPH_BUILD_INTERVAL_MS = 30_000;
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 10 * 60_000;

export interface ReadGraphBuilderOptions {
  /** A store object over the backend, as `createTripleStore` builds it. */
  readonly store: TripleStore;
  readonly dataDir?: string;
  /** The read graphs the node keeps at `build` or `serve`; one without a row is created. */
  readonly wanted: (signal: AbortSignal) => readonly ReadGraphKey[] | Promise<readonly ReadGraphKey[]>;
  /** The time between passes. */
  readonly intervalMs?: number;
  readonly batching?: Partial<ReadGraphBatching>;
  readonly versions?: ReadGraphVersions;
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
  /** The clock of the retry delays. */
  readonly now?: () => number;
}

/** What the builder is doing, for an operator. */
export interface ReadGraphBuilderStatus {
  readonly running: boolean;
  /** The read graph of the job in progress. */
  readonly building: string | undefined;
  /** Read graphs the last pass found to build, the one in progress included. */
  readonly pending: number;
  readonly retrying: readonly { readonly readGraph: string; readonly attempts: number; readonly retryAt: number; readonly error?: string }[];
  readonly lastJob: ReadGraphJobResult | undefined;
}

interface Retry {
  readonly attempts: number;
  readonly retryAt: number;
  readonly error?: string;
}

export class ReadGraphBuilder {
  readonly #options: ReadGraphBuilderOptions;
  readonly #task: CoalescingRecurringTask;
  readonly #retries = new Map<string, Retry>();
  #building: string | undefined;
  #pending = 0;
  #lastJob: ReadGraphJobResult | undefined;

  constructor(options: ReadGraphBuilderOptions) {
    this.#options = options;
    // Passes run in the context the builder was made in, not in that of a caller that asks for one.
    const pass = AsyncResource.bind((signal: AbortSignal) => this.#pass(signal));
    this.#task = new CoalescingRecurringTask({
      retryIntervalMs: options.intervalMs ?? DEFAULT_READ_GRAPH_BUILD_INTERVAL_MS,
      runPass: pass,
      onError: (error) => options.warn?.(`Read-graph build pass failed: ${messageOf(error)}`),
      closingMessage: 'The read-graph builder is closing',
    });
  }

  /** Run a pass now, and then at the interval. */
  start(): void {
    this.#task.request();
  }

  /** Run a pass as soon as the one in progress ends. */
  request(): void {
    this.#task.request();
  }

  whenIdle(): Promise<void> {
    return this.#task.whenIdle();
  }

  /** Stop: no new pass, and the job in progress is aborted and waited for. */
  close(): Promise<void> {
    return this.#task.close();
  }

  status(): ReadGraphBuilderStatus {
    return {
      running: this.#task.running,
      building: this.#building,
      pending: this.#pending,
      retrying: [...this.#retries].map(([readGraph, retry]) => ({ readGraph, ...retry })),
      lastJob: this.#lastJob,
    };
  }

  async #pass(signal: AbortSignal): Promise<'rearm'> {
    const runtime = readGraphRuntimeOf(this.#options.store);
    if (!runtime) return 'rearm';
    const versions = this.#options.versions ?? CURRENT_READ_GRAPH_VERSIONS;
    const context = { store: this.#options.store, dataDir: this.#options.dataDir, signal, versions, batching: this.#options.batching };
    // A registry that changed marks the read graphs built under the old one dirty, ready ones included.
    for (const contextGraphId of runtime.mirror.contextGraphIds()) {
      try {
        await refreshReadGraphRegistry(context, contextGraphId);
      } catch (error) {
        if (signal.aborted) throw error;
        this.#options.warn?.(`The read-graph registry of a context graph could not be read: ${messageOf(error)}`);
      }
    }
    const jobs = new Map<string, ReadGraphKey>();
    for (const key of await this.#options.wanted(signal)) {
      const readGraph = readGraphIri(key);
      if (servingReadGraphGeneration(runtime.mirror.get(readGraph), versions) === undefined) jobs.set(readGraph, key);
    }
    for (const row of runtime.mirror.rows()) {
      const key = parseReadGraphIri(row.readGraph);
      if (key && servingReadGraphGeneration(row, versions) === undefined) jobs.set(row.readGraph, key);
    }
    const now = this.#options.now ?? Date.now;
    const due = [...jobs].filter(([readGraph]) => (this.#retries.get(readGraph)?.retryAt ?? 0) <= now())
      .sort(([left], [right]) => compareCodePoint(left, right));
    this.#pending = due.length;
    for (const [readGraph, key] of due) {
      signal.throwIfAborted();
      this.#building = readGraph;
      try {
        const result = await withDefaultStoreWorkPriority('background', () => buildReadGraph(context, key));
        this.#lastJob = result;
        if (result.outcome === 'lost') this.#retry(readGraph);
        else this.#retries.delete(readGraph);
        if (result.outcome === 'done') await this.#report(result, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        this.#retry(readGraph, error);
        this.#options.warn?.(`Read graph ${readGraph} could not be built: ${messageOf(error)}`);
      } finally {
        this.#building = undefined;
        this.#pending -= 1;
      }
    }
    return 'rearm';
  }

  #retry(readGraph: string, error?: unknown): void {
    const attempts = (this.#retries.get(readGraph)?.attempts ?? 0) + 1;
    const delay = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (attempts - 1));
    const now = this.#options.now ?? Date.now;
    this.#retries.set(readGraph, { attempts, retryAt: now() + delay, ...(error === undefined ? {} : { error: messageOf(error) }) });
  }

  /** Log a finished job with the read graph's size. */
  async #report(result: ReadGraphJobResult, signal: AbortSignal): Promise<void> {
    if (!this.#options.log) return;
    let triples = '';
    try {
      const counted = await readGraphPartitionMaintenanceStore(this.#options.store).query(readGraphSizeQuery(result.readGraph),
        { priority: 'background', source: 'storage.readGraphBuild', signal });
      const value = counted.type === 'bindings' ? counted.bindings[0]?.n : undefined;
      if (value !== undefined) triples = `, ${value.replace(/^"([^"]*)".*$/, '$1')} triple(s)`;
    } catch {
      // The size is for the log only.
    }
    this.#options.log(`Built read graph ${result.readGraph} in ${result.durationMs} ms, ${result.batches} batch(es)${triples}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
