import {
  normalizeKnowledgeAssetUpdateIdentity,
  type ChainAdapter,
  type ChainEvent,
  type EventFilter,
  type EventScanHorizonLease,
} from '@origintrail-official/dkg-chain';
import { describe, expect, it } from 'vitest';
import { ChainEventPoller, type OnCollectionUpdated } from '../src/chain-event-poller.js';
import { makeChain, makeHandler } from './helpers/chain-event-lane-fixture.js';

const CADENCE_MS = 12_000;

function update(blockNumber: number): ChainEvent {
  return {
    type: 'KnowledgeAssetUpdated',
    blockNumber,
    updateIdentity: normalizeKnowledgeAssetUpdateIdentity({
      blockNumber, logIndex: 0, blockHash: `0xblock${blockNumber}`, txHash: `0xtx${blockNumber}`,
    }),
    data: { batchId: String(blockNumber), merkleRoot: '0x' + '44'.repeat(32) },
  };
}

/**
 * A chain index that lends one lease per scan. A lease holds until the index
 * commits again, as the real one-log revision fence does.
 */
function indexedChain(events: readonly ChainEvent[]) {
  let revision = 0;
  const { adapter } = makeChain({
    head: 1_000,
    events,
    eventScanLease: (): EventScanHorizonLease => {
      const issued = revision;
      return { throughBlockNumber: 100, holds: async () => revision === issued };
    },
  });
  return { adapter, commit: () => { revision += 1; } };
}

function collectionUpdatesPoller(
  adapter: ChainAdapter,
  clock: () => number,
  onCollectionUpdated: OnCollectionUpdated,
) {
  const saved: number[] = [];
  const poller = new ChainEventPoller({
    chain: adapter,
    publishHandler: makeHandler(),
    intervalMs: CADENCE_MS,
    clock,
    cursorPersistence: {
      async loadLane() { return undefined; },
      async saveLane(_lane, block) { saved.push(block); },
    },
    onCollectionUpdated,
  });
  const poll = () => (poller as unknown as { poll(): Promise<void> }).poll();
  return { poll, saved };
}

describe('ChainEventPoller collection updates across an expired scan lease', () => {
  it('keeps the updates it dispatched when the index commits mid-scan and finishes the range next poll', async () => {
    const chain = indexedChain([update(50), update(51), update(52)]);
    const seen: number[] = [];
    let now = 0;
    const { poll, saved } = collectionUpdatesPoller(chain.adapter, () => now, async ({ blockNumber }) => {
      seen.push(blockNumber);
      if (seen.length === 2) chain.commit();
    });

    await poll();
    expect(seen).toEqual([50, 51]);
    expect(saved).toEqual([]);

    now = CADENCE_MS;
    await poll();
    expect(seen).toEqual([50, 51, 52]);
    expect(saved).toEqual([100]);
  });

  it('finishes a range in which every dispatch outlasts one index revision', async () => {
    const chain = indexedChain([update(50), update(51), update(52), update(53), update(54)]);
    const seen: number[] = [];
    let now = 0;
    const { poll, saved } = collectionUpdatesPoller(chain.adapter, () => now, async ({ blockNumber }) => {
      seen.push(blockNumber);
      chain.commit();
    });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      now = attempt * CADENCE_MS;
      await poll();
    }

    expect(seen).toEqual([50, 51, 52, 53, 54]);
    expect(saved).toEqual([100]);
  });

  it('keeps the failure backoff when the lease expires before anything was dispatched', async () => {
    let leasesIssued = 0;
    const { adapter, filters } = makeChain({
      head: 1_000,
      events: [update(50), update(51)],
      eventScanLease: () => {
        leasesIssued += 1;
        const holds = leasesIssued > 1;
        return { throughBlockNumber: 100, holds: async () => holds };
      },
    });
    const seen: number[] = [];
    let now = 0;
    const { poll, saved } = collectionUpdatesPoller(adapter, () => now, async ({ blockNumber }) => {
      seen.push(blockNumber);
    });

    await poll();
    now = CADENCE_MS;
    await poll();
    expect(filters).toHaveLength(1);
    expect(seen).toEqual([]);

    now = 60_000;
    await poll();
    expect(seen).toEqual([50, 51]);
    expect(saved).toEqual([100]);
  });

  it('does not repeat the updates dispatched before a failing one', async () => {
    const { adapter } = makeChain({ head: 100, events: [update(50), update(51), update(52)] });
    const attempts: number[] = [];
    let now = 0;
    const { poll, saved } = collectionUpdatesPoller(adapter, () => now, async ({ blockNumber }) => {
      attempts.push(blockNumber);
      if (blockNumber === 52 && attempts.length === 3) throw new Error('store busy');
    });

    await poll();
    expect(attempts).toEqual([50, 51, 52]);
    expect(saved).toEqual([]);

    now = 60_000;
    await poll();
    expect(attempts).toEqual([50, 51, 52, 52]);
    expect(saved).toEqual([100]);
  });

  it('re-reads updates it already dispatched without a lease read per row', async () => {
    const events = [update(50), update(51)];
    let iterating = false;
    let holdsWhileIterating = 0;
    const adapter = {
      chainId: 'mock:0',
      getBlockNumber: async () => 1_000,
      acquireEventScanHorizonLease: async () => ({
        throughBlockNumber: 100,
        holds: async () => {
          if (iterating) holdsWhileIterating += 1;
          return true;
        },
      }),
      listenForEvents: async function* (filter: EventFilter): AsyncIterable<ChainEvent> {
        iterating = true;
        try {
          for (const event of events) {
            if (event.blockNumber >= (filter.fromBlock ?? 0) && event.blockNumber <= (filter.toBlock ?? Infinity)) {
              yield event;
            }
          }
        } finally {
          iterating = false;
        }
      },
    } as unknown as ChainAdapter;
    const seen: number[] = [];
    let now = 0;
    const { poll, saved } = collectionUpdatesPoller(adapter, () => now, async ({ blockNumber }) => {
      seen.push(blockNumber);
    });

    await poll();
    expect(seen).toEqual([50, 51]);
    expect(holdsWhileIterating).toBe(4);

    // The replay window covers both rows again; neither is dispatched or leased.
    now = CADENCE_MS;
    await poll();
    expect(seen).toEqual([50, 51]);
    expect(holdsWhileIterating).toBe(4);
    expect(saved).toEqual([100, 100]);
  });
});
