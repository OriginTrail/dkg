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

  it('keeps steady-state daemon scans incremental-only', () => {
    expect(chainDiscoveryScanOptions({ watermarkSeeded: true })).toEqual({ mode: 'incremental', pageBudget: 30 });
  });

  it('keeps the first daemon scan incremental when the watermark is already seeded', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      run: 0,
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
});
