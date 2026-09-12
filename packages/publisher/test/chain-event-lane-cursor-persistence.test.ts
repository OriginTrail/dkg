import { describe, expect, it } from 'vitest';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import type { ChainEventPollerLane } from '../src/chain-event-poller.js';
import type { LaneCursorPersistence } from '../src/chain-event-poller.js';
import { pollOnce, makeChain, makeHandler, markPending } from './helpers/chain-event-lane-fixture.js';

describe('ChainEventPoller cursor persistence', () => {
  it('saves and restores a legacy aggregate cursor when active lanes can safely share it', async () => {
    const cursor = {
      loaded: undefined as number | undefined,
      saved: [] as number[],
      async load() { return this.loaded; },
      async save(n: number) {
        this.saved.push(n);
        this.loaded = n;
      },
    };
    const first = makeChain({ head: 10_000, events: [] });
    const handler = makeHandler();
    const firstPoller = new ChainEventPoller({
      chain: first.adapter,
      publishHandler: handler,
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onContextGraphCreated: async () => { /* sink */ },
      onKARegisteredToContextGraph: async () => { /* sink */ },
    });

    await firstPoller.start();
    await firstPoller.waitForCurrentPoll();
    await firstPoller.stop();

    expect(first.filters.map((f) => f.eventTypes)).toEqual([
      ['NameClaimed', 'ContextGraphCreated'],
      ['KnowledgeAssetRegisteredToContextGraph'],
    ]);
    expect(first.filters[0].fromBlock).toBe(9501);
    expect(first.filters[0].toBlock).toBe(10_000);
    expect(first.filters[1].fromBlock).toBe(9501);
    expect(first.filters[1].toBlock).toBe(10_000);
    expect(cursor.saved).toEqual([10_000]);

    const restart = makeChain({ head: 10_000, events: [] });
    const restartPoller = new ChainEventPoller({
      chain: restart.adapter,
      publishHandler: handler,
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onContextGraphCreated: async () => { /* sink */ },
    });

    await restartPoller.start();
    await restartPoller.waitForCurrentPoll();
    await restartPoller.stop();

    expect(restart.filters).toHaveLength(0);
  });

  it('does not advance a legacy aggregate cursor past a failed active lane', async () => {
    const cursor = {
      saved: [] as number[],
      async load() { return undefined; },
      async save(n: number) { this.saved.push(n); },
    };
    let failContextLane = true;
    let now = 0;
    const { adapter, filters } = makeChain({
      head: 100,
      onListen: (f) => {
        if (f.eventTypes.includes('ContextGraphCreated') && failContextLane) {
          throw new Error('context lane unavailable');
        }
      },
    });
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 20,
      cursorPersistence: cursor,
      clock: () => now,
      onContextGraphCreated: async () => { /* sink */ },
      onKARegisteredToContextGraph: async () => { /* sink */ },
    });

    await pollOnce(poller);

    expect(filters.map((f) => f.eventTypes)).toEqual([
      ['NameClaimed', 'ContextGraphCreated'],
      ['KnowledgeAssetRegisteredToContextGraph'],
    ]);
    expect(filters[0].fromBlock).toBe(1);
    expect(filters[0].toBlock).toBe(100);
    expect(filters[1].fromBlock).toBe(1);
    expect(filters[1].toBlock).toBe(100);
    expect(cursor.saved).toEqual([]);

    failContextLane = false;
    now = 60_000;
    await pollOnce(poller);

    expect(filters[2].eventTypes).toEqual(['NameClaimed', 'ContextGraphCreated']);
    expect(filters[2].fromBlock).toBe(1);
    expect(filters[2].toBlock).toBe(100);
    expect(cursor.saved).toEqual([100]);
  });

  it('saves and restores a legacy aggregate cursor for non-full-history lanes', async () => {
    const cursor = {
      loaded: undefined as number | undefined,
      saved: [] as number[],
      async load() { return this.loaded; },
      async save(n: number) {
        this.saved.push(n);
        this.loaded = n;
      },
    };
    const first = makeChain({ head: 100, events: [] });
    const handler = makeHandler();
    const firstPoller = new ChainEventPoller({
      chain: first.adapter,
      publishHandler: handler,
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onKARegisteredToContextGraph: async () => { /* sink */ },
    });

    await firstPoller.start();
    await firstPoller.waitForCurrentPoll();
    await firstPoller.stop();

    expect(first.filters[0].eventTypes).toEqual(['KnowledgeAssetRegisteredToContextGraph']);
    expect(first.filters[0].fromBlock).toBe(1);
    expect(first.filters[0].toBlock).toBe(100);
    expect(cursor.saved).toEqual([100]);

    const restart = makeChain({ head: 150, events: [] });
    const restartPoller = new ChainEventPoller({
      chain: restart.adapter,
      publishHandler: handler,
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onKARegisteredToContextGraph: async () => { /* sink */ },
    });

    await restartPoller.start();
    await restartPoller.waitForCurrentPoll();
    await restartPoller.stop();

    expect(restart.filters[0].eventTypes).toEqual(['KnowledgeAssetRegisteredToContextGraph']);
    expect(restart.filters[0].fromBlock).toBe(101);
    expect(restart.filters[0].toBlock).toBe(150);
    expect(cursor.saved).toEqual([100, 150]);
  });

  it('restores and saves independent lane cursors when lane persistence is available', async () => {
    const saved = new Map<ChainEventPollerLane, number>([
      ['contextGraphDiscovery', 10],
      ['vmReconcile', 9500],
    ]);
    const loadCalls: ChainEventPollerLane[] = [];
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    const cursor: LaneCursorPersistence = {
      async loadLane(lane) {
        loadCalls.push(lane);
        return saved.get(lane);
      },
      async saveLane(lane, block) {
        saveCalls.push({ lane, block });
        saved.set(lane, block);
      },
    };
    const { adapter, filters } = makeChain({ head: 10_000, events: [] });
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onContextGraphCreated: async () => { /* sink */ },
      onKARegisteredToContextGraph: async () => { /* sink */ },
    });

    await poller.start();
    await poller.waitForCurrentPoll();
    await poller.stop();

    expect(loadCalls).toEqual(['contextGraphDiscovery', 'vmReconcile']);
    expect(filters.map((f) => f.eventTypes)).toEqual([
      ['NameClaimed', 'ContextGraphCreated'],
      ['KnowledgeAssetRegisteredToContextGraph'],
    ]);
    expect(filters[0].fromBlock).toBe(11);
    expect(filters[0].toBlock).toBe(9010);
    expect(filters[1].fromBlock).toBe(9501);
    expect(filters[1].toBlock).toBe(10_000);
    expect(saveCalls).toEqual([
      { lane: 'contextGraphDiscovery', block: 9010 },
      { lane: 'vmReconcile', block: 10_000 },
    ]);
  });

  it('lazy-restores a lane cursor when the lane becomes active after startup', async () => {
    const saved = new Map<ChainEventPollerLane, number>([
      ['publish', 12_000],
      ['contextGraphDiscovery', 50],
    ]);
    const loadCalls: ChainEventPollerLane[] = [];
    const cursor: LaneCursorPersistence = {
      async loadLane(lane) {
        loadCalls.push(lane);
        return saved.get(lane);
      },
      async saveLane(lane, block) {
        saved.set(lane, block);
      },
    };
    const { adapter, filters } = makeChain({ head: 13_000, events: [] });
    const handler = makeHandler();
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 20,
      cursorPersistence: cursor,
      onContextGraphCreated: async () => { /* initially active lane */ },
    });

    await poller.start();
    await poller.waitForCurrentPoll();
    markPending(handler, true);
    await new Promise((r) => setTimeout(r, 80));
    await poller.stop();

    expect(loadCalls).toContain('contextGraphDiscovery');
    expect(loadCalls).toContain('publish');
    const publishFilter = filters.find((f) => f.eventTypes.includes('KCCreated'));
    expect(publishFilter).toBeDefined();
    expect(publishFilter!.fromBlock).toBe(12_001);
  });
});
