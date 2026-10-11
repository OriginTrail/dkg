/**
 * GH#3081 — the seals a process keeps for the catalog placements it owes: by owner and seal
 * digest, bounded, oldest first out.
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalGraphScopedAuthorSealV1, Digest32V1 } from '@origintrail-official/dkg-core';

import {
  MAX_RETAINED_PLACEMENT_SEALS_V1,
  readOwedPlacementSealV1,
  retainOwedPlacementSealV1,
} from '../src/internal/owed-placement-seals.js';

const digest = (index: number): Digest32V1 => `0x${index.toString(16).padStart(64, '0')}` as Digest32V1;
/** The module keeps what it is given by reference and reads none of its fields. */
const seal = (assertionVersion: string) => ({ assertionVersion }) as CanonicalGraphScopedAuthorSealV1;

describe('the seals of owed placements', () => {
  it('keeps a seal by owner and digest', () => {
    const owner = {};
    const other = {};
    const first = seal('1');
    retainOwedPlacementSealV1(owner, digest(1), first);

    expect(readOwedPlacementSealV1(owner, digest(1))).toBe(first);
    expect(readOwedPlacementSealV1(owner, digest(2))).toBeUndefined();
    expect(readOwedPlacementSealV1(other, digest(1))).toBeUndefined();
  });

  it('keeps the newest of the bound and lets the oldest go', () => {
    const owner = {};
    for (let index = 0; index <= MAX_RETAINED_PLACEMENT_SEALS_V1; index += 1) {
      retainOwedPlacementSealV1(owner, digest(index), seal(String(index + 1)));
    }

    expect(readOwedPlacementSealV1(owner, digest(0))).toBeUndefined();
    expect(readOwedPlacementSealV1(owner, digest(1))).toEqual(seal('2'));
    expect(readOwedPlacementSealV1(owner, digest(MAX_RETAINED_PLACEMENT_SEALS_V1)))
      .toEqual(seal(String(MAX_RETAINED_PLACEMENT_SEALS_V1 + 1)));
  });

  it('counts a seal that is observed again as the newest', () => {
    const owner = {};
    retainOwedPlacementSealV1(owner, digest(0), seal('1'));
    for (let index = 1; index < MAX_RETAINED_PLACEMENT_SEALS_V1; index += 1) {
      retainOwedPlacementSealV1(owner, digest(index), seal('1'));
    }
    // The second observation of the oldest confirmation, then one more placement.
    retainOwedPlacementSealV1(owner, digest(0), seal('1'));
    retainOwedPlacementSealV1(owner, digest(MAX_RETAINED_PLACEMENT_SEALS_V1), seal('1'));

    expect(readOwedPlacementSealV1(owner, digest(0))).toBeDefined();
    expect(readOwedPlacementSealV1(owner, digest(1))).toBeUndefined();
  });
});
