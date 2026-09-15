import { activeRpcRequestContext, type ChainAdapter } from '@origintrail-official/dkg-chain';
import { describe, expect, it, vi } from 'vitest';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import type { LaneCursorPersistence } from '../src/chain-event-poller.js';
import { makeChain, makeHandler, markPending } from './helpers/chain-event-lane-fixture.js';

describe('ChainEventPoller lifecycle', () => {
  it('dispatches the extended event lanes with the poll lifecycle signal', async () => {
    const events = [
      {
        type: 'KnowledgeAssetUpdated',
        blockNumber: 100,
        data: { merkleRoot: `0x${'11'.repeat(32)}`, batchId: '7' },
      },
      {
        type: 'AllowListUpdated',
        blockNumber: 100,
        data: { contextGraphId: 'cg-1', agent: 'agent-1', added: false },
      },
      {
        type: 'ProfileCreated',
        blockNumber: 100,
        data: { identityId: '9' },
      },
      {
        type: 'ProfileUpdated',
        blockNumber: 100,
        data: { identityId: '10' },
      },
      {
        type: 'KCCreated',
        blockNumber: 100,
        data: {
          merkleRoot: `0x${'22'.repeat(32)}`,
          kaId: '1',
          author: '0x' + 'ef'.repeat(20),
          txHash: '0x' + '12'.repeat(32),
          publisherAddress: '0x' + 'ab'.repeat(20),
          startKAId: '1',
          endKAId: '2',
        },
      },
    ] as never;
    const { adapter } = makeChain({ head: 100, events });
    const calls: string[] = [];
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      onCollectionUpdated: async (info) => {
        calls.push(`collection:${info.batchId}`);
      },
      onAllowListUpdated: async (info) => {
        calls.push(`allow:${info.contextGraphId}:${info.added}`);
      },
      onProfileEvent: async (info) => {
        calls.push(`profile:${info.identityId}`);
      },
      onKnowledgeAssetCreated: async (info) => {
        calls.push(`created:${info.kaId}`);
      },
    });

    await poller.start();
    await poller.waitForCurrentPoll();
    await poller.stop();

    expect(calls).toEqual([
      'created:1',
      'collection:7',
      'allow:cg-1:false',
      'profile:9',
      'profile:10',
    ]);
  });

  it('isolates callback errors on every extended event lane', async () => {
    const events = [
      {
        type: 'KnowledgeAssetUpdated',
        blockNumber: 100,
        data: { merkleRoot: `0x${'33'.repeat(32)}`, batchId: '11' },
      },
      {
        type: 'AllowListUpdated',
        blockNumber: 100,
        data: { contextGraphId: 'cg-2', agent: 'agent-2', added: true },
      },
      {
        type: 'ProfileCreated',
        blockNumber: 100,
        data: { identityId: '12' },
      },
      {
        type: 'KCCreated',
        blockNumber: 100,
        data: {
          merkleRoot: `0x${'44'.repeat(32)}`,
          kaId: '3',
          author: '0x' + '12'.repeat(20),
          txHash: '0x' + '34'.repeat(32),
          publisherAddress: '0x' + 'cd'.repeat(20),
          startKAId: '3',
          endKAId: '4',
        },
      },
    ] as never;
    const { adapter } = makeChain({ head: 100, events });
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      onCollectionUpdated: async () => { throw new Error('collection failure'); },
      onAllowListUpdated: async () => { throw new Error('allow-list failure'); },
      onProfileEvent: async () => { throw new Error('profile failure'); },
      onKnowledgeAssetCreated: async () => { throw new Error('allocator failure'); },
    });

    await poller.start();
    await poller.waitForCurrentPoll();
    await poller.stop();
  });

  it('aborts an in-flight event callback without advancing its durable cursor', async () => {
    let callbackSignal: AbortSignal | undefined;
    let markCallbackStarted: () => void = () => undefined;
    const callbackStarted = new Promise<void>((resolve) => { markCallbackStarted = resolve; });
    const event = {
      type: 'KnowledgeAssetRegisteredToContextGraph',
      blockNumber: 100,
      data: { contextGraphId: '42', kaId: '7', txHash: '0xabc', txIndex: 0 },
    } as const;
    const { adapter } = makeChain({ head: 100, events: [event] });
    const saved: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    const cursor: LaneCursorPersistence = {
      async loadLane() { return undefined; },
      async saveLane(lane, block) { saved.push({ lane, block }); },
    };
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onKARegisteredToContextGraph: async (_info, signal) => {
        callbackSignal = signal;
        markCallbackStarted();
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        signal?.throwIfAborted();
      },
    });

    await poller.start();
    await callbackStarted;
    await poller.stop();

    expect(callbackSignal?.aborted).toBe(true);
    expect(saved).toEqual([]);
  });

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
});
