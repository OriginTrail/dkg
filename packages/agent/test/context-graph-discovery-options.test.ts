import { describe, expect, it } from 'vitest';
import {
  legacyChainListScanOptions,
  normalizeContextGraphDiscoveryScan,
  type DiscoverContextGraphsFromChainOptions,
} from '../src/context-graph-discovery-options.js';

describe('context graph discovery option compatibility boundary (#1485)', () => {
  it.each([
    [{}, { mode: 'listAll' }],
    [{ incremental: false, seedIncrementalWatermark: false }, { mode: 'listAll' }],
    [{ incremental: true, pageBudget: 3 }, { mode: 'incremental', pageBudget: 3 }],
    [{ seedIncrementalWatermark: true }, { mode: 'seedFull' }],
    [
      { seedIncrementalWatermark: true, resumeFromCursor: true, pageBudget: 2 },
      { mode: 'seedFromCursor', pageBudget: 2 },
    ],
    [{ mode: 'listAll' }, { mode: 'listAll' }],
    [{ mode: 'incremental', pageBudget: 4 }, { mode: 'incremental', pageBudget: 4 }],
    [{ mode: 'seedLiveTail', pageBudget: 4 }, { mode: 'seedLiveTail', pageBudget: 4 }],
    [{ mode: 'repair', pageBudget: 5, minimumIntervalMs: 100 }, { mode: 'repair', pageBudget: 5, minimumIntervalMs: 100 }],
  ])('normalizes %j to one canonical mode', (input, expected) => {
    const scan = normalizeContextGraphDiscoveryScan(
      input as DiscoverContextGraphsFromChainOptions,
    );
    expect(scan).toEqual(expected);
  });

  it.each([
    [{ mode: 'listAll', incremental: false }],
    [{ mode: 'seedFull', seedIncrementalWatermark: true }],
    [{ incremental: true, seedIncrementalWatermark: true }],
    [{ resumeFromCursor: true }],
    [{ incremental: true, resumeFromCursor: true }],
  ])('rejects ambiguous legacy and canonical shapes: %j', (input) => {
    expect(() => normalizeContextGraphDiscoveryScan(
      input as unknown as DiscoverContextGraphsFromChainOptions,
    )).toThrow();
  });

  it.each([
    [{ mode: 'incremental', pageBudget: 3 }, { incremental: true, pageBudget: 3 }],
    [{ mode: 'seedFull' }, { seedIncrementalWatermark: true }],
    [
      { mode: 'seedFromCursor', pageBudget: 2 },
      { seedIncrementalWatermark: true, resumeFromCursor: true, pageBudget: 2 },
    ],
    [{ mode: 'seedLiveTail', pageBudget: 2 }, undefined],
    [{ mode: 'listAll' }, undefined],
  ])('translates %j only for a legacy adapter', (scan, expected) => {
    expect(legacyChainListScanOptions(scan as never)).toEqual(expected);
  });
});
