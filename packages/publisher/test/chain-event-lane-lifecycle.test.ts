import { describe, expect, it } from 'vitest';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import type { LaneCursorPersistence } from '../src/chain-event-poller.js';
import { makeChain, makeHandler, markPending } from './helpers/chain-event-lane-fixture.js';

describe('ChainEventPoller lifecycle', () => {
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
    let stopped = false;
    const stopping = poller.stop().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);
    releaseRestore();
    await Promise.all([startPromise, stopping]);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(stopped).toBe(true);
    await poller.waitForCurrentPoll();
    expect(filters).toEqual([]);
  });
});
