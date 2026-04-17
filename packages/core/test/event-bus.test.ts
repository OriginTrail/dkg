import { describe, it, expect } from 'vitest';
import { TypedEventBus, DKGEvent } from '../src/index.js';

function tracker() {
  const calls: any[] = [];
  const fn = (data: any) => { calls.push(data); };
  return { calls, fn };
}

describe('TypedEventBus', () => {
  it('emits and receives events', () => {
    const bus = new TypedEventBus();
    const { calls, fn } = tracker();
    bus.on(DKGEvent.KC_PUBLISHED, fn);
    bus.emit(DKGEvent.KC_PUBLISHED, { kcId: '1' });
    expect(calls).toEqual([{ kcId: '1' }]);
  });

  it('removes listeners with off', () => {
    const bus = new TypedEventBus();
    const { calls, fn } = tracker();
    bus.on('test', fn);
    bus.off('test', fn);
    bus.emit('test', null);
    expect(calls).toHaveLength(0);
  });

  it('once fires exactly once', () => {
    const bus = new TypedEventBus();
    const { calls, fn } = tracker();
    bus.once('test', fn);
    bus.emit('test', 'a');
    bus.emit('test', 'b');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('a');
  });

  it('does not crash on emit with no listeners', () => {
    const bus = new TypedEventBus();
    expect(() => bus.emit('nonexistent', null)).not.toThrow();
  });

  it('removeAllListeners clears specific event', () => {
    const bus = new TypedEventBus();
    const t1 = tracker();
    const t2 = tracker();
    bus.on('a', t1.fn);
    bus.on('b', t2.fn);
    bus.removeAllListeners('a');
    bus.emit('a', null);
    bus.emit('b', null);
    expect(t1.calls).toHaveLength(0);
    expect(t2.calls).toHaveLength(1);
  });

  it('logs errors from handlers without crashing other handlers', () => {
    const bus = new TypedEventBus();
    const stderrOutput: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: any) => { stderrOutput.push(String(chunk)); return true; }) as any;
    const origError = console.error;
    const errorCalls: any[][] = [];
    console.error = (...args: any[]) => { errorCalls.push(args); };

    const { calls: goodCalls, fn: goodHandler } = tracker();
    const badHandler = () => { throw new Error('handler broke'); };

    bus.on('test', badHandler);
    bus.on('test', goodHandler);
    bus.emit('test', 'data');

    console.error = origError;
    process.stderr.write = origWrite;

    expect(goodCalls).toEqual(['data']);
    expect(errorCalls.some(call => String(call[0]).includes('[EventBus] Handler error'))).toBe(true);
    expect(errorCalls.some(call => call.includes('handler broke'))).toBe(true);
  });

  it('DKGEvent includes connection observability constants', () => {
    expect(DKGEvent.CONNECTION_OPEN).toBe('connection:open');
    expect(DKGEvent.CONNECTION_CLOSE).toBe('connection:close');
    expect(DKGEvent.CONNECTION_UPGRADED).toBe('connection:upgraded');
  });

  it('emits connection events through the bus', () => {
    const bus = new TypedEventBus();
    const openTracker = tracker();
    const closeTracker = tracker();
    bus.on(DKGEvent.CONNECTION_OPEN, openTracker.fn);
    bus.on(DKGEvent.CONNECTION_CLOSE, closeTracker.fn);

    const info = {
      peerId: '12D3KooWTest',
      remoteAddr: '/ip4/127.0.0.1/tcp/4001',
      transport: 'direct' as const,
      direction: 'outbound' as const,
      openedAt: Date.now(),
    };

    bus.emit(DKGEvent.CONNECTION_OPEN, info);
    expect(openTracker.calls).toEqual([info]);

    bus.emit(DKGEvent.CONNECTION_CLOSE, info);
    expect(closeTracker.calls).toEqual([info]);
  });
});
