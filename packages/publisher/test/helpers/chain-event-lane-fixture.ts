import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus, createOperationContext } from '@origintrail-official/dkg-core';
import type { ChainAdapter, ChainEvent, EventFilter } from '@origintrail-official/dkg-chain';
import { PublishHandler } from '../../src/publish-handler.js';
import type { ChainEventDispatchContext } from '../../src/chain-event-dispatch-context.js';
import type { ChainEventPoller } from '../../src/chain-event-poller.js';
import type { JournalEntry } from '../../src/publish-journal.js';

interface ChainFixtureOptions {
  head: number | (() => number);
  events?: readonly ChainEvent[];
  onListen?: (filter: EventFilter) => void;
}

export function makeChain({ head, events = [], onListen }: ChainFixtureOptions): {
  adapter: ChainAdapter;
  filters: EventFilter[];
} {
  const filters: EventFilter[] = [];
  const adapter = {
    chainId: 'mock:0',
    getBlockNumber: async () => typeof head === 'function' ? head() : head,
    listenForEvents: async function* (f: EventFilter): AsyncIterable<ChainEvent> {
      filters.push(f);
      onListen?.(f);
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

export function makeHandler(): PublishHandler {
  return new PublishHandler(new OxigraphStore(), new TypedEventBus());
}

export function markPending(handler: PublishHandler, restoredFromJournal: boolean): void {
  (handler as unknown as { pendingPublishes: Map<string, unknown> }).pendingPublishes.set(
    restoredFromJournal ? 'restored' : 'live',
    { expectedMerkleRoot: new Uint8Array(32), restoredFromJournal },
  );
}

export function journalEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    ual: 'did:dkg:mock:0/0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/1',
    contextGraphId: 'contextGraph-1',
    expectedPublisherAddress: '0x' + 'a1'.repeat(20),
    expectedMerkleRoot: '0x' + '55'.repeat(32),
    expectedStartKAId: '1',
    expectedEndKAId: '1',
    expectedChainId: 'mock:0',
    rootEntities: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

export function createLaneRunContext(): ChainEventDispatchContext {
  return { operation: createOperationContext('publish'), signal: new AbortController().signal };
}

export async function pollOnce(poller: ChainEventPoller): Promise<void> {
  await (poller as unknown as { poll(context: ChainEventDispatchContext): Promise<void> })
    .poll(createLaneRunContext());
}
