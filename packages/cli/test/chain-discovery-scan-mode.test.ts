import { describe, expect, it, vi } from 'vitest';
import { chainDiscoveryScanOptions, createChainDiscoveryScanRunner } from '../src/daemon/lifecycle.js';

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
  it('swallows a rejected scan and still runs the next scheduled invocation', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockRejectedValueOnce(new Error('chain RPC unavailable'))
        .mockResolvedValueOnce(3),
    };
    const log = vi.fn();
    const runner = createChainDiscoveryScanRunner({ agent, log });

    await expect(runner()).resolves.toBeUndefined();
    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Chain scan: seedFull scan failed: chain RPC unavailable');

    await runner();

    expect(agent.hasContextGraphRegistryScanWatermark).toHaveBeenCalledTimes(2);
    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('Chain scan: discovered 3 new context graph(s)');

    // Pin WHICH scan each call was, not just that two happened — asserting
    // counts alone passes identically whether the retry recovers the missed
    // work or silently degrades (PR #2132 review).
    //
    // A rejected scan does not consume run 0. The next scheduled invocation
    // retries the startup-recovery seedFull instead of silently downgrading to
    // incremental until the next full-scan cadence roughly 24 hours later.
    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(1, {
      mode: 'seedFull',
      throwOnChainScanFailure: true,
    });
    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(2, {
      mode: 'seedFull',
      throwOnChainScanFailure: true,
    });
  });

  // A rejection from the watermark probe happens before
  // `discoverContextGraphsFromChain` is reached, so it takes a different path
  // out of the `try` — it must clear `inFlight` just the same.
  it('swallows a rejected watermark probe and still runs the next scheduled invocation', async () => {
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
    expect(log).toHaveBeenCalledWith('Chain scan: watermark probe failed: watermark read failed');

    await runner();

    expect(agent.hasContextGraphRegistryScanWatermark).toHaveBeenCalledTimes(2);
    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(1);

    // The probe rejection does not consume run 0, so the first scan that reaches
    // the agent still performs startup recovery.
    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(1, {
      mode: 'seedFull',
      throwOnChainScanFailure: true,
    });
  });

  it('resumes a partially persisted cursor seed without reclassifying it as seedFull', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockRejectedValueOnce(new Error('page 2 failed after page 1 persisted'))
        .mockResolvedValueOnce(0),
    };
    const runner = createChainDiscoveryScanRunner({ agent, log: vi.fn() });

    await runner();
    await runner();

    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(1, {
      mode: 'seedFromCursor',
      throwOnChainScanFailure: true,
      pageBudget: 30,
    });
    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(2, {
      mode: 'incremental',
      pageBudget: 30,
    });
  });

  it('does not misclassify a successful scan when its progress log throws', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(0),
    };
    const messages: string[] = [];
    const log = vi.fn((message: string) => {
      messages.push(message);
      if (message.includes('discovered')) throw new Error('log sink unavailable');
    });
    const runner = createChainDiscoveryScanRunner({ agent, log });

    await expect(runner()).resolves.toBeUndefined();
    await expect(runner()).resolves.toBeUndefined();

    expect(messages).toEqual(['Chain scan: discovered 3 new context graph(s)']);
    expect(agent.discoverContextGraphsFromChain).toHaveBeenNthCalledWith(2, {
      mode: 'incremental',
      pageBudget: 30,
    });
  });

  it('swallows a scan failure even when its failure logger throws', async () => {
    const agent = {
      hasContextGraphRegistryScanWatermark: vi.fn(async () => true),
      discoverContextGraphsFromChain: vi
        .fn<(options: ReturnType<typeof chainDiscoveryScanOptions>) => Promise<number>>()
        .mockRejectedValueOnce(new Error('chain RPC unavailable'))
        .mockResolvedValueOnce(0),
    };
    const runner = createChainDiscoveryScanRunner({
      agent,
      log: vi.fn(() => {
        throw new Error('log sink unavailable');
      }),
    });

    await expect(runner()).resolves.toBeUndefined();
    await expect(runner()).resolves.toBeUndefined();

    expect(agent.discoverContextGraphsFromChain).toHaveBeenCalledTimes(2);
  });
});
