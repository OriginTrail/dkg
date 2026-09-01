import { describe, expect, it } from 'vitest';
import { parsePcaRegistrationCoverageAccount } from '../src/evm-adapter-conviction.js';

describe('parsePcaRegistrationCoverageAccount', () => {
  it('parses named PCA account fields', () => {
    expect(parsePcaRegistrationCoverageAccount({
      committedTRAC: 1_000n,
      expiresAtTimestamp: 2_000n,
      fullySwept: false,
    })).toEqual({
      committedTRAC: 1_000n,
      expiresAtTimestamp: 2_000n,
      fullySwept: false,
    });
  });

  it('parses the positional PCA accounts tuple fields', () => {
    const tuple = [1_000n, 1n, 2n, 3n, 2_000n, 4n, 5n, 6n, true];

    expect(parsePcaRegistrationCoverageAccount(tuple)).toEqual({
      committedTRAC: 1_000n,
      expiresAtTimestamp: 2_000n,
      fullySwept: true,
    });
  });

  it.each([
    null,
    {},
    { committedTRAC: '1000', expiresAtTimestamp: 2_000n, fullySwept: false },
    { committedTRAC: 1_000n, expiresAtTimestamp: -1n, fullySwept: false },
    { committedTRAC: 1_000n, expiresAtTimestamp: 2_000n, fullySwept: 0 },
    [1_000n, 1n, 2n, 3n, 2_000n],
  ])('fails closed for malformed input %#', (raw) => {
    expect(parsePcaRegistrationCoverageAccount(raw)).toBeUndefined();
  });
});
