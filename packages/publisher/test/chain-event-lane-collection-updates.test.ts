import type { ChainEvent } from '@origintrail-official/dkg-chain';
import { describe, expect, it } from 'vitest';
import { ChainEventPoller, type ChainEventPollerLane, type LaneCursorPersistence } from '../src/chain-event-poller.js';
import { makeChain, makeHandler } from './helpers/chain-event-lane-fixture.js';

describe('ChainEventPoller collection updates', () => {
  it('dispatches collection update events and advances the collectionUpdates cursor', async () => {
    const event: ChainEvent = {
      type: 'KnowledgeAssetUpdated',
      blockNumber: 50,
      data: {
        merkleRoot: '0x' + '44'.repeat(32),
        batchId: '42',
      },
    };
    const { adapter, filters } = makeChain({ head: 100, events: [event] });
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
    await poller.waitForCurrentPoll();
    await poller.stop();

    expect(filters[0].eventTypes).toEqual(['KnowledgeAssetUpdated']);
    expect(seen).toHaveLength(1);
    expect(Buffer.from(seen[0].merkleRoot).toString('hex')).toBe('44'.repeat(32));
    expect(seen[0].batchId).toBe(42n);
    expect(seen[0].blockNumber).toBe(50);
    expect(saveCalls).toEqual([{ lane: 'collectionUpdates', block: 100 }]);
  });

  it('passes the update\'s transaction hash to the callback', async () => {
    const { adapter } = makeChain({
      head: 100,
      events: [{
        type: 'KnowledgeAssetUpdated',
        blockNumber: 50,
        data: { merkleRoot: '0x' + '44'.repeat(32), batchId: '42', txHash: '0x' + 'ab'.repeat(32) },
      }],
    });
    const seen: Array<{ txHash?: string }> = [];
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      onCollectionUpdated: async (info) => { seen.push(info); },
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(seen.map((info) => info.txHash)).toEqual(['0x' + 'ab'.repeat(32)]);
  });

  it('persists the cursor no higher than the ceiling of unsettled callback work', async () => {
    let head = 100;
    const { adapter } = makeChain({ head: () => head, events: [] });
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    let ceiling: number | undefined = 49;
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      clock: () => now,
      cursorPersistence: {
        async loadLane() { return undefined; },
        async saveLane(lane, block) { saveCalls.push({ lane, block }); },
      } satisfies LaneCursorPersistence,
      onCollectionUpdated: async () => { /* sink */ },
      collectionUpdatesPersistCeiling: () => ceiling,
    });
    let now = 0;

    await (poller as unknown as { poll(): Promise<void> }).poll();
    // The work settles: the next scan that advances persists its block.
    ceiling = undefined;
    head = 120;
    now = 60_000;
    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(saveCalls).toEqual([
      { lane: 'collectionUpdates', block: 49 },
      { lane: 'collectionUpdates', block: 120 },
    ]);
  });

  it('holds the lane at a page whose callback fails and dispatches it again after the backoff', async () => {
    const event: ChainEvent = {
      type: 'KnowledgeAssetUpdated',
      blockNumber: 50,
      data: { merkleRoot: '0x' + '44'.repeat(32), batchId: '42' },
    };
    const { adapter } = makeChain({ head: 100, events: [event] });
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    let calls = 0;
    let now = 0;
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 12_000,
      clock: () => now,
      cursorPersistence: {
        async loadLane() { return undefined; },
        async saveLane(lane, block) { saveCalls.push({ lane, block }); },
      } satisfies LaneCursorPersistence,
      onCollectionUpdated: async () => {
        calls += 1;
        if (calls === 1) throw new Error('store busy');
      },
    });
    const poll = () => (poller as unknown as { poll(): Promise<void> }).poll();

    await poll();
    expect(calls).toBe(1);
    expect(saveCalls).toEqual([]);

    // Still inside the lane's failure backoff: nothing is scanned.
    now = 12_000;
    await poll();
    expect(calls).toBe(1);

    now = 60_000;
    await poll();
    expect(calls).toBe(2);
    expect(saveCalls).toEqual([{ lane: 'collectionUpdates', block: 100 }]);
  });
});
