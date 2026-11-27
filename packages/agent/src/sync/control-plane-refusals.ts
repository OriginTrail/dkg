import { createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';
import type { SyncBackpressureBusyError } from './backpressure.js';
import { normalizeSyncAdmissionSource, type SyncAdmissionSource, type SyncSchedulerLane } from './policy.js';

/**
 * One log line per interval, with a count, for control-plane fetches and
 * durable syncs refused for want of a sync slot.
 *
 * A standalone control-plane fetch (a curator metadata refresh, see
 * `control-plane-reserve.ts`) that finds every general slot and its reserved
 * slot busy is refused at once, and its caller asks again later. Logged one by
 * one, each refusal is two lines, the admission's and the refresh's warning;
 * after a restart a busy Core refuses dozens to hundreds of them per 10
 * minutes, and they change nothing the node holds. A durable sync refused at
 * once is deferred and asked again later in the same way: while one graph's
 * catch-up holds the slot, the others are refused up to hundreds of times a
 * minute. Every other refusal, and work that ends any other way (displaced,
 * timed out, failed), logs a line of its own.
 *
 * Each node owns one summary (`DKGAgentBase.controlPlaneRefusals`), written
 * through its logger; the admission reaches it through `syncRefusalReporter`.
 */
export const CONTROL_PLANE_REFUSAL_SUMMARY_INTERVAL_MS = 10 * 60_000;

/** Distinct graphs counted per label and interval. The refusal count itself is exact. */
export const CONTROL_PLANE_REFUSAL_MAX_COUNTED_GRAPHS = 256;

interface RefusalTally {
  count: number;
  readonly graphs: Set<string>;
  lastState: string;
}

export interface ControlPlaneRefusalSummaryOptions {
  emit: (message: string) => void;
  intervalMs?: number;
  /** Wall clock of the interval span in the line. */
  now?: () => number;
}

export class ControlPlaneRefusalSummary {
  private readonly tallies = new Map<string, RefusalTally>();
  private readonly stopSignals = new WeakSet<AbortSignal>();
  private readonly intervalMs: number;
  private readonly now: () => number;
  private startedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: ControlPlaneRefusalSummaryOptions) {
    this.intervalMs = options.intervalMs ?? CONTROL_PLANE_REFUSAL_SUMMARY_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Count one refusal. The first refusal of an interval starts that interval.
   * `stop`, the node's stop signal, ends it early: a node that stops logs what
   * it counted, and a refusal counted after that is logged at once.
   */
  note(label: string, state: string, contextGraphId?: string, stop?: AbortSignal): void {
    if (this.timer === undefined) {
      this.startedAt = this.now();
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
      this.timer.unref?.();
    }
    let tally = this.tallies.get(label);
    if (!tally) {
      tally = { count: 0, graphs: new Set(), lastState: state };
      this.tallies.set(label, tally);
    }
    tally.count += 1;
    tally.lastState = state;
    if (contextGraphId !== undefined && tally.graphs.size < CONTROL_PLANE_REFUSAL_MAX_COUNTED_GRAPHS) {
      tally.graphs.add(contextGraphId);
    }
    if (stop && !this.stopSignals.has(stop)) {
      this.stopSignals.add(stop);
      stop.addEventListener('abort', () => this.flush(), { once: true });
    }
    if (stop?.aborted) this.flush();
  }

  /** Log the open interval now, one line per label, and start the next one empty. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const seconds = Math.max(1, Math.round((this.now() - this.startedAt) / 1000));
    const lines = [...this.tallies].map(([label, tally]) => {
      const graphs = tally.graphs.size >= CONTROL_PLANE_REFUSAL_MAX_COUNTED_GRAPHS
        ? `at least ${tally.graphs.size}`
        : `${tally.graphs.size}`;
      return `Sync backpressure rejected ${label} ${tally.count} time(s) in the last ${seconds} s `
        + `for ${graphs} graph(s), each asked again later (last: ${tally.lastState})`;
    });
    this.tallies.clear();
    for (const line of lines) {
      try {
        this.options.emit(line);
      } catch {
        // Logging must never break sync admission.
      }
    }
  }
}

/** A node's summary, written as warnings through its logger. */
export function controlPlaneRefusalSummary(
  log: { warn(ctx: OperationContext, message: string): void },
): ControlPlaneRefusalSummary {
  return new ControlPlaneRefusalSummary({ emit: (message) => log.warn(createOperationContext('sync'), message) });
}

/**
 * The refusal reporter of one admission (`withGlobalSyncBackpressure`'s
 * `reportRefusal`): a control-plane fetch or a durable sync refused at once is
 * counted in `summary`, which logs its open interval when `stop` (the node's
 * stop signal) fires, and every other refusal, or any without a summary, is
 * one `logInfo` line. Durable syncs are counted per admission source
 * (`durable:vm-recovery`, `durable:on-connect`, …), not per graph and peer.
 */
export function syncRefusalReporter(
  admission: { label: string; lane?: SyncSchedulerLane; source?: SyncAdmissionSource; contextGraphId?: string },
  summary: ControlPlaneRefusalSummary | undefined,
  logInfo: (ctx: OperationContext, message: string) => void,
  stop?: AbortSignal,
): (ctx: OperationContext, error: SyncBackpressureBusyError) => void {
  const label = admission.source === 'control-plane'
    ? admission.label
    : admission.lane === 'durable' ? `durable:${normalizeSyncAdmissionSource(admission.source)}` : undefined;
  return (ctx, error) => {
    if (summary && label !== undefined && error.state !== undefined) {
      summary.note(label, error.state, admission.contextGraphId, stop);
    } else {
      logInfo(ctx, error.message);
    }
  };
}
