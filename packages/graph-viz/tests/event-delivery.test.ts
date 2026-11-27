import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphEventEmitter } from '../src/core/events.js';

afterEach(() => vi.restoreAllMocks());

describe('graph event delivery', () => {
  it('delivers once per handler and respects both unsubscribe forms', () => {
    const events = new GraphEventEmitter(); const first = vi.fn(); const second = vi.fn();
    const remove = events.on('background:click', first); events.on('background:click', first); events.on('background:click', second);
    const error = { x: 12, y: 34 }; events.emit('background:click', error);
    expect(first).toHaveBeenCalledExactlyOnceWith(error); expect(second).toHaveBeenCalledExactlyOnceWith(error);
    remove(); remove(); events.emit('background:click', error);
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(2);
    events.off('background:click', second); events.off('focus:change', vi.fn()); events.emit('background:click', error);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('isolates a failing subscriber so subsequent listeners still receive the original event', () => {
    const events = new GraphEventEmitter(); const failure = new Error('consumer failed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {}); const listener = vi.fn();
    events.on('background:click', () => { throw failure; }); events.on('background:click', listener);
    const event = { x: 12, y: 34 };
    expect(() => events.emit('background:click', event)).not.toThrow();
    expect(listener).toHaveBeenCalledExactlyOnceWith(event);
    expect(log).toHaveBeenCalledExactlyOnceWith('[dkg-graph-viz] Error in background:click handler:', failure);
  });

  it('clears only the requested event, then all events, without stale unsubscribe affecting new listeners', () => {
    const events = new GraphEventEmitter(); const old = vi.fn(); const other = vi.fn(); const replacement = vi.fn();
    const unsubscribe = events.on('background:click', old); events.on('focus:change', other);
    events.removeAll('background:click'); events.on('background:click', replacement); unsubscribe();
    events.emit('background:click', { x: 0, y: 1 });
    events.emit('focus:change', { focalNode: 'urn:a', visibleNodes: 2 });
    expect(old).not.toHaveBeenCalled(); expect(replacement).toHaveBeenCalledOnce(); expect(other).toHaveBeenCalledOnce();
    events.removeAll(); events.emit('background:click', { x: 0, y: 1 }); events.emit('focus:change', { focalNode: null, visibleNodes: 0 });
    expect(replacement).toHaveBeenCalledOnce(); expect(other).toHaveBeenCalledOnce();
  });

  it.each([false, true])('preserves re-registration of the same handler after removeAll (all events: %s)', allEvents => {
    const events = new GraphEventEmitter();
    const handler = vi.fn();
    const unsubscribeOld = events.on('background:click', handler);
    events.removeAll(allEvents ? undefined : 'background:click');
    const unsubscribeNew = events.on('background:click', handler);
    unsubscribeOld();
    const event = { x: 3, y: 4 };
    events.emit('background:click', event);
    expect(handler).toHaveBeenCalledExactlyOnceWith(event);
    unsubscribeNew();
    events.emit('background:click', event);
    expect(handler).toHaveBeenCalledOnce();
  });
});
