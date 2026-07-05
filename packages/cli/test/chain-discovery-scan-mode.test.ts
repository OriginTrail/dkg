import { describe, expect, it } from 'vitest';
import { chainDiscoveryScanOptions } from '../src/daemon/lifecycle.js';

describe('chainDiscoveryScanOptions', () => {
  it('uses failure-throwing full-history watermark seeding before a seed exists', () => {
    expect(chainDiscoveryScanOptions({ watermarkSeeded: false })).toEqual({
      seedIncrementalWatermark: true,
      throwOnChainScanFailure: true,
    });
  });

  it('keeps steady-state daemon scans incremental-only', () => {
    expect(chainDiscoveryScanOptions({ watermarkSeeded: true })).toEqual({ incremental: true });
  });

  it('keeps the first daemon scan incremental when the watermark is already seeded', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      run: 0,
      fullScanEvery: 48,
    })).toEqual({ incremental: true });
  });

  it('keeps a periodic full-history recovery path after the watermark is seeded', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      run: 48,
      fullScanEvery: 48,
    })).toEqual({
      seedIncrementalWatermark: true,
      throwOnChainScanFailure: true,
    });
  });

  it('does not force a full scan before the configured recovery cadence', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      run: 47,
      fullScanEvery: 48,
    })).toEqual({ incremental: true });
  });
});
