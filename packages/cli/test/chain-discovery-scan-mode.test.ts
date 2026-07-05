import { describe, expect, it } from 'vitest';
import {
  CHAIN_DISCOVERY_LIVE_TAIL_LOOKBACK_BLOCKS,
  chainDiscoveryScanOptions,
  shouldUseIncrementalChainDiscoveryScan,
} from '../src/daemon/lifecycle.js';

describe('shouldUseIncrementalChainDiscoveryScan', () => {
  it('uses bounded live-tail seeding before any watermark seed exists', () => {
    expect(
      shouldUseIncrementalChainDiscoveryScan({
        watermarkSeeded: false,
      }),
    ).toBe(false);
  });

  it('keeps bounded live-tail seeding until a watermark seed succeeds', () => {
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
  it('uses failure-throwing bounded live-tail watermark seeding before incremental scans', () => {
    expect(chainDiscoveryScanOptions(false)).toEqual({
      liveTailOnly: true,
      liveTailLookbackBlocks: CHAIN_DISCOVERY_LIVE_TAIL_LOOKBACK_BLOCKS,
      seedIncrementalWatermark: true,
      throwOnChainScanFailure: true,
    });
  });

  it('keeps steady-state daemon scans incremental-only', () => {
    expect(chainDiscoveryScanOptions(true)).toEqual({ incremental: true });
  });
});
