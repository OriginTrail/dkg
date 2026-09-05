import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@origintrail-official/dkg-core';
import type { ChainAdapter, EventFilter } from '@origintrail-official/dkg-chain';
import { ChainEventLaneRunner, type ChainEventCursorStrategy } from '../src/chain-event-lane-runner.js';

describe('chain-event cursor strategies (#1456)', () => {
  it.each([
    [{ kind: 'live-tail', lookbackBlocks: 50 }, 51, true],
    [{ kind: 'isolated-live-tail', lookbackBlocks: 50 }, 951, false],
    [{ kind: 'full-history' }, 1, false],
    [{ kind: 'legacy-full-history' }, 51, true],
  ] as const)('%j owns both activation and legacy cursor migration', async (strategy, fromBlock, acceptsLegacy) => {
    const filters: EventFilter[] = [];
    const load = vi.fn(async () => 50);
    const save = vi.fn(async () => {});
    const chain = {
      getBlockNumber: async () => 1000,
      async *listenForEvents(filter: EventFilter) { filters.push(filter); },
    } as unknown as ChainAdapter;
    const runner = new ChainEventLaneRunner({
      chain, maxRange: 9000, clock: () => 0, log: new Logger('cursor-test'),
      cursorPersistence: { load, save },
      lanes: [{ name: 'publish', enabled: () => true, eventTypes: () => ['KCCreated'],
        cursorStrategy: () => strategy, cadenceMs: 20, dispatch: async () => {} }],
    });
    await runner.poll();
    expect(filters).toEqual([{ eventTypes: ['KCCreated'], fromBlock, toBlock: 1000 }]);
    expect(load).toHaveBeenCalledTimes(acceptsLegacy ? 1 : 0);
    expect(save).toHaveBeenCalledTimes(acceptsLegacy ? 1 : 0);
  });

  it.each([
    { kind: 'unknown' },
    { kind: 'full-history', lookbackBlocks: 20 },
    { kind: 'legacy-full-history', lookbackBlocks: 20 },
  ])('rejects invalid runtime strategies before RPC: %j', async (strategy) => {
    const getBlockNumber = vi.fn(async () => 1000);
    const runner = new ChainEventLaneRunner({
      chain: { getBlockNumber } as unknown as ChainAdapter,
      maxRange: 9000, clock: () => 0, log: new Logger('cursor-test'),
      lanes: [{ name: 'publish', enabled: () => true, eventTypes: () => ['KCCreated'],
        cursorStrategy: () => strategy as ChainEventCursorStrategy, cadenceMs: 20, dispatch: async () => {} }],
    });
    await expect(runner.poll()).rejects.toThrow();
    expect(getBlockNumber).not.toHaveBeenCalled();
  });
});
