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
});
