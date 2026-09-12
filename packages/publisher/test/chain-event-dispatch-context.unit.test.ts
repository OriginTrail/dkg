import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter, type ChainEvent, type EventFilter } from '@origintrail-official/dkg-chain';
import { Logger, TypedEventBus } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ChainEventPoller, type ChainEventPollerConfig, type ChainEventPollerLane } from '../src/chain-event-poller.js';
import type { ChainEventDispatchContext } from '../src/chain-event-dispatch-context.js';
import { PublishHandler } from '../src/publish-handler.js';

const cases = [
  {
    type: 'ContextGraphCreated', lane: 'contextGraphDiscovery', callback: 'onContextGraphCreated',
    data: { contextGraphId: '1', creator: 'creator-1', accessPolicy: 0, publishPolicy: 1 },
    info: { contextGraphId: '1', creator: 'creator-1', accessPolicy: 0, publishPolicy: 1, nameHash: null },
  },
  {
    type: 'KnowledgeAssetRegisteredToContextGraph', lane: 'vmReconcile', callback: 'onKARegisteredToContextGraph',
    data: { contextGraphId: '1', kaId: '7', txHash: 'tx-7', txIndex: 0 },
    info: { contextGraphId: '1', kaId: 7n, txHash: 'tx-7', txIndex: 0 },
  },
  {
    type: 'KCCreated', lane: 'allocatorReconcile', callback: 'onKnowledgeAssetCreated',
    data: { kaId: '7', author: 'author-1', txHash: 'tx-7', txIndex: 0 },
    info: { kaId: 7n, number: 7n, author: 'author-1', txHash: 'tx-7', txIndex: 0 },
  },
  {
    type: 'KnowledgeAssetUpdated', lane: 'collectionUpdates', callback: 'onCollectionUpdated',
    data: { merkleRoot: '0x1234', batchId: '7' },
    info: { merkleRoot: new Uint8Array([0x12, 0x34]), batchId: 7n },
  },
  {
    type: 'AllowListUpdated', lane: 'allowListUpdates', callback: 'onAllowListUpdated',
    data: { contextGraphId: 'cg-1', agent: 'agent-1', added: false },
    info: { contextGraphId: 'cg-1', agent: 'agent-1', added: false },
  },
  {
    type: 'ProfileUpdated', lane: 'profileEvents', callback: 'onProfileEvent',
    data: { identityId: '9' }, info: { identityId: 9n },
  },
] as const;

describe('chain event callback dispatch context', () => {
  // Include legacy callbacks even when the current EVM deployment does not
  // emit their events; all adapters use the same generation-owned context.
  it.each(cases)('retains the generation context and isolates $type callback failures', async testCase => {
    const filters: EventFilter[] = [];
    class Chain extends MockChainAdapter {
      async getBlockNumber(): Promise<number> { return 20; }
      override async *listenForEvents(filter: EventFilter): AsyncIterable<ChainEvent> {
        filters.push(filter);
        if (filter.eventTypes.includes(testCase.type)) {
          for (const blockNumber of [11, 12]) yield { type: testCase.type, blockNumber, data: testCase.data };
        }
      }
    }
    const dispatched: Array<{ info: unknown; context: ChainEventDispatchContext }> = [];
    const callback = async (info: unknown, context: ChainEventDispatchContext) => {
      dispatched.push({ info, context });
      if (dispatched.length === 1) throw new Error('callback temporarily unavailable');
    };
    const callbacks: Pick<ChainEventPollerConfig, typeof testCase.callback> = { [testCase.callback]: callback };
    const saved: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    const warning = vi.spyOn(Logger.prototype, 'warn');
    const poller = new ChainEventPoller({
      ...callbacks, chain: new Chain(), intervalMs: 60_000,
      publishHandler: new PublishHandler(new OxigraphStore(), new TypedEventBus()),
      cursorPersistence: {
        loadLane: async () => 10,
        saveLane: async (lane, block) => { saved.push({ lane, block }); },
      },
    });
    try {
      await poller.start();
      await poller.waitForCurrentPoll();
      expect(dispatched.map(call => call.info)).toEqual([11, 12].map(blockNumber => ({ ...testCase.info, blockNumber })));
      expect(filters).toHaveLength(1);
      const signal = dispatched[0].context.signal;
      expect(filters[0].signal).toBe(signal);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      for (const call of dispatched) {
        expect(call.context.signal).toBe(signal);
        expect(call.context.operation).toEqual({ operationId: expect.any(String), operationName: 'publish' });
      }
      expect(warning).toHaveBeenCalledWith(dispatched[0].context.operation,
        `${testCase.callback} callback failed: callback temporarily unavailable`);
      expect(saved).toEqual([{ lane: testCase.lane, block: 20 }]);
      await poller.stop();
      expect(signal.aborted).toBe(true);
    } finally {
      await poller.stop();
      warning.mockRestore();
    }
  });
});
