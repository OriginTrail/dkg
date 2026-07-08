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

  it('releases an inflight slot when work throws synchronously', async () => {
    const scheduler = new StorePriorityScheduler(1, 0);
    const boom = () => {
      throw new Error('sync boom');
    };

    await expect(
      scheduler.run('ack', 'storage-ack.sync-throw', boom as unknown as () => Promise<string>),
    ).rejects.toThrow('sync boom');
    expect(scheduler.snapshot).toMatchObject({
      ackInflight: 0,
      ackQueued: 0,
    });

    await expect(
      scheduler.run('ack', 'storage-ack.after-throw', async () => 'ok'),
    ).resolves.toBe('ok');
  });

  it('reserves a non-ACK slot for queued background work behind normal traffic', async () => {
    const scheduler = new StorePriorityScheduler(2, 0);
    const events: string[] = [];
    let releaseNormal1!: () => void;
    let releaseNormal2!: () => void;

    const normal1 = scheduler.run('normal', 'query.default.1', async () => {
      events.push('normal-1:start');
      await new Promise<void>((resolve) => {
        releaseNormal1 = resolve;
      });
      events.push('normal-1:end');
      return 'normal-1';
    });
    const normal2 = scheduler.run('normal', 'query.default.2', async () => {
      events.push('normal-2:start');
      await new Promise<void>((resolve) => {
        releaseNormal2 = resolve;
      });
      events.push('normal-2:end');
      return 'normal-2';
    });
    await tick();

    const background = scheduler.run('background', 'sync.catch-up', async () => {
      events.push('background:start');
      return 'background';
    });
    const normal3 = scheduler.run('normal', 'query.default.3', async () => {
      events.push('normal-3:start');
      return 'normal-3';
    });
    await tick();

    expect(scheduler.snapshot).toMatchObject({
      normalInflight: 2,
      normalQueued: 1,
      backgroundQueued: 1,
      backgroundReservedSlots: 1,
    });

    releaseNormal1();
    await tick();

    expect(events).toEqual([
      'normal-1:start',
      'normal-2:start',
      'normal-1:end',
      'background:start',
      'normal-3:start',
    ]);

    releaseNormal2();
    await expect(Promise.all([normal1, normal2, background, normal3])).resolves.toEqual([
      'normal-1',
      'normal-2',
      'background',
      'normal-3',
    ]);
  });

  it('does not reserve the only non-ACK slot for background work', async () => {
    const scheduler = new StorePriorityScheduler(2, 1);
    const events: string[] = [];
    let releaseAck!: () => void;
    let releaseBackground!: () => void;

    const ack = scheduler.run('ack', 'storage-ack.persist', async () => {
      events.push('ack:start');
      await new Promise<void>((resolve) => {
        releaseAck = resolve;
      });
      events.push('ack:end');
      return 'ack';
    });

    const background1 = scheduler.run('background', 'sync.catch-up.1', async () => {
      events.push('background-1:start');
      await new Promise<void>((resolve) => {
        releaseBackground = resolve;
      });
      events.push('background-1:end');
      return 'background-1';
    });
    await tick();

    const background2 = scheduler.run('background', 'sync.catch-up.2', async () => {
      events.push('background-2:start');
      return 'background-2';
    });
    const normal = scheduler.run('normal', 'query.default', async () => {
      events.push('normal:start');
      return 'normal';
    });
    await tick();

    expect(scheduler.snapshot).toMatchObject({
      ackInflight: 1,
      backgroundInflight: 1,
      backgroundQueued: 1,
      normalQueued: 1,
      backgroundReservedSlots: 0,
    });

    releaseBackground();
    await tick();

    expect(events).toEqual([
      'ack:start',
      'background-1:start',
      'background-1:end',
      'normal:start',
      'background-2:start',
    ]);

    releaseAck();
    await expect(Promise.all([ack, background1, background2, normal])).resolves.toEqual([
      'ack',
      'background-1',
      'background-2',
      'normal',
    ]);
  });
});
