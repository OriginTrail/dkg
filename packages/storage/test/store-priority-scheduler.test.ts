import { describe, expect, it } from 'vitest';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('StorePriorityScheduler', () => {
  it('lets ACK work jump ahead of queued background work', async () => {
    const scheduler = new StorePriorityScheduler(2, 1);
    const events: string[] = [];
    let releaseBackground!: () => void;
    const backgroundGate = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });

    const firstBackground = scheduler.run('background', 'sync.listGraphs', async () => {
      events.push('background-1:start');
      await backgroundGate;
      events.push('background-1:end');
      return 'background-1';
    });
    await tick();

    const secondBackground = scheduler.run('background', 'metrics.countQuads', async () => {
      events.push('background-2:start');
      return 'background-2';
    });
    await tick();

    expect(scheduler.snapshot).toMatchObject({
      backgroundInflight: 1,
      backgroundQueued: 1,
      ackInflight: 0,
    });

    const ack = scheduler.run('ack', 'storage-ack.loadSWMQuads', async () => {
      events.push('ack:start');
      return 'ack';
    });
    await expect(ack).resolves.toBe('ack');

    expect(events).toEqual(['background-1:start', 'ack:start']);

    releaseBackground();
    await expect(Promise.all([firstBackground, secondBackground])).resolves.toEqual([
      'background-1',
      'background-2',
    ]);
    expect(events).toEqual([
      'background-1:start',
      'ack:start',
      'background-1:end',
      'background-2:start',
    ]);
  });
});
