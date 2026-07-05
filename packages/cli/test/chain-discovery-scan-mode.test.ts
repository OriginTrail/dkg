import { describe, expect, it } from 'vitest';
import {
  chainDiscoveryScanOptions,
  shouldUseIncrementalChainDiscoveryScan,
} from '../src/daemon/lifecycle.js';

describe('shouldUseIncrementalChainDiscoveryScan', () => {
  it('uses historical watermark seeding before any watermark seed exists', () => {
    expect(
      shouldUseIncrementalChainDiscoveryScan({
        watermarkSeeded: false,
      }),
    ).toBe(false);
  });

  it('keeps historical seeding until a watermark seed succeeds', () => {
    expect(
      shouldUseIncrementalChainDiscoveryScan({
        watermarkSeeded: false,
      }),
    ).toBe(false);
  });

  it('uses incremental scans after a successful watermark seed', () => {
    expect(
      shouldUseIncrementalChainDiscoveryScan({
        watermarkSeeded: true,
      }),
    ).toBe(true);
  });

  it('does not schedule automatic full-resync scans after a watermark seed', () => {
    expect(
      shouldUseIncrementalChainDiscoveryScan({
        watermarkSeeded: true,
      }),
    ).toBe(true);
  });
});

describe('chainDiscoveryScanOptions', () => {
  it('uses failure-throwing full-history watermark seeding before incremental scans', () => {
    expect(chainDiscoveryScanOptions(false)).toEqual({
      seedIncrementalWatermark: true,
      throwOnChainScanFailure: true,
    });
  });

  it('keeps steady-state daemon scans incremental-only', () => {
    expect(chainDiscoveryScanOptions(true)).toEqual({ incremental: true });
  });
});
