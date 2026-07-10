import { describe, it, expect, vi } from 'vitest';
import {
  resolveUpdateJitterMs,
  pickUpdateHoldoffMs,
  awaitUpdateHoldoff,
  UPDATE_JITTER_ENV,
} from '../src/daemon/auto-update-jitter.js';

describe('resolveUpdateJitterMs', () => {
  it('uses the configured minutes when set', () => {
    expect(resolveUpdateJitterMs(10, 3, {})).toBe(10 * 60_000);
  });

  it('falls back to the poll interval when config is undefined (self-scaling)', () => {
    expect(resolveUpdateJitterMs(undefined, 30, {})).toBe(30 * 60_000);
  });

  it('env override wins over config and interval', () => {
    expect(resolveUpdateJitterMs(10, 3, { [UPDATE_JITTER_ENV]: '20' })).toBe(20 * 60_000);
  });

  it('0 disables via config or env', () => {
    expect(resolveUpdateJitterMs(0, 30, {})).toBe(0);
    expect(resolveUpdateJitterMs(10, 3, { [UPDATE_JITTER_ENV]: '0' })).toBe(0);
  });

  it('ignores an invalid / negative env value (falls back to config)', () => {
    expect(resolveUpdateJitterMs(5, 3, { [UPDATE_JITTER_ENV]: 'abc' })).toBe(5 * 60_000);
    expect(resolveUpdateJitterMs(5, 3, { [UPDATE_JITTER_ENV]: '-2' })).toBe(5 * 60_000);
  });

  it('clamps to a 12h maximum', () => {
    expect(resolveUpdateJitterMs(100_000, 3, {})).toBe(12 * 60 * 60_000);
  });

  it('treats a non-positive interval fallback as disabled', () => {
    expect(resolveUpdateJitterMs(undefined, 0, {})).toBe(0);
  });
});

describe('pickUpdateHoldoffMs', () => {
  it('returns 0 when jitter is disabled / non-positive', () => {
    expect(pickUpdateHoldoffMs(0)).toBe(0);
    expect(pickUpdateHoldoffMs(-1)).toBe(0);
  });

  it('returns a value in [0, jitterMs) for a valid rng', () => {
    expect(pickUpdateHoldoffMs(600_000, () => 0)).toBe(0);
    expect(pickUpdateHoldoffMs(600_000, () => 0.5)).toBe(300_000);
    expect(pickUpdateHoldoffMs(600_000, () => 0.999999)).toBeLessThan(600_000);
  });

  it('guards against a misbehaving rng (NaN / out-of-range)', () => {
    expect(pickUpdateHoldoffMs(600_000, () => Number.NaN)).toBe(0);
    expect(pickUpdateHoldoffMs(600_000, () => 1)).toBe(0);
    expect(pickUpdateHoldoffMs(600_000, () => -0.5)).toBe(0);
  });
});

describe('awaitUpdateHoldoff', () => {
  it('proceeds immediately without sleeping when jitter is disabled', async () => {
    const sleep = vi.fn(async () => {});
    const onHold = vi.fn();
    const decision = await awaitUpdateHoldoff({
      jitterMs: 0,
      isShuttingDown: () => false,
      onHold,
      sleep,
    });
    expect(decision).toBe('proceed');
    expect(sleep).not.toHaveBeenCalled();
    expect(onHold).not.toHaveBeenCalled();
  });

  it('sleeps the picked hold-off and reports the window via onHold, then proceeds', async () => {
    const sleep = vi.fn(async () => {});
    const onHold = vi.fn();
    const decision = await awaitUpdateHoldoff({
      jitterMs: 600_000,
      isShuttingDown: () => false,
      onHold,
      sleep,
      rng: () => 0.5,
    });
    expect(decision).toBe('proceed');
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(300_000);
    expect(onHold).toHaveBeenCalledWith(300_000);
  });

  it('aborts when the daemon began shutting down DURING the hold-off', async () => {
    let shuttingDown = false;
    // Flip the flag while the (fake) sleep is "in flight" — the shutdown bail
    // must be evaluated AFTER the wait, not before.
    const sleep = vi.fn(async () => {
      shuttingDown = true;
    });
    const decision = await awaitUpdateHoldoff({
      jitterMs: 600_000,
      isShuttingDown: () => shuttingDown,
      sleep,
      rng: () => 0.5,
    });
    expect(sleep).toHaveBeenCalledOnce();
    expect(decision).toBe('abort-shutdown');
  });

  it('aborts even with jitter disabled if already shutting down (never applies during shutdown)', async () => {
    const sleep = vi.fn(async () => {});
    const decision = await awaitUpdateHoldoff({
      jitterMs: 0,
      isShuttingDown: () => true,
      sleep,
    });
    expect(decision).toBe('abort-shutdown');
    expect(sleep).not.toHaveBeenCalled();
  });
});
