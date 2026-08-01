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

    /** Test-only: deliver a message as if the worker had sent it. */
    static emitToRunner(message: unknown) {
      for (const listener of state.listeners.get('message') ?? []) listener(message);
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

/**
 * The parent-side bridge (`WorkerCatchupRunner.invokeAgent`) is the boundary
 * every worker-impl test stubs out — those tests supply `authoritativePeerId`
 * and observe `source` themselves, so a regression HERE would leave them green
 * while production early-stopped on a stale bootstrap hint or reported
 * foreground catch-up as `unspecified` in scheduler diagnostics.
 */
describe('WorkerCatchupRunner agent bridge', () => {
  function bridgeAgent(overrides: Record<string, unknown> = {}) {
    const calls: Record<string, unknown[][]> = { durable: [], shared: [] };
    let resolutionCalls = 0;
    const agent = {
      isPrivateContextGraph: async () => false,
      resolveSyncPeerWithProvenance: async () => {
        resolutionCalls += 1;
        return { peerId: 'peer-hint', provenance: 'bootstrap-hint' };
      },
      ensurePeerConnected: async () => {},
      primeCatchupConnections: async () => {},
      selectCatchupPeers: (peers: Array<{ toString(): string }>) => peers,
      node: { libp2p: { getConnections: () => [] } },
      syncFromPeerDetailed: async (...args: unknown[]) => {
        calls.durable.push(args);
        return {};
      },
      syncSharedMemoryFromPeerDetailed: async (...args: unknown[]) => {
        calls.shared.push(args);
        return {};
      },
      ...overrides,
    };
    return {
      agent: agent as unknown as DKGAgent,
      calls,
      resolutionCalls: () => resolutionCalls,
    };
  }

  /** Drive one `invoke` through the real bridge and return what it posted back. */
  async function invokeThroughBridge(agent: DKGAgent, method: string, args: unknown[]) {
    createCatchupRunner(agent);
    const before = workerControl.state.posted.length;
    workerControl.FakeWorker.emitToRunner({ type: 'invoke', invokeId: 1, method, args });
    for (let i = 0; i < 50 && workerControl.state.posted.length === before; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return workerControl.state.posted.at(-1) as { result?: any; error?: string };
  }

  it('does not report a bootstrap-hint peer as the catch-up authority', async () => {
    const { agent, resolutionCalls } = bridgeAgent();
    const posted = await invokeThroughBridge(agent, 'prepareCatchup', ['cg-hint']);

    // The hint still ranks the walk…
    expect(posted.result.preferredPeerId).toBe('peer-hint');
    // …but must not be handed to the worker as an authority.
    expect(posted.result.authoritativePeerId).toBeUndefined();
    // …and both notions came from ONE resolution. The resolver reads `_meta`
    // (and may hit the agent registry), and it evicts the bootstrap hint once
    // metadata confirms a curator — so a second call is neither free nor the
    // same call.
    expect(resolutionCalls()).toBe(1);
  });

  it('reports a metadata-resolved curator as the catch-up authority', async () => {
    const { agent, resolutionCalls } = bridgeAgent({
      resolveSyncPeerWithProvenance: async () => ({
        peerId: 'peer-curator',
        provenance: 'metadata',
      }),
    });
    const posted = await invokeThroughBridge(agent, 'prepareCatchup', ['cg-meta']);

    expect(posted.result.preferredPeerId).toBe('peer-curator');
    expect(posted.result.authoritativePeerId).toBe('peer-curator');
    expect(resolutionCalls()).toBe(0);
  });

  it('falls back to ranking alone when the agent predates the provenance resolver', async () => {
    // The bridge talks to whatever agent the daemon composed; one without
    // `resolveSyncPeerWithProvenance` must still rank the walk rather than
    // throw — and must NOT infer an authority it cannot establish.
    const { agent } = bridgeAgent({
      resolveSyncPeerWithProvenance: undefined,
      resolvePreferredSyncPeerId: async () => 'peer-legacy',
    });
    const posted = await invokeThroughBridge(agent, 'prepareCatchup', ['cg-legacy']);

    expect(posted.result.preferredPeerId).toBe('peer-legacy');
    expect(posted.result.authoritativePeerId).toBeUndefined();
  });

  it('forwards the admission source into both detailed sync calls', async () => {
    const { agent, calls } = bridgeAgent();

    await invokeThroughBridge(agent, 'syncDurable', ['peer-a', 'cg-x', 2000, 'catchup-foreground']);
    await invokeThroughBridge(agent, 'syncSharedMemory', ['peer-a', 'cg-x', 2000, 'catchup-foreground']);

    expect(calls.durable).toHaveLength(1);
    expect(calls.durable[0]!.at(-1)).toMatchObject({
      priority: 2000,
      source: 'catchup-foreground',
    });
    expect(calls.shared).toHaveLength(1);
    expect(calls.shared[0]!.at(-1)).toMatchObject({
      priority: 2000,
      source: 'catchup-foreground',
    });
  });
});
