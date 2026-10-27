import { describe, expect, it } from 'vitest';
import { bufferedGasLimit, wantsGasLimitBuffer } from '../src/gas-limit-buffer.js';

describe('gas limit headroom', () => {
  it('adds the proportional share of the estimate, rounded down', () => {
    expect(bufferedGasLimit(294_443n, { gasLimitBufferBps: 5_000 })).toBe(441_664n);
    expect(bufferedGasLimit(21_000n, { gasLimitBufferBps: 1_000 })).toBe(23_100n);
    expect(bufferedGasLimit(3n, { gasLimitBufferBps: 2_500 })).toBe(3n);
  });

  it('adds the least headroom when the proportional share is smaller', () => {
    // +50% of 319,732 is 159,866: less than the 2,500,000 asked for.
    expect(bufferedGasLimit(319_732n, { gasLimitBufferBps: 5_000, gasLimitMinBuffer: 2_500_000n }))
      .toBe(2_819_732n);
    expect(bufferedGasLimit(319_732n, { gasLimitMinBuffer: 2_500_000n })).toBe(2_819_732n);
  });

  it('adds the proportional share once it exceeds the least headroom', () => {
    const opts = { gasLimitBufferBps: 5_000, gasLimitMinBuffer: 2_500_000n };

    // The two meet at an estimate of 5,000,000.
    expect(bufferedGasLimit(4_999_998n, opts)).toBe(7_499_998n);
    expect(bufferedGasLimit(5_000_000n, opts)).toBe(7_500_000n);
    expect(bufferedGasLimit(5_000_002n, opts)).toBe(7_500_003n);
  });

  it('returns the estimate itself when no headroom is asked for', () => {
    expect(bufferedGasLimit(100_000n, {})).toBe(100_000n);
    expect(bufferedGasLimit(100_000n, { gasLimitBufferBps: 0, gasLimitMinBuffer: 0n })).toBe(100_000n);
  });

  it('tells whether a caller asked for headroom', () => {
    expect(wantsGasLimitBuffer(undefined)).toBe(false);
    expect(wantsGasLimitBuffer({})).toBe(false);
    expect(wantsGasLimitBuffer({ gasLimitBufferBps: 0, gasLimitMinBuffer: 0n })).toBe(false);
    expect(wantsGasLimitBuffer({ gasLimitBufferBps: 2_500 })).toBe(true);
    expect(wantsGasLimitBuffer({ gasLimitMinBuffer: 1n })).toBe(true);
    expect(wantsGasLimitBuffer({ gasLimitBufferBps: 0, gasLimitMinBuffer: 2_500_000n })).toBe(true);
  });
});
