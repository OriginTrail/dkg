import { describe, expect, it, vi } from 'vitest';
import type { Connection, NewStreamOptions, Stream } from '@libp2p/interface';
import { PingProbeCoordinator } from '../src/ping-probe-coordinator.js';

function harness() {
  const connection = {} as Connection;
  const runs: Array<{
    options: Omit<NewStreamOptions, 'signal'>;
    resolve: (rtt: number) => void;
    reject: (error: Error) => void;
  }> = [];
  const execute = vi.fn((_connection: Connection, options: Omit<NewStreamOptions, 'signal'>) => new Promise<number>((resolve, reject) => {
    runs.push({ options, resolve, reject });
  }));
  const coordinator = new PingProbeCoordinator(execute);
  const started = async (count: number) => { await vi.waitFor(() => expect(runs).toHaveLength(count)); };
  return { coordinator, connection, runs, execute, started };
}

describe('ping probe coordination', () => {
  it('coalesces equivalent stream policies and forwards explicit options', async () => {
    const { coordinator, connection, runs, execute, started } = harness();
    const first = coordinator.ping(connection, { runOnLimitedConnection: false, negotiateFully: false, maxOutboundStreams: 3 });
    const second = coordinator.ping(connection, { runOnLimitedConnection: false, negotiateFully: false, maxOutboundStreams: 3 });
    await started(1);
    expect(runs[0].options).toMatchObject({ runOnLimitedConnection: false, negotiateFully: false, maxOutboundStreams: 3 });
    runs[0].resolve(42);
    expect(await Promise.all([first, second])).toEqual([42, 42]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('serializes incompatible options and skips a queued probe whose caller aborts', async () => {
    const { coordinator, connection, runs, started } = harness();
    const monitor = coordinator.monitor(connection);
    const optioned = coordinator.ping(connection, { runOnLimitedConnection: false, maxOutboundStreams: Infinity });
    const controller = new AbortController();
    const cancelled = coordinator.ping(connection, { negotiateFully: false, signal: controller.signal }).catch((error) => error);
    await started(1);
    expect(runs[0].options).toMatchObject({ runOnLimitedConnection: true, negotiateFully: true });
    controller.abort(new Error('cancelled before opening a stream'));
    expect(await cancelled).toMatchObject({ message: 'cancelled before opening a stream' });
    expect(runs).toHaveLength(1);
    runs[0].resolve(10); // Physical completion includes remote FIN.
    await started(2);
    expect(runs[1].options.runOnLimitedConnection).toBe(false);
    expect(runs[1].options.maxOutboundStreams).toBe(Infinity);
    runs[1].resolve(20);
    expect(await Promise.all([monitor, optioned])).toEqual([10, 20]);
    await coordinator.drain();
    expect(runs).toHaveLength(2);
  });

  it('releases the serialized queue after a failed policy without stranding the monitor', async () => {
    const { coordinator, connection, runs, started } = harness();
    const optioned = coordinator.ping(connection, { runOnLimitedConnection: false }).catch((error) => error);
    const monitor = coordinator.monitor(connection);
    await started(1);
    runs[0].reject(new Error('caller excluded this connection'));
    await started(2);
    expect(runs[1].options.runOnLimitedConnection).toBe(true);
    runs[1].resolve(7);
    expect(await optioned).toMatchObject({ message: 'caller excluded this connection' });
    expect(await monitor).toBe(7);
  });

  it('replays stream progress to late callers and isolates a throwing observer', async () => {
    const { coordinator, connection, runs, execute, started } = harness();
    const early = vi.fn();
    const first = coordinator.ping(connection, { onProgress: early });
    const brokenLive = coordinator.ping(connection, { onProgress: () => { throw new Error('live observer failed'); } }).catch((error) => error);
    const monitor = coordinator.monitor(connection);
    await started(1);
    const opening = { type: 'connection:open-stream' as const, detail: { connection, protocols: ['/ipfs/ping/1.0.0'] } };
    const opened = { type: 'connection:opened-stream' as const, detail: { connection, stream: {} as Stream } };
    runs[0].options.onProgress?.(opening);
    expect(await brokenLive).toMatchObject({ message: 'live observer failed' });
    const late = vi.fn();
    const second = coordinator.ping(connection, { onProgress: late });
    const broken = coordinator.ping(connection, { onProgress: () => { throw new Error('observer failed'); } }).catch((error) => error);
    expect(await broken).toMatchObject({ message: 'observer failed' });
    runs[0].options.onProgress?.(opened);
    expect(early.mock.calls.map(([event]) => event.type)).toEqual(['connection:open-stream', 'connection:opened-stream']);
    expect(late.mock.calls.map(([event]) => event.type)).toEqual(['connection:open-stream', 'connection:opened-stream']);
    runs[0].resolve(12);
    expect(await Promise.all([first, second, monitor])).toEqual([12, 12, 12]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('detaches a cancelled progress observer without cancelling shared physical work', async () => {
    const { coordinator, connection, runs, started } = harness();
    const controller = new AbortController();
    const progress = vi.fn();
    const cancelled = coordinator.ping(connection, { signal: controller.signal, onProgress: progress }).catch((error) => error);
    const remaining = coordinator.ping(connection, {});
    await started(1);
    controller.abort(new Error('only this caller'));
    runs[0].options.onProgress?.({ type: 'connection:open-stream', detail: { connection, protocols: [] } });
    runs[0].resolve(5);
    expect(await cancelled).toMatchObject({ message: 'only this caller' });
    expect(await remaining).toBe(5);
    expect(progress).not.toHaveBeenCalled();
  });

  it('delivers progress once when an observer adds another caller during fanout', async () => {
    const { coordinator, connection, runs, started } = harness();
    const lateProgress = vi.fn();
    let late!: Promise<number>;
    const early = coordinator.ping(connection, {
      onProgress: () => { late = coordinator.ping(connection, { onProgress: lateProgress }); },
    });
    await started(1);
    runs[0].options.onProgress?.({ type: 'connection:open-stream', detail: { connection, protocols: [] } });
    expect(lateProgress).toHaveBeenCalledTimes(1);
    runs[0].resolve(3);
    expect(await Promise.all([early, late])).toEqual([3, 3]);
  });

  it('bounds observer fanout while allowing the monitor to join saturated work', async () => {
    const { coordinator, connection, runs, started } = harness();
    const callers = Array.from({ length: 64 }, () => coordinator.ping(connection, {}));
    await expect(coordinator.ping(connection, {})).rejects.toThrow('Too many pending ping observers');
    const monitor = coordinator.monitor(connection);
    await started(1);
    runs[0].resolve(5);
    expect(await Promise.all([...callers, monitor])).toHaveLength(65);
    await coordinator.drain();
    const next = coordinator.ping(connection, {});
    await started(2);
    runs[1].resolve(6);
    expect(await next).toBe(6);
  });
});
