import { describe, expect, it } from 'vitest';
import {
  CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
  CATCHUP_STOP_ON_PROOF,
  catchupWaveSizes,
  resolveCatchupStopOnProof,
} from '../src/sync/catchup-concurrency.js';

describe('catchupWaveSizes', () => {
  it('starts with a single peer so a proving authority costs one payload', () => {
    // The peer list arrives ranked authority-first, so wave 1 is the curator
    // whenever one is resolvable. Issue #2006: the pre-fix fan-out pulled the
    // whole graph from every sync-capable peer instead.
    expect(catchupWaveSizes(14, 4)[0]).toBe(1);
    expect(catchupWaveSizes(1, 4)).toEqual([1]);
  });

  it('escalates by doubling up to the concurrency cap', () => {
    expect(catchupWaveSizes(14, 4)).toEqual([1, 2, 4, 4, 3]);
    expect(catchupWaveSizes(20, 4)).toEqual([1, 2, 4, 4, 4, 4, 1]);
    expect(catchupWaveSizes(7, 8)).toEqual([1, 2, 4]);
  });

  it('opens at the full cap when there is no authority to spend the first wave on', () => {
    // A single-peer opening wave buys "one payload from the curator". With no
    // resolvable curator it buys nothing and would just add a round-trip to the
    // front of every round, so callers open at the cap instead.
    expect(catchupWaveSizes(14, 4, 4)).toEqual([4, 4, 4, 2]);
    expect(catchupWaveSizes(3, 4, 4)).toEqual([3]);
    // startWidth can never exceed the concurrency cap.
    expect(catchupWaveSizes(9, 2, 8)).toEqual([2, 2, 2, 2, 1]);
    expect(catchupWaveSizes(5, 4, 0)).toEqual([1, 2, 2]);
  });

  it('never exceeds the cap or the peer count', () => {
    for (const cap of [1, 2, 3, 4, 8]) {
      for (const peerCount of [0, 1, 3, 5, 13, 40]) {
        const sizes = catchupWaveSizes(peerCount, cap);
        expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(peerCount);
        for (const size of sizes) {
          expect(size).toBeGreaterThan(0);
          expect(size).toBeLessThanOrEqual(cap);
        }
      }
    }
  });

  it('degrades to serial waves for a non-positive cap instead of looping forever', () => {
    expect(catchupWaveSizes(3, 0)).toEqual([1, 1, 1]);
    expect(catchupWaveSizes(3, Number.NaN)).toEqual([1, 1, 1]);
    expect(catchupWaveSizes(0, 4)).toEqual([]);
    expect(catchupWaveSizes(-2, 4)).toEqual([]);
  });

  it('resolves the shared fan-out cap to a positive integer', () => {
    // Deliberately NOT asserting an upper bound: the constant is
    // env-overridable and production applies no clamp, so pinning an arbitrary
    // ceiling here would fail a validly configured node
    // (`DKG_CATCHUP_MAX_CONCURRENT_PEERS=32`) while proving nothing about the
    // code. The real contract is the parse: a positive integer, else the
    // default.
    expect(Number.isInteger(CATCHUP_MAX_CONCURRENT_PEER_SYNCS)).toBe(true);
    expect(CATCHUP_MAX_CONCURRENT_PEER_SYNCS).toBeGreaterThan(0);
  });
});

describe('resolveCatchupStopOnProof', () => {
  // The kill-switch is operator-facing and documented with four disabled
  // spellings. `CATCHUP_STOP_ON_PROOF` resolves once at module load, so without
  // a pure parser only the spelling the suite happens to set is ever exercised
  // — dropping `'false'` would leave an operator who set it silently running
  // the very fan-out they turned off, with every test still green.
  it.each(['0', 'false', 'no', 'off'])('treats %s as off', (value) => {
    expect(resolveCatchupStopOnProof(value)).toBe(false);
  });

  it.each(['  off  ', 'OFF', 'False', 'No\t', ' 0'])('normalizes case and surrounding space in %j', (value) => {
    expect(resolveCatchupStopOnProof(value)).toBe(false);
  });

  it.each([undefined, '', '   ', '1', 'true', 'yes', 'on', 'nope', 'offf', '0.0'])(
    'leaves the walk ON for %j',
    (value) => {
      // Default-on is the safe direction: an unrecognised value or a typo must
      // not silently restore the pre-#2006 fan-out.
      expect(resolveCatchupStopOnProof(value)).toBe(true);
    },
  );

  it('resolves the module constant through the same parser', () => {
    expect(CATCHUP_STOP_ON_PROOF)
      .toBe(resolveCatchupStopOnProof(process.env.DKG_CATCHUP_STOP_ON_PROOF));
  });
});
