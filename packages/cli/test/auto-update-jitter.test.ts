import { describe, it, expect, vi } from 'vitest';
import {
  resolveUpdateJitterMs,
  pickUpdateHoldoffMs,
  awaitUpdateHoldoff,
  runWithUpdateHoldoff,
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

describe('runWithUpdateHoldoff (the shared rollout gate)', () => {
  function makeDeps(overrides: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const log = vi.fn();
    const setUpdating = vi.fn((v: boolean) => { calls.push(`setUpdating:${v}`); });
    const sleep = vi.fn(async () => { calls.push('sleep'); });
    const onHold = vi.fn(() => { calls.push('onHold'); });
    const revalidate = vi.fn(async () => { calls.push('revalidate'); return 'v-fresh' as string | null; });
    const apply = vi.fn(async (t: string) => { calls.push(`apply:${t}`); });
    const deps = {
      pending: { active: false },
      jitterMs: 600_000,
      isShuttingDown: () => false,
      setUpdating,
      log,
      onHold,
      revalidate,
      apply,
      shutdownMessage: 'SHUTDOWN',
      supersededMessage: 'SUPERSEDED',
      rng: () => 0.5,
      sleep,
      ...overrides,
    };
    return { deps, calls, log, setUpdating, sleep, onHold, revalidate, apply };
  }

  it('runs the gate in order and applies the REVALIDATED target (not the detected one)', async () => {
    const { deps, calls, apply } = makeDeps();
    await runWithUpdateHoldoff(deps as never);
    expect(calls).toEqual([
      'onHold', 'sleep', 'revalidate', 'setUpdating:true', 'apply:v-fresh', 'setUpdating:false',
    ]);
    expect(apply).toHaveBeenCalledWith('v-fresh');
    expect(deps.pending.active).toBe(false);
  });

  it('is single-flight: a call while a rollout is pending does nothing and leaves the flag set', async () => {
    const { deps, revalidate, apply } = makeDeps({ pending: { active: true } });
    await runWithUpdateHoldoff(deps as never);
    expect(revalidate).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(deps.pending.active).toBe(true); // the in-flight rollout still owns it
  });

  it('does NOT apply a target withdrawn during the hold-off (revalidate -> null)', async () => {
    const apply = vi.fn(async () => {});
    const setUpdating = vi.fn();
    const log = vi.fn();
    const { deps } = makeDeps({
      revalidate: vi.fn(async () => null),
      apply, setUpdating, log,
    });
    await runWithUpdateHoldoff(deps as never);
    expect(apply).not.toHaveBeenCalled();
    expect(setUpdating).not.toHaveBeenCalledWith(true);
    expect(log).toHaveBeenCalledWith('SUPERSEDED');
    expect(deps.pending.active).toBe(false);
  });

  it('aborts before revalidate/apply when shutting down during the hold-off', async () => {
    let sd = false;
    const revalidate = vi.fn(async () => 'x');
    const apply = vi.fn(async () => {});
    const log = vi.fn();
    const { deps } = makeDeps({
      isShuttingDown: () => sd,
      sleep: vi.fn(async () => { sd = true; }),
      revalidate, apply, log,
    });
    await runWithUpdateHoldoff(deps as never);
    expect(revalidate).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('SHUTDOWN');
    expect(deps.pending.active).toBe(false);
  });

  it('clears isUpdating and the pending flag even if apply throws', async () => {
    const setUpdating = vi.fn();
    const { deps } = makeDeps({
      apply: vi.fn(async () => { throw new Error('boom'); }),
      setUpdating,
    });
    await expect(runWithUpdateHoldoff(deps as never)).rejects.toThrow('boom');
    expect(setUpdating).toHaveBeenLastCalledWith(false);
    expect(deps.pending.active).toBe(false);
  });

  it('applies with no hold-off log/sleep when jitter is disabled', async () => {
    const { deps, calls } = makeDeps({ jitterMs: 0 });
    await runWithUpdateHoldoff(deps as never);
    expect(calls).toEqual(['revalidate', 'setUpdating:true', 'apply:v-fresh', 'setUpdating:false']);
  });
});
