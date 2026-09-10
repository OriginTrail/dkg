import { describe, expect, it } from 'vitest';
import { OutboxDrainer } from '../src/p2p/outbox-drainer.js';
import type { ProtocolOutboxPage } from '@origintrail-official/dkg-core';

function page(ids: (number | string)[], size = 1): ProtocolOutboxPage {
  return {
    entries: ids.map(id => ({ peer: 'peer', protocol: '/test', messageId: String(id), payload: new Uint8Array(size), attempts: 1, firstFailureAt: 0, lastAttemptAt: 0, nextAttemptAt: 0, lastError: 'offline' })),
    skippedOversizedEntries: 0, byteBudgetExhausted: false,
  };
}

describe('OutboxDrainer', () => {
  it('keeps wait pending until every started worker settles after a sibling failure', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const drainer = new OutboxDrainer(
      () => page(['blocked', 'failed']),
      async (entry) => {
        if (entry.messageId === 'failed') throw new Error('store write failed');
        await blocked;
      },
      { batchSize: 2, concurrency: 2 },
    );

    const tick = drainer.tick(100);
    let waitSettled = false;
    const waiting = drainer.wait().catch(() => {}).then(() => { waitSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(waitSettled).toBe(false);
    release();
    await expect(tick).rejects.toThrow('outbox retry worker');
    expect(drainer.getStats()).toMatchObject({ claimedEntries: 0, claimedBytes: 0 });
    await waiting;
    expect(waitSettled).toBe(true);
  });

  it('rejects a due loader that violates the requested limit before dispatch', async () => {
    const processed: number[] = [];
    const drainer = new OutboxDrainer(
      () => page([1, 2, 3, 4]),
      async (entry) => { processed.push(Number(entry.messageId)); },
      { batchSize: 2, concurrency: 1 },
    );

    await expect(drainer.tick(100)).rejects.toThrow('page budget');
    expect(processed).toEqual([]);
  });

  it('starts a fresh drain after a failed tick', async () => {
    let fail = true;
    let loads = 0;
    const drainer = new OutboxDrainer(
      () => { loads += 1; return page(['entry']); },
      async () => { if (fail) throw new Error('store write failed'); },
      { batchSize: 1, concurrency: 1 },
    );

    await expect(drainer.tick(100)).rejects.toThrow('outbox retry worker');
    fail = false;
    await drainer.tick(200);
    expect(loads).toBe(2);
  });

  it('stops pulling new entries while joining retries already in flight', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started: number[] = [];
    const drainer = new OutboxDrainer(
      () => page([1, 2, 3]),
      async (entry) => { started.push(Number(entry.messageId)); await blocked; },
      { batchSize: 3, concurrency: 1 },
    );

    const tick = drainer.tick(100);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stopping = drainer.stop();
    let stopSettled = false;
    void stopping.then(() => { stopSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([1]);
    expect(stopSettled).toBe(false);
    release();
    await stopping;
    expect(stopSettled).toBe(true);
    await tick;
    expect(started).toEqual([1]);
  });

  it('rejects invalid scheduler bounds at its own boundary', () => {
    expect(() => new OutboxDrainer(() => page([]), async () => {}, { batchSize: 0, concurrency: 1 }))
      .toThrow('batchSize must be a positive integer');
    expect(() => new OutboxDrainer(() => page([]), async () => {}, { batchSize: 1, concurrency: 0 }))
      .toThrow('concurrency must be a positive integer');
  });

  it('holds only one admitted byte-bounded page and exposes active and completed counters', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const budgets: unknown[] = [];
    const drainer = new OutboxDrainer((_now, budget) => {
      budgets.push(budget);
      return { ...page(['a', 'b'], 3), skippedOversizedEntries: 2, byteBudgetExhausted: true };
    }, async () => blocked, { batchSize: 10, maxPayloadBytes: 8, concurrency: 1 });
    const first = drainer.tick(100);
    expect(drainer.tick(101)).toBe(first);
    await Promise.resolve();
    expect(budgets).toEqual([{ maxEntries: 10, maxPayloadBytes: 8 }]);
    expect(drainer.getStats()).toEqual({ batchSize: 10, maxPayloadBytes: 8,
      claimedEntries: 2, claimedBytes: 6, lastBatchEntries: 2, lastBatchPayloadBytes: 6,
      skippedOversizedEntriesTotal: 2, byteBudgetDeferralsTotal: 1 });
    release();
    await first;
    expect(drainer.getStats()).toMatchObject({ claimedEntries: 0, claimedBytes: 0,
      lastBatchPayloadBytes: 6, skippedOversizedEntriesTotal: 2, byteBudgetDeferralsTotal: 1 });
  });

  it('publishes single-flight ownership before a synchronous loader re-enters', async () => {
    let reentered: Promise<void> | undefined;
    let loads = 0;
    const drainer = new OutboxDrainer(() => {
      loads++;
      if (loads === 1) reentered = drainer.tick(200);
      return page([]);
    }, async () => {});
    const first = drainer.tick(100);
    await first;
    expect(reentered).toBe(first);
    expect(loads).toBe(1);
  });

  it('admits no page if shutdown begins before the scheduled drain runs', async () => {
    let loads = 0;
    const drainer = new OutboxDrainer(() => { loads++; return page(['entry']); }, async () => {});
    const tick = drainer.tick(100);
    await drainer.stop();
    await tick;
    expect(loads).toBe(0);
    expect(drainer.getStats()).toMatchObject({ claimedBytes: 0, claimedEntries: 0 });
  });

  it.each([
    { name: 'payload sum exceeds budget', loaded: page(['large'], 9) },
    { name: 'negative oversized outcome', loaded: { ...page(['entry']), skippedOversizedEntries: -1 } },
    { name: 'fractional oversized outcome', loaded: { ...page(['entry']), skippedOversizedEntries: 0.5 } },
  ])('rejects an invalid storage page before sending: $name', async ({ loaded }) => {
    let sends = 0;
    const drainer = new OutboxDrainer(() => loaded, async () => { sends++; }, { maxPayloadBytes: 8 });
    await expect(drainer.tick(100)).rejects.toThrow(/page budget|page outcome/);
    expect(sends).toBe(0);
    expect(drainer.getStats()).toMatchObject({ claimedEntries: 0, claimedBytes: 0 });
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects unbounded or invalid numeric settings: %s', invalid => {
    for (const key of ['batchSize', 'concurrency', 'maxPayloadBytes'] as const) {
      expect(() => new OutboxDrainer(() => page([]), async () => {}, { [key]: invalid })).toThrow(/positive integer/);
    }
  });

});
