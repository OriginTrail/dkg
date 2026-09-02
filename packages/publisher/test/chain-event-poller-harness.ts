/**
 * Shared harness for the `kaRootMutations` suites (split from the single
 * 1,065-line file at PR #2436 review r16): the fake chain adapter, the event
 * factory, and the direct `poll()` driver. NOT a test file — no rows here.
 */
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import {
  KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES,
  type ChainAdapter,
  type ChainEvent,
  type EventFilter,
} from '@origintrail-official/dkg-chain';
import type { ChainEventPoller } from '../src/chain-event-poller.js';
import { PublishHandler } from '../src/publish-handler.js';

export const MAX_RANGE = 9_000;
export const CADENCE_MS = 12_000;

export const TX_HASH = '0x' + 'aa'.repeat(32);
export const BLOCK_HASH = '0x' + 'bb'.repeat(32);
export const ROOT = '0x' + '44'.repeat(32);
export const AUTHOR = '0x' + '11'.repeat(20);

export function makeHandler(): PublishHandler {
  return new PublishHandler(new OxigraphStore(), new TypedEventBus());
}

export interface Harness {
  adapter: ChainAdapter;
  filters: EventFilter[];
  setHead(next: number): void;
  failNextScan(err?: Error): void;
}

export function makeChain(head: number, events: ChainEvent[] = []): Harness {
  const filters: EventFilter[] = [];
  let currentHead = head;
  let failWith: Error | null = null;
  const adapter = {
    chainId: 'mock:0',
    getBlockNumber: async () => currentHead,
    // A capable adapter serves every root-mutation kind (review r17): rows
    // that test an absent or negative probe override this explicitly.
    supportsEventTypes: async () => [],
    listenForEvents: async function* (f: EventFilter): AsyncIterable<ChainEvent> {
      filters.push(f);
      if (failWith) {
        const err = failWith;
        failWith = null;
        throw err;
      }
      const fromBlock = f.fromBlock ?? 0;
      const toBlock = f.toBlock ?? Number.MAX_SAFE_INTEGER;
      for (const evt of events) {
        if (f.eventTypes.includes(evt.type) && evt.blockNumber >= fromBlock && evt.blockNumber <= toBlock) {
          yield evt;
        }
      }
    },
  } as unknown as ChainAdapter;
  return {
    adapter,
    filters,
    setHead: (next) => { currentHead = next; },
    failNextScan: (err = new Error('scan boom')) => { failWith = err; },
  };
}

export function rootMutation(
  type: (typeof KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES)[number],
  blockNumber: number,
  overrides: Record<string, unknown> = {},
): ChainEvent {
  const base: Record<string, unknown> = {
    kaId: '42',
    txHash: TX_HASH,
    blockHash: BLOCK_HASH,
    txIndex: 2,
    logIndex: 5,
  };
  if (type !== 'KnowledgeAssetMerkleRootsUpdated') base['merkleRoot'] = ROOT;
  if (type === 'KnowledgeAssetUpdated') base['author'] = AUTHOR;
  return { type, blockNumber, data: { ...base, ...overrides } };
}

/** Drive `poll()` directly — the interval timer is never started here. */
export function poll(poller: ChainEventPoller): Promise<void> {
  return (poller as unknown as { poll(): Promise<void> }).poll();
}

/**
 * Force a scan NOW regardless of lane cadence — the TEST SEAM that replaced
 * the deleted public `pollNow()` (PR #2436 review r17: no production caller
 * existed, and the manual-queue lifecycle it required was the source of four
 * review rounds of coordination bugs). Clears the lane schedules, then drives
 * the private `poll()`; a whole-poll rejection propagates to the caller.
 */
export async function forceScan(poller: ChainEventPoller): Promise<void> {
  (poller as unknown as { laneRunner: { clearActiveLaneSchedules(): void } })
    .laneRunner.clearActiveLaneSchedules();
  await (poller as unknown as { poll(): Promise<void> }).poll();
}
