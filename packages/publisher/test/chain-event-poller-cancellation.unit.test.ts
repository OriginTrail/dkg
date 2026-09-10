import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter, type ChainEvent, type ChainReadOptions, type EventFilter } from '@origintrail-official/dkg-chain';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import { PublishHandler } from '../src/publish-handler.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const events: ChainEvent[] = [11, 12].map(blockNumber => ({
  type: 'KnowledgeAssetRegisteredToContextGraph', blockNumber,
  data: { contextGraphId: '1', kaId: String(blockNumber), txHash: `tx-${blockNumber}` },
}));

describe('chain event shutdown generation', () => {
  it.each([1, 3])('serializes %i restarts behind an interrupted restore and installs only the final timer', async restarts => {
    const entered = deferred();
    const release = deferred();
    const scanned: number[] = [];
    let restores = 0;
    class Chain extends MockChainAdapter {
      async getBlockNumber(): Promise<number> { return 20; }
      override async *listenForEvents(filter: EventFilter): AsyncIterable<ChainEvent> {
        scanned.push(filter.fromBlock!);
        yield* [];
      }
    }
    const poller = new ChainEventPoller({
      chain: new Chain(), publishHandler: new PublishHandler(new OxigraphStore(), new TypedEventBus()),
      onKARegisteredToContextGraph: async () => {},
      cursorPersistence: {
        loadLane: async () => {
          if (++restores === 1) { entered.resolve(); await release.promise; return 19; }
          return 10;
        },
        saveLane: async () => {},
      },
    });
    const timer = vi.spyOn(globalThis, 'setInterval');
    const starting = poller.start();
    let stopping: Promise<void> | undefined;
    let restarting: Promise<void> | undefined;
    const retired: Promise<void>[] = [];
    try {
      await entered.promise;
      stopping = poller.stop();
      for (let i = 1; i < restarts; i++) {
        retired.push(poller.start(), poller.stop());
      }
      restarting = poller.start();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(restores).toBe(1);
      expect(scanned).toEqual([]);
      release.resolve();
      await Promise.all([starting, stopping, restarting, ...retired]);
      await poller.waitForCurrentPoll();
      expect(restores).toBe(2);
      expect(scanned).toEqual([11]);
      expect(timer).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await Promise.all([starting, stopping, restarting, ...retired]);
      await poller.stop();
      for (const result of timer.mock.results) if (result.type === 'return') clearInterval(result.value);
      timer.mockRestore();
    }
  });

  it('keeps repeated start idempotent for an admitted generation', async () => {
    let heads = 0;
    class Chain extends MockChainAdapter {
      async getBlockNumber(): Promise<number> { heads++; return 20; }
    }
    const poller = new ChainEventPoller({
      chain: new Chain(), publishHandler: new PublishHandler(new OxigraphStore(), new TypedEventBus()),
      onKARegisteredToContextGraph: async () => {}, intervalMs: 60_000,
    });
    const timers = vi.spyOn(globalThis, 'setInterval');
    try {
      await poller.start();
      await poller.start();
      await poller.waitForCurrentPoll();
      expect(timers).toHaveBeenCalledTimes(1);
      expect(heads).toBe(1);
    } finally {
      await poller.stop();
      timers.mockRestore();
    }
  });

  it.each(['head', 'scan', 'callback'] as const)('aborts %s work without advancing a partial page and replays on restart', async boundary => {
    const entered = deferred();
    const release = deferred();
    let receivedSignal: AbortSignal | undefined;
    let paused = true;
    const wait = async (signal?: AbortSignal) => {
      receivedSignal = signal;
      signal?.addEventListener('abort', release.resolve, { once: true });
      entered.resolve();
      try { await release.promise; } finally { signal?.removeEventListener('abort', release.resolve); }
    };
    const filters: EventFilter[] = [];
    class Chain extends MockChainAdapter {
      async getBlockNumber(options?: ChainReadOptions): Promise<number> {
        if (paused && boundary === 'head') await wait(options?.signal);
        return 20;
      }
      override async *listenForEvents(filter: EventFilter): AsyncIterable<ChainEvent> {
        filters.push(filter);
        if (paused && boundary === 'scan') await wait(filter.signal);
        for (const event of events) yield event;
      }
    }
    const saved: number[] = [];
    const dispatched: bigint[] = [];
    const poller = new ChainEventPoller({
      chain: new Chain(), publishHandler: new PublishHandler(new OxigraphStore(), new TypedEventBus()),
      intervalMs: 60_000,
      cursorPersistence: { loadLane: async () => 10, saveLane: async (_lane, block) => { saved.push(block); } },
      onKARegisteredToContextGraph: async (info, options) => {
        expect(options?.operation).toEqual({ operationId: expect.any(String), operationName: 'publish' });
        dispatched.push(info.kaId);
        if (paused && boundary === 'callback') await wait(options?.signal);
      },
    });
    let stopped: Promise<void> | undefined;
    try {
      await poller.start();
      await entered.promise;
      stopped = poller.stop();
      expect(receivedSignal?.aborted).toBe(true);
      await stopped;
      expect(saved).toEqual([]);
      expect(dispatched).toEqual(boundary === 'callback' ? [11n] : []);
      paused = false;
      await poller.start();
      await poller.waitForCurrentPoll();
      expect(dispatched).toEqual(boundary === 'callback' ? [11n, 11n, 12n] : [11n, 12n]);
      expect(saved).toEqual([20]);
      expect(filters.every(filter => filter.fromBlock === 11)).toBe(true);
    } finally {
      release.resolve();
      await stopped;
      await poller.stop();
    }
  });

  it('owns a non-cancellable entered callback until physical settlement, without committing its cursor', async () => {
    const entered = deferred();
    const release = deferred();
    const completed: string[] = [];
    const saved: number[] = [];
    class Chain extends MockChainAdapter {
      async getBlockNumber(): Promise<number> { return 20; }
      override async *listenForEvents(): AsyncIterable<ChainEvent> { yield events[0]!; }
    }
    const poller = new ChainEventPoller({
      chain: new Chain(), publishHandler: new PublishHandler(new OxigraphStore(), new TypedEventBus()),
      cursorPersistence: { loadLane: async () => 10, saveLane: async (_lane, block) => { saved.push(block); } },
      onKARegisteredToContextGraph: async () => {
        entered.resolve();
        await release.promise;
        completed.push('entered-commit-settled');
      },
    });
    let stopped: Promise<void> | undefined;
    try {
      await poller.start();
      await entered.promise;
      stopped = poller.stop().then(() => { completed.push('poller-stopped'); });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(completed).toEqual([]);
      release.resolve();
      await stopped;
      expect(completed).toEqual(['entered-commit-settled', 'poller-stopped']);
      expect(saved).toEqual([]);
    } finally { release.resolve(); await stopped; await poller.stop(); }
  });
});
