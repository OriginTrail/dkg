import { TypedEventBus } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { describe, expect, it } from 'vitest';
import type { ChainEvent } from '@origintrail-official/dkg-chain';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import { PublishHandler } from '../src/publish-handler.js';
import { makeChain, makeHandler, markPending, journalEntry } from './helpers/chain-event-lane-fixture.js';

describe('ChainEventPoller publish', () => {
  it('cold-starts a restored pending publish lane from block 0 without allocator callbacks', async () => {
    const merkleRoot = '0x' + '55'.repeat(32);
    const oldCreate: ChainEvent = {
      type: 'KCCreated',
      blockNumber: 1,
      data: {
        kaId: '1',
        author: '0x' + 'a1'.repeat(20),
        merkleRoot,
        publisherAddress: '0x' + 'a1'.repeat(20),
        startKAId: '1',
        endKAId: '1',
        txHash: '0xabc',
        txIndex: 0,
      },
    };
    const { adapter, filters } = makeChain({ head: 10_000, events: [oldCreate] });
    const handler = makeHandler();
    markPending(handler, true);
    const confirmed: unknown[] = [];
    (handler as unknown as { confirmByMerkleRoot: (...args: unknown[]) => Promise<boolean> }).confirmByMerkleRoot = async (...args) => {
      confirmed.push(args);
      return true;
    };

    const poller = new ChainEventPoller({ chain: adapter, publishHandler: handler, intervalMs: 60_000 });

    await poller.start();
    await poller.waitForCurrentPoll();
    await poller.stop();

    expect(filters).toHaveLength(1);
    expect(filters[0].eventTypes).toEqual(['KCCreated']);
    expect(filters[0].fromBlock).toBe(1);
    expect(filters[0].toBlock).toBe(9000);
    expect(confirmed).toHaveLength(1);
  });

  it('uses the journal restore path to mark restored publishes for backfill', async () => {
    const merkleRoot = '0x' + '55'.repeat(32);
    const oldCreate: ChainEvent = {
      type: 'KCCreated',
      blockNumber: 1,
      data: {
        kaId: '1',
        author: '0x' + 'a1'.repeat(20),
        merkleRoot,
        publisherAddress: '0x' + 'a1'.repeat(20),
        startKAId: '1',
        endKAId: '1',
        txHash: '0xabc',
        txIndex: 0,
      },
    };
    const { adapter, filters } = makeChain({ head: 10_000, events: [oldCreate] });
    const journal = {
      load: async () => [journalEntry({ expectedMerkleRoot: merkleRoot })],
      save: async () => { /* sink */ },
    };
    const handler = new PublishHandler(new OxigraphStore(), new TypedEventBus(), { journal: journal as any });
    const confirmed: unknown[] = [];
    (handler as unknown as { confirmByMerkleRoot: (...args: unknown[]) => Promise<boolean> }).confirmByMerkleRoot = async (...args) => {
      confirmed.push(args);
      return true;
    };

    expect(await handler.restorePendingPublishes()).toBe(1);
    expect(handler.hasRestoredPendingPublishes).toBe(true);

    const poller = new ChainEventPoller({ chain: adapter, publishHandler: handler, intervalMs: 60_000 });
    try {
      await poller.start();
      await poller.waitForCurrentPoll();
      await poller.stop();
    } finally {
      const pending = (handler as unknown as {
        pendingPublishes: Map<string, { timeout: ReturnType<typeof setTimeout> }>;
      }).pendingPublishes;
      for (const entry of pending.values()) clearTimeout(entry.timeout);
      pending.clear();
    }

    expect(filters).toHaveLength(1);
    expect(filters[0].eventTypes).toEqual(['KCCreated']);
    expect(filters[0].fromBlock).toBe(1);
    expect(filters[0].toBlock).toBe(9000);
    expect(confirmed).toHaveLength(1);
  });

  it('seeds a newly-active live publish lane near the current head after idle', async () => {
    let head = 20_000_000;
    const { adapter, filters } = makeChain({
      head: () => head,
    });
    const handler = makeHandler();
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 20,
      onContextGraphCreated: async () => { /* idle always-on lane */ },
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();
    expect(filters.map((f) => f.eventTypes)).toEqual([
      ['NameClaimed', 'ContextGraphCreated'],
    ]);

    head = 20_000_050;
    markPending(handler, false);
    await (poller as unknown as { poll(): Promise<void> }).poll();

    const publishFilter = filters.find((f) => f.eventTypes.includes('KCCreated'));
    expect(publishFilter).toBeDefined();
    expect(publishFilter!.fromBlock).toBe(19_991_051);
    expect(publishFilter!.toBlock).toBe(20_000_050);
  });

  it('scans a full page behind head for newly-active live publish confirmations', async () => {
    const merkleRoot = '0x' + '00'.repeat(32);
    const oldCreate: ChainEvent = {
      type: 'KCCreated',
      blockNumber: 9000,
      data: {
        kaId: '1',
        author: '0x' + 'a1'.repeat(20),
        merkleRoot,
        publisherAddress: '0x' + 'a1'.repeat(20),
        startKAId: '1',
        endKAId: '1',
        txHash: '0xabc',
        txIndex: 0,
      },
    };
    const { adapter, filters } = makeChain({ head: 10_000, events: [oldCreate] });
    const handler = makeHandler();
    markPending(handler, false);
    const confirmed: unknown[] = [];
    (handler as unknown as { confirmByMerkleRoot: (...args: unknown[]) => Promise<boolean> }).confirmByMerkleRoot = async (...args) => {
      confirmed.push(args);
      return true;
    };
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 60_000,
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(filters).toHaveLength(1);
    expect(filters[0].eventTypes).toEqual(['KCCreated']);
    expect(filters[0].fromBlock).toBe(1001);
    expect(filters[0].toBlock).toBe(10_000);
    expect(confirmed).toHaveLength(1);
  });

  it('re-seeds live publish confirmations near head after restored publish backfill clears', async () => {
    const restoredMerkleRoot = '0x' + '11'.repeat(32);
    const liveMerkleRoot = '0x' + '22'.repeat(32);
    const events: ChainEvent[] = [
      {
        type: 'KCCreated',
        blockNumber: 1,
        data: {
          kaId: '1',
          author: '0x' + 'a1'.repeat(20),
          merkleRoot: restoredMerkleRoot,
          publisherAddress: '0x' + 'a1'.repeat(20),
          startKAId: '1',
          endKAId: '1',
          txHash: '0xrestored',
          txIndex: 0,
        },
      },
      {
        type: 'KCCreated',
        blockNumber: 1_999_950,
        data: {
          kaId: '2',
          author: '0x' + 'b2'.repeat(20),
          merkleRoot: liveMerkleRoot,
          publisherAddress: '0x' + 'b2'.repeat(20),
          startKAId: '2',
          endKAId: '2',
          txHash: '0xlive',
          txIndex: 0,
        },
      },
    ];
    const { adapter, filters } = makeChain({ head: 2_000_000, events });
    const handler = makeHandler();
    markPending(handler, true);
    markPending(handler, false);
    const pending = (handler as unknown as {
      pendingPublishes: Map<string, { restoredFromJournal: boolean }>;
    }).pendingPublishes;
    const confirmed: number[] = [];
    (handler as unknown as { confirmByMerkleRoot: (...args: unknown[]) => Promise<boolean> }).confirmByMerkleRoot = async (merkleRoot) => {
      const root = merkleRoot as Uint8Array;
      confirmed.push(root[0]);
      if (root[0] === 0x11) pending.delete('restored');
      if (root[0] === 0x22) pending.delete('live');
      return true;
    };
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: handler,
      intervalMs: 60_000,
    });

    await (poller as unknown as { poll(): Promise<void> }).poll();
    await (poller as unknown as { poll(): Promise<void> }).poll();

    expect(filters).toHaveLength(2);
    expect(filters[0].eventTypes).toEqual(['KCCreated']);
    expect(filters[0].fromBlock).toBe(1);
    expect(filters[0].toBlock).toBe(9000);
    expect(filters[1].eventTypes).toEqual(['KCCreated']);
    expect(filters[1].fromBlock).toBe(1_991_001);
    expect(filters[1].toBlock).toBe(2_000_000);
    expect(confirmed).toEqual([0x11, 0x22]);
  });
});
