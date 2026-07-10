import { describe, it, expect, vi } from 'vitest';
import {
  resolveUpdateJitterMs,
  pickUpdateHoldoffMs,
  awaitUpdateHoldoff,
  createUpdateHoldoffGate,
  UPDATE_JITTER_ENV,
  type UpdateHoldoffGateConfig,
  type UpdateHoldoffStep,
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

describe('createUpdateHoldoffGate (the shared rollout gate)', () => {
  // Typed harness — the deps keep the real UpdateHoldoffGateConfig / Step types
  // so drift between the gate contract and the fixtures is a compile error.
  function harness(opts: {
    jitterMs?: number;
    isShuttingDown?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
    revalidate?: () => Promise<string | null>;
    apply?: (t: string) => Promise<void>;
  } = {}) {
    const calls: string[] = [];
    const log = vi.fn((m: string) => { calls.push(`log:${m}`); });
    const setUpdating = vi.fn((v: boolean) => { calls.push(`setUpdating:${v}`); });
    const sleep = vi.fn(opts.sleep ?? (async () => { calls.push('sleep'); }));
    const revalidate = vi.fn(opts.revalidate ?? (async () => { calls.push('revalidate'); return 'v-fresh' as string | null; }));
    const apply = vi.fn(opts.apply ?? (async (t: string) => { calls.push(`apply:${t}`); }));
    const config: UpdateHoldoffGateConfig = {
      jitterMs: opts.jitterMs ?? 600_000,
      isShuttingDown: opts.isShuttingDown ?? (() => false),
      setUpdating,
      log,
      rng: () => 0.5,
      sleep,
    };
    const step: UpdateHoldoffStep<string> = {
      onHold: () => calls.push('onHold'),
      revalidate,
      apply,
      shutdownMessage: 'SHUTDOWN',
      supersededMessage: 'SUPERSEDED',
    };
    return { gate: createUpdateHoldoffGate(config), step, calls, log, setUpdating, sleep, revalidate, apply };
  }

  it('runs the gate in order and applies the REVALIDATED target (not the detected one)', async () => {
    const { gate, step, calls, apply } = harness();
    await gate.run(step);
    expect(calls).toEqual([
      'onHold', 'sleep', 'revalidate', 'setUpdating:true', 'apply:v-fresh', 'setUpdating:false',
    ]);
    expect(apply).toHaveBeenCalledWith('v-fresh');
  });

  it('holds single-flight WHILE a hold-off is in flight — a second tick during the wait is a no-op', async () => {
    // A hold-off that outlasts the poll interval must still block a second tick.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const revalidate = vi.fn(async () => 'v-fresh' as string | null);
    const apply = vi.fn(async () => {});
    const { gate, step } = harness({ sleep: () => held, revalidate, apply });

    const first = gate.run(step); // enters, sets pending, awaits the un-resolved hold-off
    await Promise.resolve();
    // Second concurrent tick while the first rollout is mid-hold-off:
    await gate.run(step);
    expect(revalidate, 'second tick must not start a second rollout').not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();

    release(); // let the first hold-off complete
    await first;
    expect(revalidate).toHaveBeenCalledTimes(1); // exactly ONE rollout ran
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does NOT apply a target withdrawn during the hold-off (revalidate -> null)', async () => {
    const { gate, step, apply, setUpdating, log } = harness({ revalidate: async () => null });
    await gate.run(step);
    expect(apply).not.toHaveBeenCalled();
    expect(setUpdating).not.toHaveBeenCalledWith(true);
    expect(log).toHaveBeenCalledWith('SUPERSEDED');
  });

  it('aborts before revalidate/apply when shutting down during the hold-off', async () => {
    let sd = false;
    const { gate, step, revalidate, apply, log } = harness({
      isShuttingDown: () => sd,
      sleep: async () => { sd = true; },
    });
    await gate.run(step);
    expect(revalidate).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('SHUTDOWN');
  });

  it('aborts AFTER revalidation if shutdown began during the (async) revalidate call', async () => {
    // The hold-off completes with shutdown=false, so revalidate runs; shutdown
    // then flips DURING revalidate. The gate must re-check and NOT apply.
    let sd = false;
    const { gate, step, apply, setUpdating, log } = harness({
      isShuttingDown: () => sd,
      revalidate: async () => { sd = true; return 'v-fresh'; },
    });
    await gate.run(step);
    expect(apply).not.toHaveBeenCalled();
    expect(setUpdating).not.toHaveBeenCalledWith(true);
    expect(log).toHaveBeenCalledWith('SHUTDOWN');
  });

  it('clears isUpdating (and recovers single-flight) even if apply throws', async () => {
    const { gate, step, setUpdating } = harness({ apply: async () => { throw new Error('boom'); } });
    await expect(gate.run(step)).rejects.toThrow('boom');
    expect(setUpdating).toHaveBeenLastCalledWith(false);
    // pending was cleared in finally, so the gate is usable again:
    const ok = vi.fn(async () => {});
    await gate.run({ ...step, apply: ok });
    expect(ok).toHaveBeenCalledOnce();
  });

  it('applies with no hold-off log/sleep when jitter is disabled', async () => {
    const { gate, step, calls } = harness({ jitterMs: 0 });
    await gate.run(step);
    expect(calls).toEqual(['revalidate', 'setUpdating:true', 'apply:v-fresh', 'setUpdating:false']);
  });
});
