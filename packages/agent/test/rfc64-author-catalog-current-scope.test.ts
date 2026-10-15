/**
 * GH#3134 — the current catalog scope of an author lane is the bucket count of its newest applied
 * head; a lane with nothing applied, or only its one-bucket head, is one bucket.
 */
import { describe, expect, it } from 'vitest';

import {
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogScopeV1,
  type CountV1,
} from '@origintrail-official/dkg-core';

import { readCurrentAuthorCatalogScopeV1 } from '../src/internal/author-catalog-current-scope.js';

const AUTHOR = '0x1111111111111111111111111111111111111111';
const LANE = Object.freeze({
  networkId: 'otp:20430',
  contextGraphId: `${AUTHOR}/catalog-lane`,
  governanceChainId: '20430',
  governanceContractAddress: '0x2222222222222222222222222222222222222222',
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  era: '0',
  bucketCount: '1',
}) as AuthorCatalogScopeV1;

describe('current catalog scope of an author lane (GH#3134)', () => {
  it('is one bucket when nothing, or only the one-bucket head, is applied', () => {
    expect(readCurrentAuthorCatalogScopeV1(inventory([]), LANE)).toEqual(LANE);
    expect(readCurrentAuthorCatalogScopeV1(inventory(['1']), withCount('64'))).toEqual(LANE);
  });

  it('is the largest bucket count with an applied head, whatever count the caller names', () => {
    const applied = inventory(['1', '4', '64']);

    expect(readCurrentAuthorCatalogScopeV1(applied, LANE)).toEqual(withCount('64'));
    expect(readCurrentAuthorCatalogScopeV1(applied, withCount('4'))).toEqual(withCount('64'));
    expect(readCurrentAuthorCatalogScopeV1(inventory(['65536']), LANE)).toEqual(withCount('65536'));
  });

  it('reads only the heads of this author', () => {
    const other = inventory(['16'], '0x3333333333333333333333333333333333333333');

    expect(readCurrentAuthorCatalogScopeV1(other, LANE)).toEqual(LANE);
  });
});

function withCount(bucketCount: string): AuthorCatalogScopeV1 {
  return { ...LANE, bucketCount: bucketCount as CountV1 };
}

/** Applied heads at these bucket counts of the lane, for `author`. */
function inventory(bucketCounts: readonly string[], author: string = AUTHOR) {
  const applied = new Set(bucketCounts.map((bucketCount) => (
    `${computeAuthorCatalogScopeDigestV1(withCount(bucketCount))}\n${author}`
  )));
  return {
    readAppliedCatalogHeadV1: (catalogScopeDigest: string, authorAddress: string) => (
      applied.has(`${catalogScopeDigest}\n${authorAddress}`) ? ({}) as never : null
    ),
  };
}
