// SPDX-License-Identifier: Apache-2.0

/** One node lifetime for asynchronous work shared across agent subsystems.
 * Cancellation fences callers; physical ownership remains until dependencies settle.
 * Reopening never makes a continuation captured before close current again. */
export class AgentWorkLifetime {
  private controller = new AbortController();
  private epoch = 0;
  readonly physicalRuns = new Set<Promise<unknown>>();

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
    this.physicalRuns.add(run);
    const retire = () => { this.physicalRuns.delete(run); };
    void run.then(retire, retire);
    return run;
  }

  async drain(): Promise<void> {
    await drainPhysicalWork(this.physicalRuns);
  }
}

/** Resample all owners together: retiring dependencies may enqueue store work. */
export async function drainPhysicalWork(
  ...owners: Array<Set<Promise<unknown>> | undefined>
): Promise<void> {
  const sets = owners.filter((owner): owner is Set<Promise<unknown>> => owner !== undefined);
  while (sets.some(owner => owner.size > 0)) {
    const runs = sets.flatMap(owner => [...owner]);
    await Promise.allSettled(runs);
    for (const owner of sets) for (const run of runs) owner.delete(run);
  }
}
