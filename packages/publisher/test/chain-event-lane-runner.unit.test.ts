import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import type { ChainAdapter, ChainEvent, EventFilter } from '@origintrail-official/dkg-chain';
import { ChainEventPoller, type ChainEventPollerLane, type LaneCursorPersistence } from '../src/chain-event-poller.js';
import { ChainEventLaneRunner, type ChainEventPollerLaneSpec } from '../src/chain-event-lane-runner.js';
import { PublishHandler } from '../src/publish-handler.js';
import type { JournalEntry } from '../src/publish-journal.js';

function makeChain(head: number, events: ChainEvent[]): {
  adapter: ChainAdapter;
  filters: EventFilter[];
} {
  const filters: EventFilter[] = [];
  const adapter = {
    chainId: 'mock:0',
    getBlockNumber: async () => head,
    listenForEvents: async function* (f: EventFilter): AsyncIterable<ChainEvent> {
      filters.push(f);
      const fromBlock = f.fromBlock ?? 0;
      const toBlock = f.toBlock ?? Number.MAX_SAFE_INTEGER;
      for (const evt of events) {
        if (f.eventTypes.includes(evt.type) && evt.blockNumber >= fromBlock && evt.blockNumber <= toBlock) {
          yield evt;
        }
      }
    },
  } as unknown as ChainAdapter;
  return { adapter, filters };
}

function makeHandler(): PublishHandler {
  return new PublishHandler(new OxigraphStore(), new TypedEventBus());
}

function markPending(handler: PublishHandler, restoredFromJournal: boolean): void {
  (handler as unknown as { pendingPublishes: Map<string, unknown> }).pendingPublishes.set(
    restoredFromJournal ? 'restored' : 'live',
    { expectedMerkleRoot: new Uint8Array(32), restoredFromJournal },
  );
}

function journalEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    ual: 'did:dkg:mock:0/0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/1',
    contextGraphId: 'contextGraph-1',
    expectedPublisherAddress: '0x' + 'a1'.repeat(20),
    expectedMerkleRoot: '0x' + '55'.repeat(32),
    expectedStartKAId: '1',
    expectedEndKAId: '1',
    expectedChainId: 'mock:0',
    rootEntities: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('ChainEventPoller lane runner and cursors', () => {
  it('does not install a timer or initial poll when stopped during async startup restore', async () => {
    const { adapter, filters } = makeChain(100, []);
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

  it('cold-starts a restored pending publish lane from block 0 without allocator callbacks', async () => {
    const merkleRoot = '0x' + '55'.repeat(32);
    const oldCreate: ChainEvent = {
      type: 'KCCreated',
      blockNumber: 1,
      data: {
        kaId: '1',
        author: '0x' + 'a1'.repeat(20),
        merkleRoot,
        publisherAddress: '0x' + 'a1'.repeat(20),
        startKAId: '1',
        endKAId: '1',
        txHash: '0xabc',
        txIndex: 0,
      },
    };
    const { adapter, filters } = makeChain(10_000, [oldCreate]);
    const handler = makeHandler();
    markPending(handler, true);
    const confirmed: unknown[] = [];
    (handler as unknown as { confirmByMerkleRoot: (...args: unknown[]) => Promise<boolean> }).confirmByMerkleRoot = async (...args) => {
      confirmed.push(args);
      return true;
    };

    const poller = new ChainEventPoller({ chain: adapter, publishHandler: handler, intervalMs: 60_000 });

    await poller.start();
    await new Promise((r) => setTimeout(r, 50));
    await poller.stop();

    expect(filters).toHaveLength(1);
    expect(filters[0].eventTypes).toEqual(['KCCreated']);
    expect(filters[0].fromBlock).toBe(1);
    expect(filters[0].toBlock).toBe(9000);
    expect(confirmed).toHaveLength(1);
  });

  it('uses the journal restore path to mark restored publishes for backfill', async () => {
    const merkleRoot = '0x' + '55'.repeat(32);
    const oldCreate: ChainEvent = {
      type: 'KCCreated',
      blockNumber: 1,
      data: {
        kaId: '1',
        author: '0x' + 'a1'.repeat(20),
        merkleRoot,
        publisherAddress: '0x' + 'a1'.repeat(20),
        startKAId: '1',
        endKAId: '1',
        txHash: '0xabc',
        txIndex: 0,
      },
    };
    const { adapter, filters } = makeChain(10_000, [oldCreate]);
    const journal = {
      load: async () => [journalEntry({ expectedMerkleRoot: merkleRoot })],
      save: async () => { /* sink */ },
    };
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus(), { journal: journal as any });
    const confirmed: unknown[] = [];
    (handler as unknown as { confirmByMerkleRoot: (...args: unknown[]) => Promise<boolean> }).confirmByMerkleRoot = async (...args) => {
      confirmed.push(args);
      return true;
    };

    expect(await handler.restorePendingPublishes()).toBe(1);
    expect(handler.hasRestoredPendingPublishes).toBe(true);

    const poller = new ChainEventPoller({ chain: adapter, publishHandler: handler, intervalMs: 60_000 });
    try {
      await poller.start();
      await new Promise((r) => setTimeout(r, 50));
      await poller.stop();
    } finally {
      const pending = (handler as unknown as {
        pendingPublishes: Map<string, { timeout: ReturnType<typeof setTimeout> }>;
      }).pendingPublishes;
      for (const entry of pending.values()) clearTimeout(entry.timeout);
      pending.clear();
    }

    expect(filters).toHaveLength(1);
    expect(filters[0].eventTypes).toEqual(['KCCreated']);
    expect(filters[0].fromBlock).toBe(1);
    expect(filters[0].toBlock).toBe(9000);
    expect(confirmed).toHaveLength(1);
  });

  it('live-tails context graph discovery near the current head on cold start', async () => {
    const { adapter, filters } = makeChain(10_000, []);
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      onContextGraphCreated: async () => { /* sink */ },
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 50));
    await poller.stop();

    expect(filters.length).toBeGreaterThanOrEqual(1);
    expect(filters[0].eventTypes).toEqual(['NameClaimed', 'ContextGraphCreated']);
    expect(filters[0].fromBlock).toBe(9501);
    expect(filters[0].toBlock).toBe(10_000);
  });

  it('dispatches a near-head context graph event on the first poll', async () => {
    const event: ChainEvent = {
      type: 'ContextGraphCreated',
      blockNumber: 19_999_990,
      data: {
        contextGraphId: '42',
        creator: '0x' + 'a1'.repeat(20),
        accessPolicy: 0,
        publishPolicy: 1,
        nameHash: '0x' + 'ab'.repeat(32),
      },
    };
    const { adapter, filters } = makeChain(20_000_000, [event]);
    const seen: Array<{ contextGraphId: string; blockNumber: number }> = [];
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      onContextGraphCreated: async (info) => { seen.push(info); },
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 50));
    await poller.stop();

    expect(filters[0].eventTypes).toEqual(['NameClaimed', 'ContextGraphCreated']);
    expect(filters[0].fromBlock).toBe(19_999_501);
    expect(filters[0].toBlock).toBe(20_000_000);
    expect(seen).toMatchObject([{ contextGraphId: '42', blockNumber: 19_999_990 }]);
  });

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
    const first = makeChain(10_000, []);
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
    await new Promise((r) => setTimeout(r, 50));
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

    const restart = makeChain(10_000, []);
    const restartPoller = new ChainEventPoller({
      chain: restart.adapter,
      publishHandler: handler,
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onContextGraphCreated: async () => { /* sink */ },
    });

    await restartPoller.start();
    await new Promise((r) => setTimeout(r, 50));
    await restartPoller.stop();

    expect(restart.filters).toHaveLength(0);
  });

  it('does not advance a legacy aggregate cursor past a failed active lane', async () => {
    const filters: EventFilter[] = [];
    const cursor = {
      saved: [] as number[],
      async load() { return undefined; },
      async save(n: number) { this.saved.push(n); },
    };
    let failContextLane = true;
    let now = 0;
    const adapter = {
      chainId: 'mock:0',
      getBlockNumber: async () => 100,
      listenForEvents: async function* (f: EventFilter): AsyncIterable<ChainEvent> {
        filters.push(f);
        if (f.eventTypes.includes('ContextGraphCreated') && failContextLane) {
          throw new Error('context lane unavailable');
        }
      },
    } as unknown as ChainAdapter;
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 20,
      cursorPersistence: cursor,
      clock: () => now,
      onContextGraphCreated: async () => { /* sink */ },
      onKARegisteredToContextGraph: async () => { /* sink */ },
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();

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
    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(filters[2].eventTypes).toEqual(['NameClaimed', 'ContextGraphCreated']);
    expect(filters[2].fromBlock).toBe(1);
    expect(filters[2].toBlock).toBe(100);
    expect(cursor.saved).toEqual([100]);
  });

  it('does not let a legacy context-only cursor skip a later full-history allocator lane', async () => {
    const cursor = {
      loaded: 10_000 as number | undefined,
      saved: [] as number[],
      async load() { return this.loaded; },
      async save(n: number) {
        this.saved.push(n);
        this.loaded = n;
      },
    };
    const oldCreate: ChainEvent = {
      type: 'KCCreated',
      blockNumber: 5000,
      data: {
        kaId: '1',
        author: '0x' + 'a1'.repeat(20),
        merkleRoot: '0x' + '11'.repeat(32),
        publisherAddress: '0x' + 'a1'.repeat(20),
        startKAId: '1',
        endKAId: '1',
        txHash: '0xabc',
        txIndex: 0,
      },
    };
    const { adapter, filters } = makeChain(12_000, [oldCreate]);
    const seen: bigint[] = [];
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onKnowledgeAssetCreated: async (event) => { seen.push(event.kaId); },
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 50));
    await poller.stop();

    expect(filters[0].eventTypes).toContain('KCCreated');
    expect(filters[0].fromBlock).toBe(1);
    expect(filters[0].toBlock).toBe(9000);
    expect(seen).toEqual([1n]);
    expect(cursor.saved).toEqual([]);
  });

  it('restores a legacy pending-publish cursor without applying it to allocator backfill', async () => {
    const cursor = {
      loaded: 1_200_000 as number | undefined,
      saved: [] as number[],
      async load() { return this.loaded; },
      async save(n: number) {
        this.saved.push(n);
        this.loaded = n;
      },
    };
    const { adapter, filters } = makeChain(1_210_000, []);
    const handler = makeHandler();
    markPending(handler, true);
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onKnowledgeAssetCreated: async () => { /* sink */ },
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 50));
    await poller.stop();

    expect(filters.map((f) => f.eventTypes)).toEqual([
      ['KCCreated'],
      ['KCCreated'],
    ]);
    expect(filters[0].fromBlock).toBe(1_200_001);
    expect(filters[0].toBlock).toBe(1_209_000);
    expect(filters[1].fromBlock).toBe(1);
    expect(filters[1].toBlock).toBe(9000);
    expect(cursor.saved).toEqual([]);
  });

  it('does not let a saved publish cursor skip later allocator reconciliation backfill', async () => {
    const saved = new Map<ChainEventPollerLane, number>([['publish', 10_000]]);
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
    const oldCreate: ChainEvent = {
      type: 'KCCreated',
      blockNumber: 5000,
      data: {
        kaId: '1',
        author: '0x' + 'a1'.repeat(20),
        merkleRoot: '0x' + '11'.repeat(32),
        publisherAddress: '0x' + 'a1'.repeat(20),
        startKAId: '1',
        endKAId: '1',
        txHash: '0xabc',
        txIndex: 0,
      },
    };
    const { adapter, filters } = makeChain(12_000, [oldCreate]);
    const seen: bigint[] = [];
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onKnowledgeAssetCreated: async (event) => { seen.push(event.kaId); },
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 50));
    await poller.stop();

    expect(loadCalls).toEqual(['allocatorReconcile']);
    expect(filters[0].eventTypes).toEqual(['KCCreated']);
    expect(filters[0].fromBlock).toBe(1);
    expect(filters[0].toBlock).toBe(9000);
    expect(seen).toEqual([1n]);
    expect(saveCalls).toEqual([{ lane: 'allocatorReconcile', block: 9000 }]);
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
    const first = makeChain(100, []);
    const handler = makeHandler();
    const firstPoller = new ChainEventPoller({
      chain: first.adapter,
      publishHandler: handler,
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onKARegisteredToContextGraph: async () => { /* sink */ },
    });

    await firstPoller.start();
    await new Promise((r) => setTimeout(r, 50));
    await firstPoller.stop();

    expect(first.filters[0].eventTypes).toEqual(['KnowledgeAssetRegisteredToContextGraph']);
    expect(first.filters[0].fromBlock).toBe(1);
    expect(first.filters[0].toBlock).toBe(100);
    expect(cursor.saved).toEqual([100]);

    const restart = makeChain(150, []);
    const restartPoller = new ChainEventPoller({
      chain: restart.adapter,
      publishHandler: handler,
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onKARegisteredToContextGraph: async () => { /* sink */ },
    });

    await restartPoller.start();
    await new Promise((r) => setTimeout(r, 50));
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
    const { adapter, filters } = makeChain(10_000, []);
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onContextGraphCreated: async () => { /* sink */ },
      onKARegisteredToContextGraph: async () => { /* sink */ },
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 50));
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
    const { adapter, filters } = makeChain(13_000, []);
    const handler = makeHandler();
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 20,
      cursorPersistence: cursor,
      onContextGraphCreated: async () => { /* initially active lane */ },
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 50));
    markPending(handler, true);
    await new Promise((r) => setTimeout(r, 80));
    await poller.stop();

    expect(loadCalls).toContain('contextGraphDiscovery');
    expect(loadCalls).toContain('publish');
    const publishFilter = filters.find((f) => f.eventTypes.includes('KCCreated'));
    expect(publishFilter).toBeDefined();
    expect(publishFilter!.fromBlock).toBe(12_001);
  });

  it('seeds a newly-active live publish lane near the current head after idle', async () => {
    const filters: EventFilter[] = [];
    let head = 20_000_000;
    const adapter = {
      chainId: 'mock:0',
      getBlockNumber: async () => head,
      listenForEvents: async function* (f: EventFilter): AsyncIterable<ChainEvent> {
        filters.push(f);
      },
    } as unknown as ChainAdapter;
    const handler = makeHandler();
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 20,
      onContextGraphCreated: async () => { /* idle always-on lane */ },
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();
    expect(filters.map((f) => f.eventTypes)).toEqual([
      ['NameClaimed', 'ContextGraphCreated'],
    ]);

    head = 20_000_050;
    markPending(handler, false);
    await (poller as unknown as { poll(): Promise<void> }).poll();

    const publishFilter = filters.find((f) => f.eventTypes.includes('KCCreated'));
    expect(publishFilter).toBeDefined();
    expect(publishFilter!.fromBlock).toBe(19_991_051);
    expect(publishFilter!.toBlock).toBe(20_000_050);
  });

  it('scans a full page behind head for newly-active live publish confirmations', async () => {
    const merkleRoot = '0x' + '00'.repeat(32);
    const oldCreate: ChainEvent = {
      type: 'KCCreated',
      blockNumber: 9000,
      data: {
        kaId: '1',
        author: '0x' + 'a1'.repeat(20),
        merkleRoot,
        publisherAddress: '0x' + 'a1'.repeat(20),
        startKAId: '1',
        endKAId: '1',
        txHash: '0xabc',
        txIndex: 0,
      },
    };
    const { adapter, filters } = makeChain(10_000, [oldCreate]);
    const handler = makeHandler();
    markPending(handler, false);
    const confirmed: unknown[] = [];
    (handler as unknown as { confirmByMerkleRoot: (...args: unknown[]) => Promise<boolean> }).confirmByMerkleRoot = async (...args) => {
      confirmed.push(args);
      return true;
    };
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 60_000,
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(filters).toHaveLength(1);
    expect(filters[0].eventTypes).toEqual(['KCCreated']);
    expect(filters[0].fromBlock).toBe(1001);
    expect(filters[0].toBlock).toBe(10_000);
    expect(confirmed).toHaveLength(1);
  });

  it('re-seeds live publish confirmations near head after restored publish backfill clears', async () => {
    const restoredMerkleRoot = '0x' + '11'.repeat(32);
    const liveMerkleRoot = '0x' + '22'.repeat(32);
    const events: ChainEvent[] = [
      {
        type: 'KCCreated',
        blockNumber: 1,
        data: {
          kaId: '1',
          author: '0x' + 'a1'.repeat(20),
          merkleRoot: restoredMerkleRoot,
          publisherAddress: '0x' + 'a1'.repeat(20),
          startKAId: '1',
          endKAId: '1',
          txHash: '0xrestored',
          txIndex: 0,
        },
      },
      {
        type: 'KCCreated',
        blockNumber: 1_999_950,
        data: {
          kaId: '2',
          author: '0x' + 'b2'.repeat(20),
          merkleRoot: liveMerkleRoot,
          publisherAddress: '0x' + 'b2'.repeat(20),
          startKAId: '2',
          endKAId: '2',
          txHash: '0xlive',
          txIndex: 0,
        },
      },
    ];
    const { adapter, filters } = makeChain(2_000_000, events);
    const handler = makeHandler();
    markPending(handler, true);
    markPending(handler, false);
    const pending = (handler as unknown as {
      pendingPublishes: Map<string, { restoredFromJournal: boolean }>;
    }).pendingPublishes;
    const confirmed: number[] = [];
    (handler as unknown as { confirmByMerkleRoot: (...args: unknown[]) => Promise<boolean> }).confirmByMerkleRoot = async (merkleRoot) => {
      const root = merkleRoot as Uint8Array;
      confirmed.push(root[0]);
      if (root[0] === 0x11) pending.delete('restored');
      if (root[0] === 0x22) pending.delete('live');
      return true;
    };
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 60_000,
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();
    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(filters).toHaveLength(2);
    expect(filters[0].eventTypes).toEqual(['KCCreated']);
    expect(filters[0].fromBlock).toBe(1);
    expect(filters[0].toBlock).toBe(9000);
    expect(filters[1].eventTypes).toEqual(['KCCreated']);
    expect(filters[1].fromBlock).toBe(1_991_001);
    expect(filters[1].toBlock).toBe(2_000_000);
    expect(confirmed).toEqual([0x11, 0x22]);
  });

  it('dispatches collection update events and advances the collectionUpdates cursor', async () => {
    const event: ChainEvent = {
      type: 'KnowledgeAssetUpdated',
      blockNumber: 50,
      data: {
        merkleRoot: '0x' + '44'.repeat(32),
        batchId: '42',
      },
    };
    const { adapter, filters } = makeChain(100, [event]);
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    const cursor: LaneCursorPersistence = {
      async loadLane() { return undefined; },
      async saveLane(lane, block) { saveCalls.push({ lane, block }); },
    };
    const seen: Array<{ merkleRoot: Uint8Array; batchId: bigint; blockNumber: number }> = [];
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onCollectionUpdated: async (info) => { seen.push(info); },
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 50));
    await poller.stop();

    expect(filters[0].eventTypes).toEqual(['KnowledgeAssetUpdated']);
    expect(seen).toHaveLength(1);
    expect(Buffer.from(seen[0].merkleRoot).toString('hex')).toBe('44'.repeat(32));
    expect(seen[0].batchId).toBe(42n);
    expect(seen[0].blockNumber).toBe(50);
    expect(saveCalls).toEqual([{ lane: 'collectionUpdates', block: 100 }]);
  });

  it('tails context graph discovery on the normal poll cadence', async () => {
    const filters: EventFilter[] = [];
    let now = 0;
    let head = 1000;
    let blockNumberCalls = 0;
    const adapter = {
      chainId: 'mock:0',
      getBlockNumber: async () => {
        blockNumberCalls++;
        return head;
      },
      listenForEvents: async function* (f: EventFilter): AsyncIterable<ChainEvent> {
        filters.push(f);
      },
    } as unknown as ChainAdapter;
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 20,
      clock: () => now,
      onContextGraphCreated: async () => { /* sink */ },
      onKARegisteredToContextGraph: async () => { /* normal-cadence lane */ },
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();
    expect(filters.map((f) => f.eventTypes)).toEqual([
      ['NameClaimed', 'ContextGraphCreated'],
      ['KnowledgeAssetRegisteredToContextGraph'],
    ]);

    now = 25;
    head = 1100;
    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(blockNumberCalls).toBe(2);
    expect(filters.map((f) => f.eventTypes)).toEqual([
      ['NameClaimed', 'ContextGraphCreated'],
      ['KnowledgeAssetRegisteredToContextGraph'],
      ['NameClaimed', 'ContextGraphCreated'],
      ['KnowledgeAssetRegisteredToContextGraph'],
    ]);
    expect(filters[2].fromBlock).toBe(1001);
    expect(filters[2].toBlock).toBe(1100);
    expect(filters[3].fromBlock).toBe(1001);
    expect(filters[3].toBlock).toBe(1100);
  });

  it('backs off a failed context graph discovery lane and retries the same range later', async () => {
    const filters: EventFilter[] = [];
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    let calls = 0;
    let now = 0;
    const adapter = {
      chainId: 'mock:0',
      getBlockNumber: async () => 100,
      listenForEvents: async function* (f: EventFilter): AsyncIterable<ChainEvent> {
        filters.push(f);
        calls++;
        if (calls === 1) throw new Error('rpc down');
      },
    } as unknown as ChainAdapter;
    const cursor: LaneCursorPersistence = {
      async loadLane() { return undefined; },
      async saveLane(lane, block) { saveCalls.push({ lane, block }); },
    };
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 20,
      cursorPersistence: cursor,
      clock: () => now,
      onContextGraphCreated: async () => { /* sink */ },
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();
    now = 20;
    await (poller as unknown as { poll(): Promise<void> }).poll();
    now = 60_000;
    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(filters).toHaveLength(2);
    expect(filters[0].eventTypes).toEqual(['NameClaimed', 'ContextGraphCreated']);
    expect(filters[1].eventTypes).toEqual(['NameClaimed', 'ContextGraphCreated']);
    expect(filters[0].fromBlock).toBe(1);
    expect(filters[0].toBlock).toBe(100);
    expect(filters[1].fromBlock).toBe(1);
    expect(filters[1].toBlock).toBe(100);
    expect(saveCalls).toEqual([{ lane: 'contextGraphDiscovery', block: 100 }]);
  });

  it('exponentially backs off repeated lane failures and resets after success', async () => {
    const filters: EventFilter[] = [];
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    let calls = 0;
    let head = 100;
    let now = 0;
    const adapter = {
      chainId: 'mock:0',
      getBlockNumber: async () => head,
      listenForEvents: async function* (f: EventFilter): AsyncIterable<ChainEvent> {
        filters.push(f);
        calls++;
        if (calls === 1 || calls === 2 || calls === 4) throw new Error('rpc down');
      },
    } as unknown as ChainAdapter;
    const cursor: LaneCursorPersistence = {
      async loadLane() { return undefined; },
      async saveLane(lane, block) { saveCalls.push({ lane, block }); },
    };
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 20,
      cursorPersistence: cursor,
      clock: () => now,
      onContextGraphCreated: async () => { /* sink */ },
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();
    now = 60_000;
    await (poller as unknown as { poll(): Promise<void> }).poll();
    now = 120_000;
    await (poller as unknown as { poll(): Promise<void> }).poll();
    now = 180_000;
    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(filters.map((f) => [f.fromBlock, f.toBlock])).toEqual([
      [1, 100],
      [1, 100],
      [1, 100],
    ]);
    expect(saveCalls).toEqual([{ lane: 'contextGraphDiscovery', block: 100 }]);

    head = 200;
    now = 180_020;
    await (poller as unknown as { poll(): Promise<void> }).poll();
    now = 240_019;
    await (poller as unknown as { poll(): Promise<void> }).poll();
    now = 240_020;
    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(filters.map((f) => [f.fromBlock, f.toBlock])).toEqual([
      [1, 100],
      [1, 100],
      [1, 100],
      [101, 200],
      [101, 200],
    ]);
    expect(saveCalls).toEqual([
      { lane: 'contextGraphDiscovery', block: 100 },
      { lane: 'contextGraphDiscovery', block: 200 },
    ]);
  });

  it('uses an explicit lane failure-backoff policy and caps repeated failures', async () => {
    const filters: EventFilter[] = [];
    let calls = 0;
    let now = 0;
    const adapter = {
      chainId: 'mock:0',
      getBlockNumber: async () => 100,
      listenForEvents: async function* (f: EventFilter): AsyncIterable<ChainEvent> {
        filters.push(f);
        calls++;
        if (calls <= 3) throw new Error('rpc down');
      },
    } as unknown as ChainAdapter;
    const lane: ChainEventPollerLaneSpec = {
      name: 'contextGraphDiscovery',
      enabled: () => true,
      eventTypes: () => ['ContextGraphCreated'],
      requiresFullHistory: () => false,
      cadenceMs: 20,
      failureBackoff: { initialMs: 10, maxMs: 25 },
      dispatch: async () => { /* sink */ },
    };
    const runner = new ChainEventLaneRunner({
      chain: adapter,
      lanes: [lane],
      maxRange: 1000,
      clock: () => now,
      log: { info() {}, warn() {}, error() {} } as any,
    });

    await runner.poll();
    now = 9;
    await runner.poll();
    now = 10;
    await runner.poll();
    now = 29;
    await runner.poll();
    now = 30;
    await runner.poll();
    now = 54;
    await runner.poll();
    now = 55;
    await runner.poll();

    expect(filters.map((f) => [f.fromBlock, f.toBlock])).toEqual([
      [1, 100],
      [1, 100],
      [1, 100],
      [1, 100],
    ]);
  });

  it('keeps headless scans due until a known head proves the lane is caught up', async () => {
    const filters: EventFilter[] = [];
    const adapter = {
      chainId: 'mock:0',
      getBlockNumber: async () => { throw new Error('head unavailable'); },
      listenForEvents: async function* (f: EventFilter): AsyncIterable<ChainEvent> {
        filters.push(f);
      },
    } as unknown as ChainAdapter;
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 20,
      clock: () => 0,
      onContextGraphCreated: async () => { /* sink */ },
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 90));
    await poller.stop();

    expect(filters.length).toBeGreaterThanOrEqual(2);
    expect(filters[0].fromBlock).toBe(1);
    expect(filters[0].toBlock).toBe(9000);
    expect(filters[1].fromBlock).toBe(9001);
    expect(filters[1].toBlock).toBe(18_000);
  });
});
