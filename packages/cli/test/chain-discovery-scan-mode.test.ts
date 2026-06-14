import { describe, expect, it } from 'vitest';
import {
  chainDiscoveryScanOptions,
  shouldUseIncrementalChainDiscoveryScan,
} from '../src/daemon/lifecycle.js';

describe('shouldUseIncrementalChainDiscoveryScan', () => {
  it('starts with a full scan before any watermark seed exists', () => {
    expect(
      shouldUseIncrementalChainDiscoveryScan({
        run: 0,
        watermarkSeeded: false,
        fullScanEvery: 48,
      }),
    ).toBe(false);
  });

  it('keeps retrying full scans until a watermark seed succeeds', () => {
    expect(
      shouldUseIncrementalChainDiscoveryScan({
        run: 1,
        watermarkSeeded: false,
        fullScanEvery: 48,
      }),
    ).toBe(false);
  });

  it('uses incremental scans after a successful watermark seed', () => {
    expect(
      shouldUseIncrementalChainDiscoveryScan({
        run: 1,
        watermarkSeeded: true,
        fullScanEvery: 48,
      }),
    ).toBe(true);
  });

  it('keeps the scheduled full-resync cadence after a watermark seed', () => {
    expect(
      shouldUseIncrementalChainDiscoveryScan({
        run: 48,
        watermarkSeeded: true,
        fullScanEvery: 48,
      }),
    ).toBe(false);
  });
});

describe('chainDiscoveryScanOptions', () => {
  it('uses failure-throwing watermark seeding for full daemon scans', () => {
    expect(chainDiscoveryScanOptions(false)).toEqual({
      seedIncrementalWatermark: true,
      throwOnChainScanFailure: true,
    });
  });

  it('keeps steady-state daemon scans incremental-only', () => {
    expect(chainDiscoveryScanOptions(true)).toEqual({ incremental: true });
  });
});
