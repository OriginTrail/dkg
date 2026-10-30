// SPDX-License-Identifier: Apache-2.0

/** One node lifetime for asynchronous work shared across agent subsystems.
 * Cancellation fences callers; physical ownership remains until dependencies settle.
 * Reopening never makes a continuation captured before close current again. */
export class AgentWorkLifetime {
  private controller = new AbortController();
  private epoch = 0;
  private readonly runs = new Set<Promise<unknown>>();

  /** Read-only diagnostics; tracking owns retirement of every physical run. */
  get physicalRuns(): ReadonlySet<Promise<unknown>> { return this.runs; }

  get signal(): AbortSignal { return this.controller.signal; }
  get generation(): number { return this.epoch; }
  get closed(): boolean { return this.signal.aborted; }

  close(reason?: unknown): void {
    if (this.closed) return;
    this.epoch++;
    this.controller.abort(reason);
  }

  open(): void {
    if (this.closed) this.controller = new AbortController();
  }

  track<T>(run: Promise<T>): Promise<T> {
    this.runs.add(run);
    const retire = () => { this.runs.delete(run); };
    void run.then(retire, retire);
    return run;
  }

  async drain(): Promise<void> {
    // A retiring dependency may enqueue writes or cleanup on the same owner.
    // Only track() retires entries; resample until all physical work settles.
    while (this.runs.size > 0) await Promise.allSettled(this.runs);
  }
}
