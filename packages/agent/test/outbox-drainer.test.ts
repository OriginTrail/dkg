import { describe, expect, it } from 'vitest';
import { OutboxDrainer } from '../src/p2p/outbox-drainer.js';

describe('OutboxDrainer', () => {
  it('keeps wait pending until every started worker settles after a sibling failure', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const drainer = new OutboxDrainer(
      () => ['blocked', 'failed'],
      async (entry) => {
        if (entry === 'failed') throw new Error('store write failed');
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
    await waiting;
    expect(waitSettled).toBe(true);
  });

  it('defensively caps a due loader that ignores the requested limit', async () => {
    const processed: number[] = [];
    const drainer = new OutboxDrainer(
      () => [1, 2, 3, 4],
      async (entry) => { processed.push(entry); },
      { batchSize: 2, concurrency: 1 },
    );

    await drainer.tick(100);
    expect(processed).toEqual([1, 2]);
  });

  it('starts a fresh drain after a failed tick', async () => {
    let fail = true;
    let loads = 0;
    const drainer = new OutboxDrainer(
      () => { loads += 1; return ['entry']; },
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
      () => [1, 2, 3],
      async (entry) => { started.push(entry); await blocked; },
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
    expect(() => new OutboxDrainer(() => [], async () => {}, { batchSize: 0, concurrency: 1 }))
      .toThrow('batchSize must be a positive integer');
    expect(() => new OutboxDrainer(() => [], async () => {}, { batchSize: 1, concurrency: 0 }))
      .toThrow('concurrency must be a positive integer');
  });
});
