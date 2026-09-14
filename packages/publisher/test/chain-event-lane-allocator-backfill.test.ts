import { describe, expect, it } from 'vitest';
import type { ChainEvent } from '@origintrail-official/dkg-chain';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import type { ChainEventPollerLane } from '../src/chain-event-poller.js';
import type { LaneCursorPersistence } from '../src/chain-event-poller.js';
import { makeChain, makeHandler, markPending } from './helpers/chain-event-lane-fixture.js';

describe('ChainEventPoller allocator backfill', () => {
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
    const { adapter, filters } = makeChain({ head: 12_000, events: [oldCreate] });
    const seen: bigint[] = [];
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onKnowledgeAssetCreated: async (event) => { seen.push(event.kaId); },
    });

    await poller.start();
    await poller.waitForCurrentPoll();
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
    const { adapter, filters } = makeChain({ head: 1_210_000, events: [] });
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
    await poller.waitForCurrentPoll();
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
    const { adapter, filters } = makeChain({ head: 12_000, events: [oldCreate] });
    const seen: bigint[] = [];
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onKnowledgeAssetCreated: async (event) => { seen.push(event.kaId); },
    });

    await poller.start();
    await poller.waitForCurrentPoll();
    await poller.stop();

    expect(loadCalls).toEqual(['allocatorReconcile']);
    expect(filters[0].eventTypes).toEqual(['KCCreated']);
    expect(filters[0].fromBlock).toBe(1);
    expect(filters[0].toBlock).toBe(9000);
    expect(seen).toEqual([1n]);
    expect(saveCalls).toEqual([{ lane: 'allocatorReconcile', block: 9000 }]);
  });
});
