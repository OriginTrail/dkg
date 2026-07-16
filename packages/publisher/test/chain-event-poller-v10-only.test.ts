/**
 * Regression — ChainEventPoller V10-only event subscriptions.
 *
 * After archiving the V8/V9 chain-adapter surface, the poller MUST NOT
 * subscribe to `KnowledgeBatchCreated`. The V10 path is `KCCreated`
 * (KnowledgeCollectionStorage). A live subscription to the archived V9
 * event type makes `EVMChainAdapter.listenForEvents` throw because the
 * V9 KnowledgeAssetsStorage contract is no longer deployed.
 *
 * This pin guards against accidental re-introduction.
 */
import { describe, it, expect } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import type { ChainAdapter, EventFilter, ChainEvent } from '@origintrail-official/dkg-chain';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import { PublishHandler } from '../src/publish-handler.js';

function makeRecordingChain(head: number): {
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
      // yield nothing
    },
  } as unknown as ChainAdapter;
  return { adapter, filters };
}

describe('ChainEventPoller — V10-only event subscriptions', () => {
  it('does NOT include the archived V9 KnowledgeBatchCreated event in its filter', async () => {
    const { adapter, filters } = makeRecordingChain(1000);
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());
    // sentinel pending publish forces a real poll
    (handler as unknown as { pendingPublishes: Map<string, unknown> }).pendingPublishes.set(
      's', { expectedMerkleRoot: new Uint8Array(32) } as never,
    );

    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 60_000, // single synchronous poll on start()
    });

    await poller.start();
    // Give the synchronous first poll its microtask turn.
    await new Promise((r) => setTimeout(r, 50));
    await poller.stop();

    expect(filters.length).toBeGreaterThanOrEqual(1);
    for (const f of filters) {
      expect(f.eventTypes).not.toContain('KnowledgeBatchCreated');
      // V10 channel must remain
      expect(f.eventTypes).toContain('KCCreated');
    }
  });
});
