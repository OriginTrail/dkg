// The daemon's subscribe job awaits `catchupRunner.run(...)` in a
// fire-and-forget async IIFE with no timeout of its own. `close()` terminates
// the Worker, and a terminated worker emits 'exit' — never 'error' — so before
// this fix a pending run promise was simply never settled and the job stayed
// `running` with no `finishedAt` for the rest of the process's life. Issue #2006
// makes that reachable routinely, because a walk can be in flight much longer.
//
// `node:worker_threads` is mocked with a minimal fake Worker rather than
// spawning a real thread: nesting a real worker inside vitest's multi-file pool
// does not boot reliably, and the contract under test is this file's own
// handler wiring, not Node's (documented) 'exit'-on-terminate behaviour.
import { describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '@origintrail-official/dkg-agent';

type Listener = (...args: unknown[]) => void;

const workerControl = vi.hoisted(() => {
  const state = {
    listeners: new Map<string, Listener[]>(),
    posted: [] as unknown[],
    terminated: false,
  };
  class FakeWorker {
    constructor(_path: string) {
      state.listeners.clear();
      state.posted.length = 0;
      state.terminated = false;
    }

    on(event: string, listener: Listener) {
      const existing = state.listeners.get(event) ?? [];
      existing.push(listener);
      state.listeners.set(event, existing);
    }

    postMessage(message: unknown) {
      state.posted.push(message);
    }

    async terminate() {
      state.terminated = true;
      // Node emits 'exit' for a terminated worker, with code 1. It does NOT
      // emit 'error' — which is exactly why the 'exit' handler is needed.
      for (const listener of state.listeners.get('exit') ?? []) listener(1);
      return 1;
    }
  }
  return { state, FakeWorker };
});

vi.mock('node:worker_threads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:worker_threads')>()),
  Worker: workerControl.FakeWorker,
}));

const { createCatchupRunner } = await import('../src/catchup-runner.js');

const stubAgent = {} as unknown as DKGAgent;

/** Fail fast on a regression: an unsettled run must not burn the test timeout. */
function withinTick<T>(promise: Promise<T>): Promise<T | 'still-pending'> {
  return Promise.race([
    promise,
    new Promise<'still-pending'>((resolve) => { setTimeout(() => resolve('still-pending'), 500); }),
  ]);
}

describe('WorkerCatchupRunner lifecycle', () => {
  it('rejects an in-flight run when the worker exits instead of leaving it pending forever', async () => {
    const runner = createCatchupRunner(stubAgent);
    const run = runner.run({ contextGraphId: 'cg-hang', includeSharedMemory: false });
    const settled = run.then(() => 'resolved' as const, (error: Error) => error);

    // The run was dispatched and is awaiting a `run-result` that will never come.
    expect(workerControl.state.posted).toHaveLength(1);
    expect(workerControl.state.posted[0]).toMatchObject({ type: 'run' });

    await runner.close();

    const outcome = await withinTick(settled);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain('exited');
  });

  it('fails a run started after the worker died instead of posting into the void', async () => {
    // The pending-run case alone is not enough: the runner is constructed once
    // per daemon, and `postMessage` to a dead worker neither throws nor
    // delivers, so without the latch every LATER subscribe hung too.
    const runner = createCatchupRunner(stubAgent);
    await runner.close();
    const postedBeforeLaterRun = workerControl.state.posted.length;

    const later = runner.run({ contextGraphId: 'cg-later', includeSharedMemory: false })
      .then(() => 'resolved' as const, (error: Error) => error);

    const outcome = await withinTick(later);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain('exited');
    // …and it must not have queued work onto the dead worker.
    expect(workerControl.state.posted).toHaveLength(postedBeforeLaterRun);
  });

  it('rejects every pending run exactly once', async () => {
    const runner = createCatchupRunner(stubAgent);
    const first = runner.run({ contextGraphId: 'cg-a', includeSharedMemory: false })
      .then(() => 'resolved' as const, () => 'rejected' as const);
    const second = runner.run({ contextGraphId: 'cg-b', includeSharedMemory: true })
      .then(() => 'resolved' as const, () => 'rejected' as const);

    await runner.close();
    // A second close (or a late 'error' after 'exit') must not double-settle.
    await runner.close();

    await expect(withinTick(Promise.all([first, second])))
      .resolves.toEqual(['rejected', 'rejected']);
  });
});
