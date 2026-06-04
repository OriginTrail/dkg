/**
 * OT-RFC-43 Option-1 — ChainEventPoller surfaces `KnowledgeAssetCreated`
 * (codex PR #976 F5 regression).
 *
 * The chain adapter's `listenForEvents()` decodes both the V10 greenfield
 * `KnowledgeAssetCreated` Solidity event AND the legacy V8/V9 batch-create
 * event into a SINGLE normalized `{ type: 'KCCreated', data: { kaId, author,
 * txHash, txIndex, ... } }` surface (see `packages/chain/src/evm-adapter-
 * events.ts` ~L119 and L193). A prior wiring iteration of the poller
 * subscribed to a distinct `KnowledgeAssetCreated` event type and dispatched
 * to `onKnowledgeAssetCreated` on a `event.type === 'KnowledgeAssetCreated'`
 * branch — but the adapter never yielded events with that type, so the
 * branch never fired and allocator reconciliation (`reconcileFloor`) never
 * ran. Cold-start refusal in `KaNumberAllocator` therefore never lifted on
 * a fresh daemon coming up against an existing chain.
 *
 * This test pins the corrected wiring: a `KCCreated` event (the only
 * create-event type the adapter ever emits) carrying `kaId` / `author` /
 * `txHash` / `txIndex` MUST dispatch to `onKnowledgeAssetCreated` with the
 * unpacked `(author, number)` pair, in addition to whatever publish-handler
 * fan-out the same event triggers.
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

describe('ChainEventPoller — KnowledgeAssetCreated (allocator reconciliation)', () => {
  it('dispatches onKnowledgeAssetCreated off the adapter-normalized KCCreated event', async () => {
    // Pack a representative author-namespaced kaId:
    //   kaId = (uint160(author) << 96) | number
    // The poller reverses this and passes the per-author `number` to the
    // allocator's reconcileFloor.
    const author = '0x' + 'a1'.repeat(20);                       // checksum-irrelevant
    const number = 7n;
    const packedKaId = (BigInt(author) << 96n) | number;

    // The adapter ALWAYS yields create-events with `type: 'KCCreated'`,
    // regardless of whether the underlying Solidity event was the V10
    // greenfield `KnowledgeAssetCreated` or the legacy batch-create. This
    // is the surface the poller must consume.
    const event: ChainEvent = {
      type: 'KCCreated',
      blockNumber: 901,
      data: {
        kaId: packedKaId.toString(),
        author,
        // Fields the publish-handler fan-out consumes; the allocator
        // reconciliation only needs kaId/author/txHash/txIndex.
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

    // (1) The poller subscribes to the real adapter surface (`KCCreated`),
    //     not a phantom `KnowledgeAssetCreated` filter type that the adapter
    //     does not emit. This is the wiring regression — the bot's F5.
    expect(filters.length).toBeGreaterThanOrEqual(1);
    for (const f of filters) {
      expect(f.eventTypes).toContain('KCCreated');
      expect(f.eventTypes).not.toContain('KnowledgeAssetCreated');
    }

    // (2) The callback receives the unpacked (author, number) plus tx
    //     coordinates needed for the allocator's reconcileFloor + dedup.
    expect(seen).toHaveLength(1);
    expect(seen[0].kaId).toBe(packedKaId);
    expect(seen[0].author).toBe(author.toLowerCase());
    expect(seen[0].number).toBe(number);
    expect(seen[0].txHash).toBe('0xdeadbeef');
    expect(seen[0].txIndex).toBe(2);
    expect(seen[0].blockNumber).toBe(901);
  });

  it('enters the poll loop when onKnowledgeAssetCreated is the only subscriber wired', async () => {
    // No pending publishes, no other callbacks — the only reason to scan is
    // allocator reconciliation. The gating check must include `watchKACreated`.
    const { adapter, filters } = makeChain(1000, []);
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());

    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 60_000,
      onKnowledgeAssetCreated: async () => {
        // intentionally empty — we only care that the poll fires
      },
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 50));
    await poller.stop();

    expect(filters.length).toBeGreaterThanOrEqual(1);
    // KCCreated is always subscribed (it's the V10 publish-flow surface),
    // independent of whether allocator reconciliation is also wired.
    expect(filters[0].eventTypes).toContain('KCCreated');
  });

  // codex PR #976 F9: when `onKnowledgeAssetCreated` is wired and there
  // is no persisted cursor, the poller MUST backfill from block 0.
  // Without this, a fresh daemon would skip every `KCCreated` event
  // older than ~500 blocks (the "seed near head" optimisation that
  // applies to the pending-publish watcher) and the per-author floor
  // for older authors would stay at 0. A subsequent `markReconciled()`
  // would then be unsound — the allocator could re-issue a number
  // already minted on-chain.
  it('cold-starts from block 0 when onKnowledgeAssetCreated is wired (F9 backfill)', async () => {
    // Chain head is 10_000 — well past the 500-block head-seed window.
    // If the F9 backfill is missing, the poller would seed `lastBlock`
    // at 9500 and the first filter would have fromBlock=9501, which
    // would miss every historical `KCCreated` at e.g. block 1.
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
    // First poll scans from block 1 (fromBlock = lastBlock + 1, and
    // lastBlock stays at 0 because the F9 backfill suppressed the
    // head-seed). Pre-fix this would have been 9501.
    expect(filters[0].fromBlock).toBe(1);
    // toBlock is capped by MAX_RANGE (9000) not the chain head, but it
    // MUST cover historical territory (block 1) not just the tip.
    expect(filters[0].toBlock).toBeLessThanOrEqual(10_000);
    expect(filters[0].toBlock).toBeGreaterThanOrEqual(1);
  });

  // Sanity inverse: with NO allocator watcher and no pending publishes,
  // the head-seed optimisation still kicks in. We're not regressing
  // the existing behaviour for the "watch context graphs only" path.
  it('still seeds near head when onKnowledgeAssetCreated is NOT wired', async () => {
    const { adapter, filters } = makeChain(10_000, []);
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus());

    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 60_000,
      onContextGraphCreated: async () => { /* sink */ },
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 50));
    await poller.stop();

    expect(filters.length).toBeGreaterThanOrEqual(1);
    // head-seed: lastBlock = head - 500 = 9500, so fromBlock = 9501.
    expect(filters[0].fromBlock).toBe(9_501);
  });
});
