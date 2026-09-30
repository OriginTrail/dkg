import { describe, expect, it, vi } from 'vitest';
import { createBoundedDenialLogger, createBoundedKeyedEmitter } from '../src/bounded-denial-logger.js';

function logger(overrides: { intervalMs?: number; cacheMax?: number } = {}) {
  let now = 0;
  const lines: string[] = [];
  const logDenial = createBoundedDenialLogger({
    log: (message) => lines.push(message),
    now: () => now,
    intervalMs: overrides.intervalMs ?? 1_000,
    cacheMax: overrides.cacheMax ?? 8,
  });
  return {
    lines,
    logDenial,
    advance: (ms: number) => { now += ms; },
  };
}

describe('createBoundedDenialLogger', () => {
  it('logs once per key per interval and reports what it suppressed', () => {
    const { lines, logDenial, advance } = logger();

    logDenial('outbound:a', () => 'deny a');
    logDenial('outbound:a', () => 'deny a');
    logDenial('outbound:a', () => 'deny a');
    advance(999);
    logDenial('outbound:a', () => 'deny a');
    advance(1);
    logDenial('outbound:a', () => 'deny a again');
    advance(1_000);
    logDenial('outbound:a', () => 'deny a quiet');

    expect(lines).toEqual([
      'deny a',
      'deny a again suppressedSinceLast=3',
      'deny a quiet',
    ]);
  });

  it('keeps keys independent and builds a message only when it logs', () => {
    const { lines, logDenial } = logger();
    const suppressedMessage = vi.fn(() => 'never built');

    logDenial('outbound:a', () => 'deny a');
    logDenial('inbound:a', () => 'deny a inbound');
    logDenial('outbound:a', suppressedMessage);

    expect(lines).toEqual(['deny a', 'deny a inbound']);
    expect(suppressedMessage).not.toHaveBeenCalled();
  });

  it('bounds its memory by evicting the least recently logged key', () => {
    const { lines, logDenial, advance } = logger({ cacheMax: 2 });

    logDenial('a', () => 'a');
    advance(1);
    logDenial('b', () => 'b');
    advance(1);
    logDenial('c', () => 'c');
    // `a` was evicted, so it logs again inside its interval; `c` was not.
    logDenial('a', () => 'a again');
    logDenial('c', () => 'c again');

    expect(lines).toEqual(['a', 'b', 'c', 'a again']);
  });
});

describe('createBoundedKeyedEmitter', () => {
  it('caps high-cardinality emissions across key eviction and observes async failures', async () => {
    let now = 0;
    const emit = vi.fn(async () => { throw new Error('logger unavailable'); });
    const keyed = createBoundedKeyedEmitter<string>({
      emit, now: () => now, intervalMs: 100, cacheMax: 2,
      maxEmitsPerWindow: 3,
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let key = 0; key < 5; key++) keyed(`op-${key}`, () => `event-${key}`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(emit).toHaveBeenCalledTimes(3);
    now = 101;
    keyed('op-4', () => 'next window');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(emit).toHaveBeenCalledTimes(4);
  });
});
