import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import type { ChainAdapter, ChainEvent, EventFilter } from '@origintrail-official/dkg-chain';
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

describe('ChainEventPoller - KnowledgeAssetCreated allocator reconciliation', () => {
  it('dispatches onKnowledgeAssetCreated off the adapter-normalized KCCreated event', async () => {
    const author = '0x' + 'a1'.repeat(20);
    const number = 7n;
    const packedKaId = (BigInt(author) << 96n) | number;
    const event: ChainEvent = {
      type: 'KCCreated',
      blockNumber: 901,
      data: {
        kaId: packedKaId.toString(),
        author,
        merkleRoot: '0x' + '11'.repeat(32),
        byteSize: '1024',
        publisherAddress: author,
        startKAId: packedKaId.toString(),
        endKAId: packedKaId.toString(),
        txHash: '0xdeadbeef',
        txIndex: 2,
      },
    };
    const { adapter, filters } = makeChain(1000, [event]);
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());
    const seen: Array<{
      kaId: bigint;
      author: string;
      number: bigint;
      txHash: string;
      txIndex: number;
      blockNumber: number;
    }> = [];

    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 60_000,
      onKnowledgeAssetCreated: async (info) => {
        seen.push({
          kaId: info.kaId,
          author: info.author,
          number: info.number,
          txHash: info.txHash,
          txIndex: info.txIndex,
          blockNumber: info.blockNumber,
        });
      },
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 50));
    await poller.stop();

    expect(filters.length).toBeGreaterThanOrEqual(1);
    for (const f of filters) {
      expect(f.eventTypes).toContain('KCCreated');
      expect(f.eventTypes).not.toContain('KnowledgeAssetCreated');
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].kaId).toBe(packedKaId);
    expect(seen[0].author).toBe(author.toLowerCase());
    expect(seen[0].number).toBe(number);
    expect(seen[0].txHash).toBe('0xdeadbeef');
    expect(seen[0].txIndex).toBe(2);
    expect(seen[0].blockNumber).toBe(901);
  });

  it('enters the poll loop when onKnowledgeAssetCreated is the only subscriber wired', async () => {
    const { adapter, filters } = makeChain(1000, []);
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 60_000,
      onKnowledgeAssetCreated: async () => { /* sink */ },
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 50));
    await poller.stop();

    expect(filters.length).toBeGreaterThanOrEqual(1);
    expect(filters[0].eventTypes).toContain('KCCreated');
  });

  it('cold-starts from block 0 when onKnowledgeAssetCreated is wired', async () => {
    const { adapter, filters } = makeChain(10_000, []);
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 60_000,
      onKnowledgeAssetCreated: async () => { /* sink */ },
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 50));
    await poller.stop();

    expect(filters.length).toBeGreaterThanOrEqual(1);
    expect(filters[0].fromBlock).toBe(1);
    expect(filters[0].toBlock).toBeLessThanOrEqual(10_000);
    expect(filters[0].toBlock).toBeGreaterThanOrEqual(1);
  });
});
