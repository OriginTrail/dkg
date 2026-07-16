/**
 * Phase B — ChainEventPoller surfaces `KnowledgeAssetRegisteredToContextGraph`.
 *
 * This is the low-latency nudge that drives chain-driven VM reconciliation:
 * when a KA is bound to a CG on-chain, the poller invokes
 * `onKARegisteredToContextGraph` so the agent can run an ordinal sweep for
 * that CG. We assert (a) the event type is subscribed only when the callback
 * is wired, and (b) the parsed `{ contextGraphId, kaId, txHash }` flows
 * through to the callback.
 */
import { describe, it, expect } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import type { ChainAdapter, EventFilter, ChainEvent } from '@origintrail-official/dkg-chain';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import { PublishHandler } from '../src/publish-handler.js';

function makeChain(head: number, events: ChainEvent[]): {
  adapter: ChainAdapter;
  filters: EventFilter[];
} {
  const filters: EventFilter[] = [];
  const adapter = {
    chainId: 'mock:0',
    getBlockNumber: async () => head,
    // eslint-disable-next-line @typescript-eslint/require-await
    listenForEvents: async function* (f: EventFilter): AsyncIterable<ChainEvent> {
      filters.push(f);
      for (const evt of events) {
        if (f.eventTypes.includes(evt.type)) yield evt;
      }
    },
  } as unknown as ChainAdapter;
  return { adapter, filters };
}

describe('ChainEventPoller — KnowledgeAssetRegisteredToContextGraph', () => {
  it('subscribes to the event and dispatches parsed fields to the callback', async () => {
    const event: ChainEvent = {
      type: 'KnowledgeAssetRegisteredToContextGraph',
      blockNumber: 900,
      data: {
        contextGraphId: '42',
        kaId: '7',
        txHash: '0xabc',
        txIndex: 3,
      },
    };
    const { adapter, filters } = makeChain(1000, [event]);
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());

    const seen: Array<{ contextGraphId: string; kaId: bigint; txHash: string; txIndex?: number }> = [];
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 60_000,
      onKARegisteredToContextGraph: async (info) => {
        seen.push({
          contextGraphId: info.contextGraphId,
          kaId: info.kaId,
          txHash: info.txHash,
          txIndex: info.txIndex,
        });
      },
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 50));
    await poller.stop();

    expect(filters.length).toBeGreaterThanOrEqual(1);
    expect(filters[0].eventTypes).toContain('KnowledgeAssetRegisteredToContextGraph');
    expect(seen).toEqual([
      { contextGraphId: '42', kaId: 7n, txHash: '0xabc', txIndex: 3 },
    ]);
  });

  it('does NOT subscribe to the event when no callback is wired', async () => {
    const { adapter, filters } = makeChain(1000, []);
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());
    // sentinel pending publish forces a real poll
    (handler as unknown as { pendingPublishes: Map<string, unknown> }).pendingPublishes.set(
      's', { expectedMerkleRoot: new Uint8Array(32) } as never,
    );

    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 60_000,
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 50));
    await poller.stop();

    expect(filters.length).toBeGreaterThanOrEqual(1);
    for (const f of filters) {
      expect(f.eventTypes).not.toContain('KnowledgeAssetRegisteredToContextGraph');
    }
  });
});
