import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { pingAbortScope } from '../src/ping-abort-scope.js';

describe('ping abort scope', () => {
  it('releases every parent subscription after each completed probe without aborting its parents', () => {
    const service = new AbortController();
    const connection = new AbortController();
    for (let probe = 0; probe < 2_000; probe++) {
      const owner = new AbortController();
      const scope = pingAbortScope(service.signal, connection.signal, owner.signal);
      for (const parent of [service, connection, owner]) {
        expect(getEventListeners(parent.signal, 'abort')).toHaveLength(1);
      }
      scope.dispose();
      scope.dispose();
      for (const parent of [service, connection, owner]) {
        expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
        expect(parent.signal.aborted).toBe(false);
      }
    }
  });

  it.each([0, 1, 2])('forwards parent %s cancellation once and immediately detaches all parents', (index) => {
    const parents = Array.from({ length: 3 }, () => new AbortController());
    const scope = pingAbortScope(...parents.map((parent) => parent.signal));
    const reason = new Error('probe cancelled');
    parents[index].abort(reason);
    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBe(reason);
    for (const parent of parents) expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
    parents[(index + 1) % parents.length].abort(new Error('later cancellation'));
    expect(scope.signal.reason).toBe(reason);
    scope.dispose();
  });

  it('handles duplicate and already-aborted parents without leaving listeners behind', () => {
    const active = new AbortController();
    const stopped = new AbortController();
    const reason = new Error('already stopped');
    stopped.abort(reason);
    const scope = pingAbortScope(undefined, active.signal, active.signal, stopped.signal);
    expect(scope.signal.reason).toBe(reason);
    expect(getEventListeners(active.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(stopped.signal, 'abort')).toHaveLength(0);
    scope.dispose();
  });
});
