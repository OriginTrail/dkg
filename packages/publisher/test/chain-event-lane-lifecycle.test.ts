import { activeRpcRequestContext, type ChainAdapter } from '@origintrail-official/dkg-chain';
import { describe, expect, it, vi } from 'vitest';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import type { LaneCursorPersistence } from '../src/chain-event-poller.js';
import { makeChain, makeHandler, markPending } from './helpers/chain-event-lane-fixture.js';

describe('ChainEventPoller lifecycle', () => {
  it('aborts a queued background chain request before awaiting poll retirement', async () => {
    let physicalSignal: AbortSignal | undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const adapter = {
      chainId: 'mock:0',
      getBlockNumber: async () => {
        physicalSignal = activeRpcRequestContext().signal;
        markStarted();
        await new Promise<never>((_resolve, reject) => {
          const rejectOnAbort = () => reject(physicalSignal?.reason);
          physicalSignal?.addEventListener('abort', rejectOnAbort, { once: true });
          if (physicalSignal?.aborted) rejectOnAbort();
        });
        return 0;
      },
      listenForEvents: async function* () { /* no events */ },
    } as unknown as ChainAdapter;
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      onContextGraphCreated: async () => { /* activate one polling lane */ },
    });

    await poller.start();
    await started;
    const stopped = poller.stop();
    await vi.waitFor(() => expect(physicalSignal?.aborted).toBe(true));
    await expect(stopped).resolves.toBeUndefined();
  });

  it('does not install a timer or initial poll when stopped during async startup restore', async () => {
    const { adapter, filters } = makeChain({ head: 100, events: [] });
    const handler = makeHandler();
    markPending(handler, true);
    let releaseRestore: () => void = () => {};
    let restoreStarted: () => void = () => {};
    const restoreStartedPromise = new Promise<void>((resolve) => { restoreStarted = resolve; });
    const restoreReleasePromise = new Promise<void>((resolve) => { releaseRestore = resolve; });
    const cursor: LaneCursorPersistence = {
      async loadLane(lane) {
        if (lane === 'publish') {
          restoreStarted();
          await restoreReleasePromise;
        }
        return undefined;
      },
      async saveLane() { /* not reached */ },
    };
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 10,
      cursorPersistence: cursor,
    });

    const startPromise = poller.start();
    await restoreStartedPromise;
    await poller.stop();
    releaseRestore();
    await startPromise;
    await new Promise((resolve) => setTimeout(resolve, 30));

    const state = poller as unknown as {
      timer: ReturnType<typeof setInterval> | null;
      inFlightPoll: Promise<void> | null;
    };
    expect(state.timer).toBeNull();
    expect(state.inFlightPoll).toBeNull();
    expect(filters).toEqual([]);
  });

  it('aborts an in-flight event callback without advancing its cursor', async () => {
    let markCallbackStarted: () => void = () => undefined;
    const callbackStarted = new Promise<void>((resolve) => { markCallbackStarted = resolve; });
    const saved: Array<{ lane: string; block: number }> = [];
    const { adapter } = makeChain({
      head: 1,
      events: [{
        type: 'ContextGraphCreated',
        blockNumber: 1,
        data: { contextGraphId: '1', creator: '0x1', accessPolicy: 0 },
      }],
    });
    const cursor: LaneCursorPersistence = {
      async loadLane() { return undefined; },
      async saveLane(lane, block) { saved.push({ lane, block }); },
    };
    let callbackAborted = false;
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onContextGraphCreated: async ({ signal }) => {
        markCallbackStarted();
        if (!signal) throw new Error('poll callback did not receive a lifecycle signal');
        await new Promise<void>((resolve) => {
          const finish = () => {
            callbackAborted = true;
            signal.removeEventListener('abort', finish);
            resolve();
          };
          signal.addEventListener('abort', finish, { once: true });
          if (signal.aborted) finish();
        });
      },
    });

    await poller.start();
    await callbackStarted;
    await poller.stop();

    expect(callbackAborted).toBe(true);
    expect(saved).toEqual([]);
  });
});
