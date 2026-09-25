import { describe, expect, it, vi } from 'vitest';
import { UnsupportedProtocolError, type Connection, type NewStreamOptions, type Stream } from '@libp2p/interface';
import { PingProbeCoordinator } from '../src/ping-probe-coordinator.js';

function harness() {
  const connection = {} as Connection;
  const runs: Array<{
    options: NewStreamOptions & { signal: AbortSignal };
    resolve: (rtt: number) => void;
    reject: (error: Error) => void;
  }> = [];
  const execute = vi.fn((_connection: Connection, options: NewStreamOptions & { signal: AbortSignal }) => new Promise<number>((resolve, reject) => {
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
    expect(runs[0].options.signal.aborted).toBe(false);
    runs[0].options.onProgress?.({ type: 'connection:open-stream', detail: { connection, protocols: [] } });
    runs[0].resolve(5);
    expect(await cancelled).toMatchObject({ message: 'only this caller' });
    expect(await remaining).toBe(5);
    expect(progress).not.toHaveBeenCalled();
  });

  it('rejects unsupported explicit pings while a monitor sharing the negotiation accepts liveness', async () => {
    const { coordinator, connection, runs, execute, started } = harness();
    const explicit = coordinator.ping(connection, {}).catch((error) => error);
    const monitored = coordinator.monitor(connection);
    await started(1);
    const unsupported = new UnsupportedProtocolError('Peer does not support ping');
    runs[0].reject(unsupported);
    expect(await explicit).toBe(unsupported);
    await expect(monitored).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('cancels orphaned physical work and queues fresh ownership until it releases the stream', async () => {
    const { coordinator, connection, runs, started } = harness();
    const controller = new AbortController();
    const cancelled = coordinator.ping(connection, { signal: controller.signal }).catch((error) => error);
    await started(1);
    const reason = new Error('sole observer cancelled');
    controller.abort(reason);
    expect(await cancelled).toBe(reason);
    expect(runs[0].options.signal.aborted).toBe(true);
    expect(runs[0].options.signal.reason).toBe(reason);
    // An aborted flight must not be adopted, but still owns the protocol slot
    // until its physical transport acknowledges cancellation.
    const next = coordinator.ping(connection, {});
    const monitor = coordinator.monitor(connection);
    await Promise.resolve();
    expect(runs).toHaveLength(1);
    runs[0].reject(reason);
    await started(2);
    expect(runs[1].options.signal.aborted).toBe(false);
    runs[1].resolve(7);
    expect(await next).toBe(7);
    await expect(monitor).resolves.toBe(7);
    await coordinator.drain();
  });

  it('retains a monitor-owned probe after its last explicit observer cancels', async () => {
    const { coordinator, connection, runs, started } = harness();
    const controller = new AbortController();
    const cancelled = coordinator.ping(connection, { signal: controller.signal }).catch((error) => error);
    await started(1);
    const monitor = coordinator.monitor(connection);
    controller.abort(new Error('caller cancelled'));
    expect(await cancelled).toMatchObject({ message: 'caller cancelled' });
    expect(runs[0].options.signal.aborted).toBe(false);
    runs[0].resolve(5);
    await expect(monitor).resolves.toBe(5);
  });

  it('cancels physical work when its last progress observer throws', async () => {
    const { coordinator, connection, runs, started } = harness();
    const reason = new Error('progress observer failed');
    const failed = coordinator.ping(connection, { onProgress: () => { throw reason; } }).catch((error) => error);
    await started(1);
    runs[0].options.onProgress?.({ type: 'connection:open-stream', detail: { connection, protocols: [] } });
    expect(await failed).toBe(reason);
    expect(runs[0].options.signal.aborted).toBe(true);
    runs[0].reject(reason);
    await coordinator.drain();
  });

  it('bounds incompatible physical flights independently of observers and recovers after draining', async () => {
    const { coordinator, connection, runs, started } = harness();
    const monitor = coordinator.monitor(connection);
    const callers = Array.from({ length: 63 }, (_, index) => coordinator.ping(connection, { maxOutboundStreams: index + 1 }));
    expect(() => coordinator.ping(connection, { maxOutboundStreams: 64 })).toThrow('Too many queued ping probes');
    const joined = coordinator.monitor(connection);
    for (let index = 0; index < 64; index++) {
      await started(index + 1);
      runs[index].resolve(index);
    }
    expect(await Promise.all(callers)).toEqual(Array.from({ length: 63 }, (_, index) => index + 1));
    await Promise.all([monitor, joined]);
    await coordinator.drain();
    const next = coordinator.ping(connection, { maxOutboundStreams: 64 });
    await started(65);
    runs[64].resolve(65);
    expect(await next).toBe(65);
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
