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
 * a changed membership marks its read graphs dirty. After the builds it
 * removes, contents and row, every read graph whose mode is `off` that the
 * mirror still holds or whose drop was asked for (`./drop-requests.ts`).
 * Jobs run one at a time per backend (`withReadGraphBackgroundSlot`), on the
 * store's background lane. A job that fails is tried again after a delay that
 * doubles up to ten minutes; one that a newer change of its row overtook is
 * tried again at the next pass. `close()` aborts the job in progress and
 * waits for it.
 */

import { AsyncResource } from 'node:async_hooks';
import { CoalescingRecurringTask, compareCodePoint, parseReadGraphIri, readGraphIri, type ReadGraphKey } from '@origintrail-official/dkg-core';
import { withDefaultStoreWorkPriority } from '../store-priority-scheduler.js';
import type { TripleStore } from '../triple-store.js';
import { forgetReadGraphBuildRequest, forgetReadGraphDropRequest, readGraphBuildRequests, readGraphDropRequests } from './drop-requests.js';
import { readGraphRuntimeOf } from './read-graph-store.js';
import { buildReadGraph, refreshReadGraphRegistry, removeReadGraph, type ReadGraphBatching, type ReadGraphJobResult } from './rebuild.js';
import type { ReadGraphBackendRuntime } from './runtime.js';
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
  /**
   * Whether the node keeps no read graph for a key: its mode is `off`. Such a
   * read graph is not built, and is removed when the mirror holds it or its
   * drop was asked for. Without it, nothing is removed.
   */
  readonly off?: (key: ReadGraphKey) => boolean;
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
  /**
   * How much of that job is done, from 0 to 1: member graphs copied of those
   * it copies, 0 while it empties the read graph first. Absent while nothing
   * is built.
   */
  readonly progress?: number;
  /** Read graphs the last pass found to build, the one in progress included. */
  readonly pending: number;
  /** Read graphs whose mode is `off` that the last pass found to remove, the one in progress included. */
  readonly removing: number;
  readonly retrying: readonly { readonly readGraph: string; readonly attempts: number; readonly retryAt: number; readonly error?: string }[];
  readonly lastJob: ReadGraphJobResult | undefined;
}

/** A read graph's size at a build: its triples (absent when the count failed), and its member graphs that a listing found. */
export interface ReadGraphBuiltSize {
  readonly triples?: number;
  readonly members?: number;
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
  /** Each read graph's size at its last build by this builder. */
  readonly #built = new Map<string, ReadGraphBuiltSize>();
  #building: string | undefined;
  #progress: number | undefined;
  #pending = 0;
  #removing = 0;
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
      ...(this.#building !== undefined && this.#progress !== undefined ? { progress: this.#progress } : {}),
      pending: this.#pending,
      removing: this.#removing,
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
    const off = this.#options.off ?? (() => false);
    const jobs = new Map<string, ReadGraphKey>();
    for (const key of await this.#options.wanted(signal)) {
      const readGraph = readGraphIri(key);
      if (servingReadGraphGeneration(runtime.mirror.get(readGraph), versions) === undefined) jobs.set(readGraph, key);
    }
    for (const row of runtime.mirror.rows()) {
      const key = parseReadGraphIri(row.readGraph);
      if (key && servingReadGraphGeneration(row, versions) === undefined) jobs.set(row.readGraph, key);
    }
    // Read graphs a switch on could not take into service, which the node may not list among those it wants.
    for (const readGraph of readGraphBuildRequests(runtime)) {
      const key = parseReadGraphIri(readGraph);
      if (key === undefined || off(key) || servingReadGraphGeneration(runtime.mirror.get(readGraph), versions) !== undefined) {
        forgetReadGraphBuildRequest(runtime, readGraph);
      } else {
        jobs.set(readGraph, key);
      }
    }
    for (const [readGraph, key] of jobs) if (off(key)) jobs.delete(readGraph);
    // A retry is kept only for a read graph that is still to build or to remove.
    const removable = new Set(this.#removals(runtime, off));
    for (const readGraph of this.#retries.keys()) if (!jobs.has(readGraph) && !removable.has(readGraph)) this.#retries.delete(readGraph);
    const now = this.#options.now ?? Date.now;
    const due = [...jobs].filter(([readGraph]) => (this.#retries.get(readGraph)?.retryAt ?? 0) <= now())
      .sort(([left], [right]) => compareCodePoint(left, right));
    this.#pending = due.length;
    // One relevance per job, from the read graph's mode: checked before it runs, and by the job under the read graph's lock.
    for (const [readGraph, key] of due) {
      this.#building = readGraph;
      this.#progress = 0;
      const progress = (copied: number, total: number) => {
        this.#progress = total === 0 ? 1 : copied / total;
      };
      const relevant = () => !off(key);
      try {
        const result = await this.#run(readGraph, relevant, signal, 'built', () => buildReadGraph({ ...context, progress, relevant }, key));
        // Built, current, or switched off: a build asked for is no longer. One lost or failed while still on is tried again.
        if (result === 'skipped' || (typeof result === 'object' && (result.outcome !== 'lost' || !relevant()))) {
          forgetReadGraphBuildRequest(runtime, readGraph);
        }
        if (typeof result === 'object' && result.outcome === 'done') await this.#report(result, signal);
      } finally {
        this.#building = undefined;
        this.#progress = undefined;
        this.#pending -= 1;
      }
    }
    // After the builds, so a read graph switched off meanwhile is removed in this pass.
    const removals = this.#removals(runtime, off).filter((readGraph) => (this.#retries.get(readGraph)?.retryAt ?? 0) <= now());
    this.#removing = removals.length;
    for (const readGraph of removals) {
      const key = parseReadGraphIri(readGraph)!;
      const relevant = () => off(key);
      try {
        const result = await this.#run(readGraph, relevant, signal, 'removed', () => removeReadGraph({ ...context, relevant }, readGraph));
        if (result === 'failed') continue;
        if (result !== 'skipped' && result.outcome !== 'lost') this.#built.delete(readGraph);
        // Removed, with nothing left to remove, or on again: the drop is no longer asked for. One lost while still off is tried again.
        if (result === 'skipped' || result.outcome !== 'lost' || !off(key)) forgetReadGraphDropRequest(runtime, readGraph);
      } finally {
        this.#removing -= 1;
      }
    }
    return 'rearm';
  }

  /**
   * The read graphs whose mode is `off` to remove: those the mirror holds and
   * those whose drop was asked for. A drop asked for a read graph whose mode is
   * on again is forgotten.
   */
  #removals(runtime: ReadGraphBackendRuntime, off: (key: ReadGraphKey) => boolean): string[] {
    if (!this.#options.off) return [];
    const removals = new Set(runtime.mirror.rows().map((row) => row.readGraph));
    for (const readGraph of readGraphDropRequests(runtime)) removals.add(readGraph);
    return [...removals].filter((readGraph) => {
      const key = parseReadGraphIri(readGraph);
      if (key !== undefined && off(key)) return true;
      forgetReadGraphDropRequest(runtime, readGraph);
      return false;
    }).sort(compareCodePoint);
  }

  /**
   * Run one job, a build or a removal, on the store's background lane while it
   * stays relevant: one that no longer is, is skipped. One that a newer change
   * of its row overtook is tried again at a later pass only while it is still
   * relevant; one that fails, after the retry delay.
   */
  async #run(
    readGraph: string,
    relevant: () => boolean,
    signal: AbortSignal,
    failure: string,
    job: () => Promise<ReadGraphJobResult>,
  ): Promise<ReadGraphJobResult | 'skipped' | 'failed'> {
    signal.throwIfAborted();
    if (!relevant()) {
      this.#retries.delete(readGraph);
      return 'skipped';
    }
    try {
      const result = await withDefaultStoreWorkPriority('background', job);
      this.#lastJob = result;
      if (result.outcome === 'lost' && relevant()) this.#retry(readGraph);
      else this.#retries.delete(readGraph);
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      this.#retry(readGraph, error);
      this.#options.warn?.(`Read graph ${readGraph} could not be ${failure}: ${messageOf(error)}`);
      return 'failed';
    }
  }

  #retry(readGraph: string, error?: unknown): void {
    const attempts = (this.#retries.get(readGraph)?.attempts ?? 0) + 1;
    const delay = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (attempts - 1));
    const now = this.#options.now ?? Date.now;
    this.#retries.set(readGraph, { attempts, retryAt: now() + delay, ...(error === undefined ? {} : { error: messageOf(error) }) });
  }

  /**
   * A read graph's size when this builder last built it: writes since then
   * make it drift. `undefined` for one it has not built, and once it removed
   * it.
   */
  atLastBuild(readGraph: string): ReadGraphBuiltSize | undefined {
    return this.#built.get(readGraph);
  }

  /** Count a finished build's triples, for {@link atLastBuild} and the log. */
  async #report(result: ReadGraphJobResult, signal: AbortSignal): Promise<void> {
    let triples: number | undefined;
    try {
      const counted = await readGraphPartitionMaintenanceStore(this.#options.store).query(readGraphSizeQuery(result.readGraph),
        { priority: 'background', source: 'storage.readGraphBuild', signal });
      const value = counted.type === 'bindings' ? counted.bindings[0]?.n : undefined;
      const parsed = value === undefined ? Number.NaN : Number(value.replace(/^"([^"]*)".*$/, '$1'));
      if (Number.isSafeInteger(parsed) && parsed >= 0) triples = parsed;
    } catch {
      // The size is for the status and the log only.
    }
    this.#built.set(result.readGraph, Object.freeze({
      ...(triples !== undefined ? { triples } : {}),
      ...(result.listed !== undefined ? { members: result.listed } : {}),
    }));
    this.#options.log?.(`Built read graph ${result.readGraph} in ${result.durationMs} ms, ${result.batches} batch(es)${triples === undefined ? '' : `, ${triples} triple(s)`}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
