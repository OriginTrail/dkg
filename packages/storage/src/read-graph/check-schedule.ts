// SPDX-License-Identifier: Apache-2.0
import { CoalescingRecurringTask, compareCodePoint, getMetrics } from '@origintrail-official/dkg-core';
import type { TripleStore } from '../triple-store.js';
import { checkReadGraph, type ReadGraphCheckMode, type ReadGraphCheckOptions } from './check.js';
import { readGraphLayerOf } from './read-graph-store.js';
import { withReadGraphBackgroundSlot } from './rebuild.js';
import { READ_GRAPH_STATES } from './state.js';

export interface ReadGraphCheckScheduleOptions extends Omit<ReadGraphCheckOptions, 'signal'> {
  /** Between two sampled passes. */
  readonly sampledIntervalMs?: number;
  /** Read graphs one sampled pass checks, taken in turn. */
  readonly sampledPerPass?: number;
  /** Between two full passes. */
  readonly fullIntervalMs?: number;
  /** Receives a check that failed with an error; the pass goes on with the next read graph. */
  readonly onError?: (error: unknown, readGraph: string | undefined) => void;
}

export const READ_GRAPH_CHECK_DEFAULTS = Object.freeze({
  sampledIntervalMs: 60_000,
  sampledPerPass: 8,
  fullIntervalMs: 6 * 60 * 60_000,
});

/**
 * Start the background checks of a store's read graphs. Whatever starts the
 * read-graph background work calls this once, and `close()` on the result once
 * when that work stops: it ends the schedule, aborts a running pass and waits
 * for it.
 */
export function startReadGraphChecks(store: TripleStore, options: ReadGraphCheckScheduleOptions = {}): ReadGraphCheckSchedule {
  const schedule = new ReadGraphCheckSchedule(store, options);
  schedule.start();
  return schedule;
}

/**
 * The background checks of one store's read graphs: a sampled pass every
 * `sampledIntervalMs`, over a few `ready` read graphs taken in turn, and a full
 * pass over every `ready` read graph every `fullIntervalMs` or on request.
 * Every pass first records how many read graphs the state mirror holds in each
 * state. A store without the read-graph layer, or with no read graphs, makes
 * every pass a no-op. Passes run one at a time per kind, on the background
 * lane, and each check takes the backend's background slot
 * (`withReadGraphBackgroundSlot`), so it never runs beside a build, a repair
 * or another check. A check that fails is reported and the pass goes on.
 */
export class ReadGraphCheckSchedule {
  private readonly sampled: CoalescingRecurringTask;
  private readonly full: CoalescingRecurringTask;
  private readonly sampledIntervalMs: number;
  private readonly sampledPerPass: number;
  private readonly fullIntervalMs: number;
  private cursor = 0;

  constructor(private readonly store: TripleStore, private readonly options: ReadGraphCheckScheduleOptions = {}) {
    this.sampledIntervalMs = options.sampledIntervalMs ?? READ_GRAPH_CHECK_DEFAULTS.sampledIntervalMs;
    this.sampledPerPass = options.sampledPerPass ?? READ_GRAPH_CHECK_DEFAULTS.sampledPerPass;
    this.fullIntervalMs = options.fullIntervalMs ?? READ_GRAPH_CHECK_DEFAULTS.fullIntervalMs;
    const onError = (error: unknown) => this.report(error, undefined);
    this.sampled = new CoalescingRecurringTask({
      retryIntervalMs: this.sampledIntervalMs,
      requestWhileRunning: 'drop',
      runPass: (signal) => this.pass('sampled', signal),
      onError,
      closingMessage: 'Read-graph checks are stopping',
    });
    this.full = new CoalescingRecurringTask({
      retryIntervalMs: this.fullIntervalMs,
      runPass: (signal) => this.pass('full', signal),
      onError,
      closingMessage: 'Read-graph checks are stopping',
    });
  }

  /** Arm both passes: the first sampled pass after one interval, the first full pass after one full interval. */
  start(): void {
    this.sampled.schedule(this.sampledIntervalMs);
    this.full.schedule(this.fullIntervalMs);
  }

  /** Run a sampled pass now, unless one is running. */
  requestSampledCheck(): boolean {
    return this.sampled.request();
  }

  /** Run a full pass now, or right after the one that is running. */
  requestFullCheck(): boolean {
    return this.full.request();
  }

  /** Wait until no pass runs. */
  async whenIdle(): Promise<void> {
    await Promise.all([this.sampled.whenIdle(), this.full.whenIdle()]);
  }

  /**
   * End the schedule: no pass starts again, a running pass is aborted at its
   * next store call or yield, and this waits for it to end. Later requests
   * return false.
   */
  async close(): Promise<void> {
    await Promise.all([this.sampled.close(), this.full.close()]);
  }

  private async pass(mode: ReadGraphCheckMode, signal: AbortSignal): Promise<'rearm'> {
    // A sampled check holds a read graph's lock, and a full check reruns a chunk
    // that any lock request overlapped. So sampled passes wait while a full pass
    // runs, and a full pass starts once a running sampled pass has ended.
    if (mode === 'sampled' && this.full.running) return 'rearm';
    if (mode === 'full') await this.sampled.whenIdle();
    const layer = readGraphLayerOf(this.store);
    if (!layer) return 'rearm';
    const rows = layer.runtime.mirror.rows();
    recordStates(rows.map((row) => row.state));
    const ready = rows.filter((row) => row.state === 'ready').map((row) => row.readGraph).sort(compareCodePoint);
    let selected = ready;
    if (mode === 'sampled' && ready.length > this.sampledPerPass) {
      const start = this.cursor % ready.length;
      selected = [...ready.slice(start), ...ready.slice(0, start)].slice(0, this.sampledPerPass);
      this.cursor = start + this.sampledPerPass;
    }
    for (const readGraph of selected) {
      signal.throwIfAborted();
      try {
        await withReadGraphBackgroundSlot(layer.runtime, async () => {
          signal.throwIfAborted();
          return checkReadGraph(this.store, readGraph, mode, { ...this.options, signal });
        });
      } catch (error) {
        if (signal.aborted) throw error;
        this.report(error, readGraph);
      }
    }
    return 'rearm';
  }

  private report(error: unknown, readGraph: string | undefined): void {
    if (this.options.onError) {
      this.options.onError(error, readGraph);
      return;
    }
    const where = readGraph ? ` of <${readGraph}>` : '';
    console.warn(`[read-graph-check] A check${where} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function recordStates(states: readonly string[]): void {
  try {
    const gauge = getMetrics().storeReadGraphs;
    for (const state of READ_GRAPH_STATES) gauge.record(states.filter((value) => value === state).length, { state });
  } catch {
    // Telemetry must never stop a pass.
  }
}
