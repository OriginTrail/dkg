import { describe, expect, it } from 'vitest';
import { chainDiscoveryScanOptions } from '../src/daemon/lifecycle.js';

describe('chainDiscoveryScanOptions', () => {
  it('uses failure-throwing full-history watermark seeding before a seed exists', () => {
    expect(chainDiscoveryScanOptions({ watermarkSeeded: false })).toEqual({
      seedIncrementalWatermark: true,
      resumeFromCursor: true,
      throwOnChainScanFailure: true,
      pageBudget: 30,
    });
  });

  it('keeps steady-state daemon scans incremental-only', () => {
    expect(chainDiscoveryScanOptions({ watermarkSeeded: true })).toEqual({ incremental: true, pageBudget: 30 });
  });

  it('keeps the first daemon scan incremental when the watermark is already seeded', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      run: 0,
      fullScanEvery: 48,
    })).toEqual({ incremental: true, pageBudget: 30 });
  });

  it('keeps a periodic bounded recovery path after the watermark is seeded', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      run: 48,
      fullScanEvery: 48,
    })).toEqual({
      seedIncrementalWatermark: true,
      resumeFromCursor: true,
      throwOnChainScanFailure: true,
      pageBudget: 30,
    });
  });

  it('does not force a full scan before the configured recovery cadence', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      run: 47,
      fullScanEvery: 48,
    })).toEqual({ incremental: true, pageBudget: 30 });
  });

  it('ignores fractional full-scan cadence overrides below one', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      run: 1,
      fullScanEvery: 0.5,
    })).toEqual({ incremental: true, pageBudget: 30 });
  });

  it('honors a valid custom page budget', () => {
    expect(chainDiscoveryScanOptions({
      watermarkSeeded: true,
      pageBudget: 7.9,
    })).toEqual({ incremental: true, pageBudget: 7 });
  });
});
