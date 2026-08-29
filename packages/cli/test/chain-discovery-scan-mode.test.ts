import { describe, expect, it, vi } from 'vitest';
import {
  INITIAL_SCAN_SCHEDULER_STATE,
  MAX_CONSECUTIVE_SAME_SCAN_RETRIES,
  OVERDUE_FULL_RESYNC_RETRY_EVERY,
  chainDiscoveryScanOptions,
  commitScanOutcome,
  createChainDiscoveryScanRunner,
  planScan,
} from '../src/daemon/chain-discovery-scan.js';
import {
  chainDiscoveryScanOptions as reExportedOptions,
  createChainDiscoveryScanRunner as reExportedRunner,
} from '../src/daemon/lifecycle.js';

describe('chainDiscoveryScanOptions', () => {
  it('uses bounded cursor-resumable watermark seeding before a seed exists', () => {
    expect(chainDiscoveryScanOptions({ watermarkSeeded: false })).toEqual({
      mode: 'seedFromCursor',
      throwOnChainScanFailure: true,
      pageBudget: 30,
    });
  });

  it('uses a startup recovery scan even when the registry watermark already exists', () => {
    expect(chainDiscoveryScanOptions({ watermarkSeeded: true })).toEqual({
      mode: 'seedFull',
      throwOnChainScanFailure: true,
    });
  });

  it('keeps steady-state daemon scans incremental after startup recovery', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      run: 1,
      fullScanEvery: 48,
    })).toEqual({ mode: 'incremental', pageBudget: 30 });
  });

  it('keeps a periodic full-history recovery path after the watermark is seeded', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      run: 48,
      fullScanEvery: 48,
    })).toEqual({
      mode: 'seedFull',
      throwOnChainScanFailure: true,
    });
  });

  it('does not force a full scan before the configured recovery cadence', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      run: 47,
      fullScanEvery: 48,
    })).toEqual({ mode: 'incremental', pageBudget: 30 });
  });

  it('ignores fractional full-scan cadence overrides below one', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      run: 1,
      fullScanEvery: 0.5,
    })).toEqual({ mode: 'incremental', pageBudget: 30 });
  });

  it('honors a valid custom page budget', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      run: 1,
      pageBudget: 7.9,
    })).toEqual({ mode: 'incremental', pageBudget: 7 });
  });

  it('serializes overlapping scheduled chain scans and resets after settle', async () => {
    let resolveFirstScan: ((value: number) => void) | undefined;
    const firstScan = new Promise<number>((resolve) => {
      resolveFirstScan = resolve;
    });
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi.fn(async () => firstScan),
    };
    const runner = createChainDiscoveryScanRunner({
      agent,
      log: vi.fn(),
    });

    const first = runner();
    const overlapping = runner();
    await Promise.resolve();

    expect(agent.hasContextGraphRegistryScanWatermark).toHaveBeenCalledTimes(1);
    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(1);
    await overlapping;

    resolveFirstScan?.(0);
    await first;

    agent.discoverContextGraphsFromChain.mockResolvedValue(0);
    await runner();

    expect(agent.hasContextGraphRegistryScanWatermark).toHaveBeenCalledTimes(2);
    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(2);
  });

  // GH#1486 — a chain scan is non-critical: a rejected
  // `discoverContextGraphsFromChain` must be swallowed and must clear the
  // `inFlight` guard via the `finally`, or the first transient RPC failure
  // would permanently disable every later scheduled scan.
  // GH#2323 — the slot is committed only when a scan settles it: a rejected
  // scan retries the SAME run next tick instead of silently downgrading the
  // startup recovery to `incremental` until run 48 (~24h at the cadence).
  it('retries a rejected startup-recovery seedFull on the next tick instead of degrading to incremental', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockRejectedValueOnce(new Error('chain RPC unavailable'))
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(0),
    };
    const log = vi.fn();
    const runner = createChainDiscoveryScanRunner({ agent, log });

    // Tick 1: run-0 seedFull rejects. Not silent any more — the operator can
    // see the recovery scan failed and that it will be retried.
    await expect(runner()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Chain scan run 0 (seedFull) failed'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('chain RPC unavailable'));

    // Tick 2: the SAME run retries — still seedFull, the missed history walk
    // actually happens. Tick 3: only now does the counter advance.
    await runner();
    await runner();

    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(1, {
      mode: 'seedFull',
      throwOnChainScanFailure: true,
    });
    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(2, {
      mode: 'seedFull',
      throwOnChainScanFailure: true,
    });
    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(3, {
      mode: 'incremental',
      pageBudget: 30,
    });
    expect(log).toHaveBeenCalledWith('Chain scan: discovered 3 new context graph(s)');
  });

  // A rejection from the watermark probe happens before
  // `discoverContextGraphsFromChain` is reached, so it takes a different path
  // out of the `try` — it must clear `inFlight` just the same, and (GH#2323)
  // it must not consume the slot either.
  it('a rejected watermark probe does not consume run 0 — the next tick still issues the startup seedFull', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi
        .fn<() => Promise<boolean>>()
        .mockRejectedValueOnce(new Error('watermark read failed'))
        .mockResolvedValueOnce(true),
      discoverContextGraphsFromChain:
        vi.fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>(
          async () => 0,
        ),
    };
    const log = vi.fn();
    const runner = createChainDiscoveryScanRunner({ agent, log });

    await expect(runner()).resolves.toBeUndefined();
    expect(agent.discoverContextGraphsFromChain).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('watermark probe failed'));

    await runner();

    expect(agent.hasContextGraphRegistryScanWatermark).toHaveBeenCalledTimes(2);
    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(1);

    // Run 0 survived the probe failure, so the scan that reaches the agent is
    // the seedFull startup recovery a fresh boot owes — not incremental.
    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(1, {
      mode: 'seedFull',
      throwOnChainScanFailure: true,
    });
  });

  // "Same run" is not "same scan". The mode derives from the run number AND the mutable watermark,
  // and a partially-successful scan MOVES the watermark — so recomputing the
  // options on retry can silently change what retries. The failed attempt's
  // options are captured and reused instead.
  it('a partially seeded seedFromCursor retries as seedFromCursor, not an unbounded seedFull', async () => {
    const agent = {
      // Fresh node: no watermark on the first probe. The scan then seeds
      // blocks 0..1999, SAVES the watermark, and fails on 2000..3999 —
      // so every later probe reports seeded.
      hasContextGraphRegistryScanWatermark: vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockRejectedValueOnce(new Error('rpc failed mid-seed'))
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(0),
    };
    const runner = createChainDiscoveryScanRunner({ agent, log: vi.fn() });

    await runner(); // run 0: seedFromCursor, partial progress, REJECTED
    await runner(); // run 0 retried — MUST resume the cursor scan, not restart history
    await runner(); // run 1: watermark seeded => incremental

    const calls = agent.discoverContextGraphsFromChain.mock.calls.map((c) => c[0]!);
    expect(calls[0]).toEqual({ mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget: 30 });
    // Recomputed from the moved watermark this would be seedFull (run 0 +
    // seeded = startup recovery): unbounded, from block zero, no page budget.
    expect(calls[1]).toEqual({ mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget: 30 });
    expect(calls[2]).toEqual({ mode: 'incremental', pageBudget: 30 });
    // The successful retry released the pin: nothing later reuses stale options.
    expect(agent.hasContextGraphRegistryScanWatermark).toHaveBeenCalledTimes(2);
  });

  it('a failed periodic full resync retries in one tick, not one day', async () => {
    // fullScanEvery=2 reaches the periodic seedFull quickly: run 0 seedFull,
    // run 1 incremental, run 2 seedFull (2 % 2 === 0).
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockRejectedValueOnce(new Error('rpc flake'))
        .mockResolvedValueOnce(0),
    };
    const runner = createChainDiscoveryScanRunner({ agent, log: vi.fn(), fullScanEvery: 2 });

    await runner(); // run 0 seedFull, ok
    await runner(); // run 1 incremental, ok
    await runner(); // run 2 seedFull, REJECTED — slot must survive
    await runner(); // run 2 again, seedFull, ok

    const modes = agent.discoverContextGraphsFromChain.mock.calls.map((c) => c[0]!.mode);
    expect(modes).toEqual(['seedFull', 'incremental', 'seedFull', 'seedFull']);
  });

  // The pin must be BOUNDED. Unbounded same-scan retry trades one liveness bug for another: a deterministically failing
  // historical page would block incremental discovery of new blocks forever.
  it('a permanently failing seedFull releases its slot and incremental discovery continues', async () => {
    const modes: string[] = [];
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi.fn(
        async (options: ReturnType<typeof chainDiscoveryScanOptions>) => {
          modes.push(options.mode);
          if (options.mode === 'seedFull') throw new Error('historical page 404s deterministically');
          return 0;
        },
      ),
    };
    const log = vi.fn();
    const runner = createChainDiscoveryScanRunner({ agent, log });

    // Initial attempt + MAX consecutive retries, all seedFull, all failing.
    for (let i = 0; i <= MAX_CONSECUTIVE_SAME_SCAN_RETRIES; i++) await runner();
    expect(modes).toEqual(Array(MAX_CONSECUTIVE_SAME_SCAN_RETRIES + 1).fill('seedFull'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('releasing the slot so discovery continues'));

    // Liveness: the very next tick is a normal incremental scan.
    await runner();
    expect(modes.at(-1)).toBe('incremental');

    // The resync is scheduled, not forgotten: after
    // OVERDUE_FULL_RESYNC_RETRY_EVERY incremental-cadence ticks, a fresh
    // seedFull attempt is injected in place of one of them.
    for (let i = 1; i < OVERDUE_FULL_RESYNC_RETRY_EVERY; i++) await runner();
    expect(modes.at(-1)).toBe('seedFull');
    expect(modes.filter((m) => m === 'incremental').length).toBe(OVERDUE_FULL_RESYNC_RETRY_EVERY - 1);
  });

  it('an overdue full resync clears once an injected attempt succeeds', async () => {
    let seedFullFails = true;
    const modes: string[] = [];
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi.fn(
        async (options: ReturnType<typeof chainDiscoveryScanOptions>) => {
          modes.push(options.mode);
          if (options.mode === 'seedFull' && seedFullFails) throw new Error('flaky RPC');
          return 0;
        },
      ),
    };
    const runner = createChainDiscoveryScanRunner({ agent, log: vi.fn() });

    for (let i = 0; i <= MAX_CONSECUTIVE_SAME_SCAN_RETRIES; i++) await runner(); // exhaust
    seedFullFails = false;
    for (let i = 0; i < OVERDUE_FULL_RESYNC_RETRY_EVERY; i++) await runner();    // ...injected attempt succeeds
    expect(modes.at(-1)).toBe('seedFull');
    const afterRecovery = modes.length;

    // Overdue cleared: a long quiet stretch stays purely incremental.
    for (let i = 0; i < 2 * OVERDUE_FULL_RESYNC_RETRY_EVERY; i++) await runner();
    expect(modes.slice(afterRecovery).every((m) => m === 'incremental')).toBe(true);
  });

  // State commits are atomic with respect to logging: a throwing success-log
  // must not advance `runs` while re-pinning a completed scan, and a throwing
  // failure-log must not be misclassified as a probe failure.
  it('a throwing log sink cannot corrupt the scheduling state', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockResolvedValueOnce(1)   // run 0 seedFull SUCCEEDS, but the log throws
        .mockResolvedValueOnce(0),
    };
    const log = vi.fn(() => { throw new Error('log sink broken'); });
    const runner = createChainDiscoveryScanRunner({ agent, log });

    await expect(runner()).resolves.toBeUndefined();
    await runner();

    // Run 0 completed and committed; run 1 must be a FRESH incremental scan,
    // not the pinned replay of the already-successful seedFull.
    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(1, {
      mode: 'seedFull',
      throwOnChainScanFailure: true,
    });
    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(2, {
      mode: 'incremental',
      pageBudget: 30,
    });
  });

  // The extraction must not break the pre-existing import path: daemon/index.ts re-exports lifecycle wholesale, and this
  // test file itself imported from lifecycle.js before the move.
  it('the relocated scan APIs remain importable from lifecycle.js', () => {
    expect(reExportedOptions).toBe(chainDiscoveryScanOptions);
    expect(reExportedRunner).toBe(createChainDiscoveryScanRunner);
  });

  // A promise may legally reject with `undefined`; a sentinel comparison
  // would commit that as SUCCESS, consuming the slot (and
  // able to clear an overdue resync no scan earned).
  it('a rejection carrying undefined is a failure, not a success', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockRejectedValueOnce(undefined)
        .mockResolvedValueOnce(0),
    };
    const log = vi.fn();
    const runner = createChainDiscoveryScanRunner({ agent, log });

    await runner();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Chain scan run 0 (seedFull) failed'));
    await runner();

    // The slot was NOT consumed: the same seedFull retries.
    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(2, {
      mode: 'seedFull',
      throwOnChainScanFailure: true,
    });
  });

  // The throwing-log-sink guarantee must hold on the FAILURE branch too: a failed scan whose failure line throws must neither
  // reject the timer callback nor lose its captured retry.
  it('a throwing log sink on the failure branch keeps the retry pinned and the runner resolved', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockRejectedValueOnce(new Error('rpc down'))
        .mockResolvedValueOnce(0),
    };
    const log = vi.fn(() => { throw new Error('log sink broken'); });
    const runner = createChainDiscoveryScanRunner({ agent, log });

    await expect(runner()).resolves.toBeUndefined();
    await runner();

    // The captured seedFull retried; the broken sink changed nothing.
    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(2, {
      mode: 'seedFull',
      throwOnChainScanFailure: true,
    });
  });

  // The overdue cadence is a TICK contract, and it must
  // hold even while incremental scans are themselves failing and retrying:
  // a failing incremental's retry cycle cannot postpone the owed resync.
  it('a DUE overdue resync fires even when the watermark probe is failing', async () => {
    // The probe is irrelevant to a due resync, so a probe outage must not
    // be able to skip it.
    const modes: string[] = [];
    let probeHealthy = true;
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => {
        if (!probeHealthy) throw new Error('registry store unavailable');
        return true;
      }),
      discoverContextGraphsFromChain: vi.fn(
        async (options: ReturnType<typeof chainDiscoveryScanOptions>) => {
          modes.push(options.mode);
          if (options.mode === 'seedFull') throw new Error('flaky RPC');
          return 0;
        },
      ),
    };
    const runner = createChainDiscoveryScanRunner({ agent, log: vi.fn() });

    for (let i = 0; i <= MAX_CONSECUTIVE_SAME_SCAN_RETRIES; i++) await runner(); // exhaust seedFull
    // Age the debt to one tick short of due with healthy probes, then break
    // the probe for the due tick.
    for (let i = 1; i < OVERDUE_FULL_RESYNC_RETRY_EVERY; i++) await runner();
    probeHealthy = false;
    await runner();
    expect(modes.at(-1)).toBe('seedFull');
  });

  it('an overdue resync fires on schedule even while incremental scans fail', async () => {
    const modes: string[] = [];
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi.fn(
        async (options: ReturnType<typeof chainDiscoveryScanOptions>) => {
          modes.push(options.mode);
          throw new Error('everything fails');
        },
      ),
    };
    const runner = createChainDiscoveryScanRunner({ agent, log: vi.fn() });

    // Exhaust the startup seedFull: initial attempt + MAX retries.
    for (let i = 0; i <= MAX_CONSECUTIVE_SAME_SCAN_RETRIES; i++) await runner();
    const afterExhaustion = modes.length;

    // Incrementals now fail too (getting pinned and retried). Exactly
    // OVERDUE_FULL_RESYNC_RETRY_EVERY runner ticks later, the owed seedFull
    // must fire — replacing the pinned incremental retry, which the full
    // re-walk subsumes anyway.
    for (let i = 0; i < OVERDUE_FULL_RESYNC_RETRY_EVERY; i++) await runner();
    const window = modes.slice(afterExhaustion);
    expect(window.slice(0, -1).every((m) => m === 'incremental')).toBe(true);
    expect(window.at(-1)).toBe('seedFull');
  });
});

// The policy is two pure functions over a discriminated state; pin the
// transition table directly, not only through tick sequences.
  // A rejection VALUE is arbitrary: `Object.create(null)` has no toString
  // and a poisoned toString throws during formatting. The lifecycle hands
  // this runner to a timer with no rejection handler, so a throw escaping
  // here is an unhandled rejection — potentially fatal to the daemon.
  it('rejection values that cannot be formatted neither crash the runner nor lose the retry', async () => {
    for (const poison of [
      Object.create(null),
      { toString() { throw new Error('bad coercion'); } },
    ]) {
      const agent = {
        hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
        discoverContextGraphsFromChain: vi
          .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
          .mockRejectedValueOnce(poison)
          .mockResolvedValueOnce(0),
      };
      const log = vi.fn();
      const runner = createChainDiscoveryScanRunner({ agent, log });

      await expect(runner()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Chain scan run 0 (seedFull) failed'));
      await runner();
      expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(2, {
        mode: 'seedFull',
        throwOnChainScanFailure: true,
      });
    }
  });

  it('a probe rejecting with an unformattable value still resolves and logs the skip', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi
        .fn<() => Promise<boolean>>()
        .mockRejectedValueOnce(Object.create(null)),
      discoverContextGraphsFromChain: vi.fn(async () => 0),
    };
    const log = vi.fn();
    const runner = createChainDiscoveryScanRunner({ agent, log });
    await expect(runner()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('watermark probe failed'));
    expect(agent.discoverContextGraphsFromChain).not.toHaveBeenCalled();
  });

describe('scan scheduler transitions (GH#2323)', () => {
  const seedFull = { mode: 'seedFull', throwOnChainScanFailure: true } as const;
  const incremental = { mode: 'incremental', pageBudget: 30 } as const;

  /** Resolve a plan, providing the watermark only when planning asks. */
  const plan = (state: Parameters<typeof planScan>[0], watermarkSeeded = true) => {
    const step = planScan(state);
    return step.kind === 'ready' ? step.plan : step.complete(watermarkSeeded);
  };

  it('failure pins the executed scan; success releases the pin and advances the run', () => {
    const first = plan(INITIAL_SCAN_SCHEDULER_STATE);
    expect(first.scan).toEqual(seedFull);

    const failed = commitScanOutcome(first, { ok: false, error: new Error('x') });
    expect(failed.state).toEqual({ run: 0, pinned: { options: seedFull, failures: 1 } });
    expect(failed.report.kind).toBe('retryScheduled');

    // A pinned retry is executable WITHOUT the watermark probe.
    const step = planScan(failed.state);
    expect(step.kind).toBe('ready');
    if (step.kind !== 'ready') return;
    expect(step.plan.scan).toBe(failed.state.pinned!.options);
    expect(step.plan.priorFailures).toBe(1);

    const succeeded = commitScanOutcome(step.plan, { ok: true, found: 0 });
    expect(succeeded.state).toEqual({ run: 1 });
    expect(succeeded.report.kind).toBe('quiet');
  });

  it('structurally copying a plan cannot reset its retry history', () => {
    // Commit must not depend on object identity with the scheduler's pin —
    // the history travels IN the plan.
    const failed = commitScanOutcome(plan(INITIAL_SCAN_SCHEDULER_STATE), { ok: false, error: 'e' });
    const step = planScan(failed.state);
    if (step.kind !== 'ready') throw new Error('pinned retry must be ready');
    const copied = { ...step.plan, scan: { ...step.plan.scan } };
    const refailed = commitScanOutcome(copied, { ok: false, error: 'e' });
    expect(refailed.state.pinned!.failures).toBe(2);
  });

  it('a DUE overdue resync plans ready — no watermark prerequisite', () => {
    const step = planScan({
      run: 5,
      overdueResync: { ticksSinceAttempt: OVERDUE_FULL_RESYNC_RETRY_EVERY - 1 },
    });
    expect(step.kind).toBe('ready');
    if (step.kind !== 'ready') return;
    expect(step.plan.scan).toEqual(seedFull);
    expect(step.plan.state.overdueResync).toEqual({ ticksSinceAttempt: 0 });
  });

  it('exhaustion of a seedFull releases the slot AND records the overdue resync', () => {
    let state = INITIAL_SCAN_SCHEDULER_STATE;
    for (let i = 0; i <= MAX_CONSECUTIVE_SAME_SCAN_RETRIES; i++) {
      state = commitScanOutcome(plan(state), { ok: false, error: 'e' }).state;
    }
    expect(state).toEqual({ run: 1, overdueResync: { ticksSinceAttempt: 0 } });
  });

  it('a non-seedFull success and a non-seedFull release both PRESERVE the overdue debt', () => {
    const owing = { run: 3, overdueResync: { ticksSinceAttempt: 1 } };
    const success = commitScanOutcome(
      { scan: incremental, priorFailures: 0, state: owing },
      { ok: true, found: 0 },
    );
    expect(success.state.overdueResync).toEqual({ ticksSinceAttempt: 1 });
    const exhausted = commitScanOutcome(
      { scan: incremental, priorFailures: MAX_CONSECUTIVE_SAME_SCAN_RETRIES, state: owing },
      { ok: false, error: 'e' },
    );
    expect(exhausted.report.kind).toBe('slotReleased');
    expect(exhausted.state.overdueResync).toEqual({ ticksSinceAttempt: 1 });
  });

  it('only a completed seedFull settles the overdue debt', () => {
    const owing = { run: 3, overdueResync: { ticksSinceAttempt: 2 } };
    const settled = commitScanOutcome(
      { scan: seedFull, priorFailures: 0, state: owing },
      { ok: true, found: 0 },
    );
    expect(settled.state.overdueResync).toBeUndefined();
  });

  it('the owed resync never preempts a pinned seeding scan', () => {
    const seeding = { mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget: 30 } as const;
    const state = {
      run: 0,
      pinned: { options: seeding, failures: 1 },
      overdueResync: { ticksSinceAttempt: OVERDUE_FULL_RESYNC_RETRY_EVERY },
    };
    const step = planScan(state);
    expect(step.kind).toBe('ready');
    if (step.kind !== 'ready') return;
    // The bootstrap retry is the more specific recovery already in progress.
    expect(step.plan.scan).toBe(state.pinned.options);
    // The debt keeps aging rather than resetting from an attempt that never ran.
    expect(step.plan.state.overdueResync!.ticksSinceAttempt).toBeGreaterThan(OVERDUE_FULL_RESYNC_RETRY_EVERY);
  });
});
