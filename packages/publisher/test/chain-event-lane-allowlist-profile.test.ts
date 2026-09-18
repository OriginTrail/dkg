import type { ChainEvent } from '@origintrail-official/dkg-chain';
import { describe, expect, it } from 'vitest';
import { ChainEventPoller, type ChainEventPollerLane, type LaneCursorPersistence } from '../src/chain-event-poller.js';
import { makeChain, makeHandler } from './helpers/chain-event-lane-fixture.js';

describe('ChainEventPoller allow-list and profile lanes', () => {
  it('dispatches AllowListUpdated payloads and persists the lane cursor', async () => {
    const event: ChainEvent = {
      type: 'AllowListUpdated',
      blockNumber: 50,
      data: {
        contextGraphId: 'cg-42',
        agent: '0x' + 'ab'.repeat(20),
        added: false,
      },
    };
    const { adapter, filters } = makeChain({ head: 100, events: [event] });
    const saves: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    const cursor: LaneCursorPersistence = {
      async loadLane() { return undefined; },
      async saveLane(lane, block) { saves.push({ lane, block }); },
    };
    const seen: Array<{
      contextGraphId: string;
      agent: string;
      added: boolean;
      blockNumber: number;
    }> = [];
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      cursorPersistence: cursor,
      onAllowListUpdated: async (info) => { seen.push(info); },
    });

    await poller.start();
    await poller.waitForCurrentPoll();
    await poller.stop();

    expect(filters[0].eventTypes).toEqual(['AllowListUpdated']);
    expect(seen).toEqual([{
      contextGraphId: 'cg-42',
      agent: '0x' + 'ab'.repeat(20),
      added: false,
      blockNumber: 50,
    }]);
    expect(saves).toEqual([{ lane: 'allowListUpdates', block: 100 }]);
  });

  it('dispatches both ProfileCreated and ProfileUpdated payloads', async () => {
    const events: ChainEvent[] = [
      { type: 'ProfileCreated', blockNumber: 40, data: { identityId: '7' } },
      { type: 'ProfileUpdated', blockNumber: 80, data: { identityId: '9' } },
    ];
    const { adapter, filters } = makeChain({ head: 100, events });
    const seen: Array<{ identityId: bigint; blockNumber: number }> = [];
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      onProfileEvent: async (info) => { seen.push(info); },
    });

    await poller.start();
    await poller.waitForCurrentPoll();
    await poller.stop();

    expect(filters[0].eventTypes).toEqual(['ProfileCreated', 'ProfileUpdated']);
    expect(seen).toEqual([
      { identityId: 7n, blockNumber: 40 },
      { identityId: 9n, blockNumber: 80 },
    ]);
  });
});
