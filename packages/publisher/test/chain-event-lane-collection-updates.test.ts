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
});
