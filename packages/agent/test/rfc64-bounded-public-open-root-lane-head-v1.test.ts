import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  type SignedAuthorCatalogHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { describe, expect, it } from 'vitest';

import { readBoundedPublicOpenRootLaneHeadV1 } from '../src/rfc64/bounded-public-open-root-lane-head-v1.js';

const PREVIOUS = `0x${'11'.repeat(32)}`;

function head(
  overrides: Partial<SignedAuthorCatalogHeadEnvelopeV1['payload']> = {},
): SignedAuthorCatalogHeadEnvelopeV1 {
  return {
    payload: {
      subGraphName: null,
      bucketCount: '1',
      directoryHeight: '0',
      totalRows: '2',
      version: '1',
      previousHeadDigest: PREVIOUS,
      ...overrides,
    },
  } as SignedAuthorCatalogHeadEnvelopeV1;
}

describe('bounded public/open root-lane head v1', () => {
  it('returns one frozen numeric successor invariant at both supported bounds', () => {
    const minimum = readBoundedPublicOpenRootLaneHeadV1(head({ totalRows: '0' }), {
      allowGenesis: true,
    });
    const maximum = readBoundedPublicOpenRootLaneHeadV1(head({
      totalRows: MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1.toString(),
    }), { allowGenesis: false });

    expect(minimum).toEqual({ rowCount: 0, isGenesis: false });
    expect(maximum).toEqual({
      rowCount: MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
      isGenesis: false,
    });
    expect(Object.isFrozen(maximum)).toBe(true);
  });

  it('reports canonical genesis only when the caller policy allows it', () => {
    const genesis = head({
      totalRows: '0',
      version: '0',
      previousHeadDigest: null,
    });

    expect(readBoundedPublicOpenRootLaneHeadV1(genesis, {
      allowGenesis: true,
    })).toEqual({ rowCount: 0, isGenesis: true });
    expect(() => readBoundedPublicOpenRootLaneHeadV1(genesis, {
      allowGenesis: false,
    })).toThrow('does not allow genesis');
  });

  it.each([
    '-1',
    '01',
    `${MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 + 1}`,
    '18446744073709551616',
  ])('rejects invalid or out-of-slice totalRows %s', (totalRows) => {
    expect(() => readBoundedPublicOpenRootLaneHeadV1(head({
      totalRows: totalRows as never,
    }), { allowGenesis: true })).toThrow(/totalRows/);
  });

  it('rejects non-root, multi-bucket, and non-level-zero heads', () => {
    for (const candidate of [
      head({ subGraphName: 'named' as never }),
      head({ bucketCount: '2' as never }),
      head({ directoryHeight: '1' as never }),
    ]) {
      expect(() => readBoundedPublicOpenRootLaneHeadV1(candidate, {
        allowGenesis: true,
      })).toThrow('outside the public/open root lane');
    }
  });

  it('classifies either genesis history marker fail-closed', () => {
    for (const candidate of [
      head({ version: '0' }),
      head({ previousHeadDigest: null }),
    ]) {
      expect(readBoundedPublicOpenRootLaneHeadV1(candidate, {
        allowGenesis: true,
      }).isGenesis).toBe(true);
      expect(() => readBoundedPublicOpenRootLaneHeadV1(candidate, {
        allowGenesis: false,
      })).toThrow('does not allow genesis');
    }
  });
});
