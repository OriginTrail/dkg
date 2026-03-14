import { describe, it, expect, vi } from 'vitest';
import { TypedEventBus, DKGEvent } from '../src/index.js';

describe('TypedEventBus', () => {
  it('emits and receives events', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    bus.on(DKGEvent.KC_PUBLISHED, handler);
    bus.emit(DKGEvent.KC_PUBLISHED, { kcId: '1' });
    expect(handler).toHaveBeenCalledWith({ kcId: '1' });
  });

  it('removes listeners with off', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    bus.on('test', handler);
    bus.off('test', handler);
    bus.emit('test', null);
    expect(handler).not.toHaveBeenCalled();
  });

  it('once fires exactly once', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    bus.once('test', handler);
    bus.emit('test', 'a');
    bus.emit('test', 'b');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('a');
  });

  it('does not crash on emit with no listeners', () => {
    const bus = new TypedEventBus();
    expect(() => bus.emit('nonexistent', null)).not.toThrow();
  });

  it('removeAllListeners clears specific event', () => {
    const bus = new TypedEventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('a', h1);
    bus.on('b', h2);
    bus.removeAllListeners('a');
    bus.emit('a', null);
    bus.emit('b', null);
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
  });

  it('logs errors from handlers without crashing other handlers', () => {
    const bus = new TypedEventBus();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const goodHandler = vi.fn();
    const badHandler = () => { throw new Error('handler broke'); };

    bus.on('test', badHandler);
    bus.on('test', goodHandler);
    bus.emit('test', 'data');

    expect(goodHandler).toHaveBeenCalledWith('data');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[EventBus] Handler error'),
      'handler broke',
    );
    errorSpy.mockRestore();
  });

  it('DKGEvent includes connection observability constants', () => {
    expect(DKGEvent.CONNECTION_OPEN).toBe('connection:open');
    expect(DKGEvent.CONNECTION_CLOSE).toBe('connection:close');
    expect(DKGEvent.CONNECTION_UPGRADED).toBe('connection:upgraded');
  });

  it('emits connection events through the bus', () => {
    const bus = new TypedEventBus();
    const openHandler = vi.fn();
    const closeHandler = vi.fn();
    bus.on(DKGEvent.CONNECTION_OPEN, openHandler);
    bus.on(DKGEvent.CONNECTION_CLOSE, closeHandler);

    const info = {
      peerId: '12D3KooWTest',
      remoteAddr: '/ip4/127.0.0.1/tcp/4001',
      transport: 'direct' as const,
      direction: 'outbound' as const,
      openedAt: Date.now(),
    };

    bus.emit(DKGEvent.CONNECTION_OPEN, info);
    expect(openHandler).toHaveBeenCalledWith(info);

    bus.emit(DKGEvent.CONNECTION_CLOSE, info);
    expect(closeHandler).toHaveBeenCalledWith(info);
  });
});
