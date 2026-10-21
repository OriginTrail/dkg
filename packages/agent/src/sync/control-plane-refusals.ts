import { createOperationContext, Logger } from '@origintrail-official/dkg-core';

/**
 * One log line per interval, with a count, for control-plane fetches refused
 * for want of a sync slot.
 *
 * A standalone control-plane fetch (a curator metadata refresh, see
 * `control-plane-reserve.ts`) that finds every general slot and its reserved
 * slot busy is refused at once, and its caller asks again later. Logged one by
 * one, each refusal is two lines, the admission's and the refresh's warning;
 * after a restart a busy Core refuses dozens to hundreds of them per 10
 * minutes, and they change nothing the node holds. Every other refusal, and a
 * control-plane fetch that ends any other way (displaced, timed out, failed),
 * logs a line of its own.
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
  private readonly intervalMs: number;
  private readonly now: () => number;
  private startedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: ControlPlaneRefusalSummaryOptions) {
    this.intervalMs = options.intervalMs ?? CONTROL_PLANE_REFUSAL_SUMMARY_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Count one refusal. The first refusal of an interval starts that interval. */
  note(label: string, state: string, contextGraphId?: string): void {
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

const log = new Logger('DKGAgent');

/** The summary of the node-wide sync scheduler (`backpressure.ts`). */
export const controlPlaneRefusals = new ControlPlaneRefusalSummary({
  emit: (message) => log.warn(createOperationContext('sync'), message),
});
