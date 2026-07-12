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
      2,
      2,
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
});
