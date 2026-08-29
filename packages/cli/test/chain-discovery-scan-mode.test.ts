import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CONSECUTIVE_SAME_SCAN_RETRIES,
  OVERDUE_FULL_RESYNC_RETRY_EVERY,
  chainDiscoveryScanOptions,
  createChainDiscoveryScanRunner,
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
  // GH#2323 — these three tests DELIBERATELY flip the behaviour their
  // predecessors pinned. The old runner consumed the run slot before any
  // await (`const run = runs++`), so a rejected run-0 `seedFull` silently
  // downgraded the startup recovery to `incremental` until run 48 — roughly
  // 24h at the 30-minute cadence. The slot is now committed only when the
  // scan resolves: a rejected scan retries the SAME run next tick.
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

  // Review RED on the first version of this fix: "same run" is not "same
  // scan". The mode derives from the run number AND the mutable watermark,
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

  // Review round 2 RED — the pin must be BOUNDED. Unbounded same-scan retry
  // trades one liveness bug for another: a deterministically failing
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

  // Review round 2 — state commits must be atomic with respect to logging: a
  // throwing success-log used to advance `runs` AND re-pin the completed
  // scan's options, so the next tick executed a stale scan under a new run
  // number, and a throwing failure-log was misclassified as a probe failure.
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

  // Review round 2 RED — the extraction must not break the pre-existing
  // import path: daemon/index.ts re-exports lifecycle wholesale, and this
  // test file itself imported from lifecycle.js before the move.
  it('the relocated scan APIs remain importable from lifecycle.js', () => {
    expect(reExportedOptions).toBe(chainDiscoveryScanOptions);
    expect(reExportedRunner).toBe(createChainDiscoveryScanRunner);
  });
});
