// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';

type Running<Detail> = Detail & { id: string; startedAt: number; state: 'running' };
type Job<Result, Detail, Terminal> = Running<Detail> | (Detail & Terminal & {
  id: string; startedAt: number;
} & ({ state: 'complete'; result: Result } | { state: 'failed'; error: string }));

/** Each route owns a separate tracker; admission and terminal bookkeeping share one lifecycle. */
export function createSnapshotJobTracker<Result, Detail extends object, Terminal extends object>(
  terminalFields: () => Terminal,
) {
  const jobs = new WeakMap<object, Job<Result, Detail, Terminal>>();
  return {
    get: (owner: object) => jobs.get(owner),
    isRunning: (owner: object) => jobs.get(owner)?.state === 'running',
    start(owner: object, detail: Detail, operation: () => Promise<Result>): Running<Detail> | undefined {
      // Atomic recheck after the route has awaited and validated its request body.
      if (jobs.get(owner)?.state === 'running') return undefined;
      const job: Running<Detail> = { ...detail, id: randomUUID(), startedAt: Date.now(), state: 'running' };
      jobs.set(owner, job);
      void Promise.resolve().then(operation).then(
        result => { jobs.set(owner, { ...job, ...terminalFields(), state: 'complete', result }); },
        error => { jobs.set(owner, { ...job, ...terminalFields(), state: 'failed',
          error: error instanceof Error ? error.message : String(error) }); },
      );
      return job;
    },
  };
}
