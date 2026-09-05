import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import type { ChainAdapter, ChainEvent, EventFilter } from '@origintrail-official/dkg-chain';
import { ChainEventPoller, type ChainEventPollerLane } from '../src/chain-event-poller.js';
import { PublishHandler } from '../src/publish-handler.js';

describe('ChainEventPoller allow-list and profile dispatch', () => {
  it('selects each event lane, delivers typed payloads and resumes persisted cursors', async () => {
    const agent = '0x' + 'ab'.repeat(20);
    const events: ChainEvent[] = [
      { type: 'AllowListUpdated', blockNumber: 91, data: { contextGraphId: 42n, agent, added: true } },
      { type: 'AllowListUpdated', blockNumber: 92, data: { contextGraphId: '43', agent, added: false } },
      { type: 'ProfileCreated', blockNumber: 93, data: { identityId: '9007199254740993' } },
      { type: 'ProfileUpdated', blockNumber: 94, data: { identityId: 7n } },
      { type: 'ContextGraphCreated', blockNumber: 95, data: { contextGraphId: 'unwatched' } },
    ];
    const filters: EventFilter[] = [];
    const chain = {
      chainId: 'mock:0',
      getBlockNumber: async () => 100,
      async *listenForEvents(filter: EventFilter) {
        filters.push(filter);
        for (const event of events) {
          if (filter.eventTypes.includes(event.type)
            && event.blockNumber >= (filter.fromBlock ?? 0)
            && event.blockNumber <= (filter.toBlock ?? Infinity)) yield event;
        }
      },
    } as unknown as ChainAdapter;
    const positions = new Map<ChainEventPollerLane, number>([
      ['allowListUpdates', 90], ['profileEvents', 92],
    ]);
    const saves: Array<[ChainEventPollerLane, number]> = [];
    const onAllowListUpdated = vi.fn(async () => {});
    const onProfileEvent = vi.fn(async () => {});
    const store = new OxigraphStore();
    const poller = new ChainEventPoller({
      chain,
      publishHandler: new PublishHandler(store, new TypedEventBus()),
      intervalMs: 60_000,
      onAllowListUpdated,
      onProfileEvent,
      cursorPersistence: {
        async loadLane(lane) { return positions.get(lane); },
        async saveLane(lane, block) { positions.set(lane, block); saves.push([lane, block]); },
      },
    });
    try {
      await poller.start();
      await poller.waitForCurrentPoll();
      await poller.stop();
      expect(filters).toEqual([
        { eventTypes: ['AllowListUpdated'], fromBlock: 91, toBlock: 100 },
        { eventTypes: ['ProfileCreated', 'ProfileUpdated'], fromBlock: 93, toBlock: 100 },
      ]);
      expect(onAllowListUpdated.mock.calls).toEqual([
        [{ contextGraphId: '42', agent, added: true, blockNumber: 91 }],
        [{ contextGraphId: '43', agent, added: false, blockNumber: 92 }],
      ]);
      expect(onProfileEvent.mock.calls).toEqual([
        [{ identityId: 9007199254740993n, blockNumber: 93 }],
        [{ identityId: 7n, blockNumber: 94 }],
      ]);
      expect(saves).toEqual([['allowListUpdates', 100], ['profileEvents', 100]]);
    } finally {
      await poller.stop();
      await store.close();
    }
  });
});
