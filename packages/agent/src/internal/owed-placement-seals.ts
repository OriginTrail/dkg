// SPDX-License-Identifier: Apache-2.0

/**
 * Legacy V1 placement markers name a seal digest without storing the seal. An explicit V1
 * request may keep that seal in this process if reopening displaced its stored archive.
 * V2 obligations carry their own immutable seal and never populate or read this cache.
 */
import type { CanonicalGraphScopedAuthorSealV1, Digest32V1 } from '@origintrail-official/dkg-core';

import { rememberBounded } from '../bounded-map.js';

/** Seals kept per owner; the oldest go first, and their placements read the stored seals. */
export const MAX_RETAINED_PLACEMENT_SEALS_V1 = 4_096;

const retainedByOwner = new WeakMap<object, Map<Digest32V1, Readonly<CanonicalGraphScopedAuthorSealV1>>>();

/** Keep `seal` for the placement that names it by `sealDigest`. */
export function retainOwedPlacementSealV1(
  owner: object,
  sealDigest: Digest32V1,
  seal: Readonly<CanonicalGraphScopedAuthorSealV1>,
): void {
  let retained = retainedByOwner.get(owner);
  if (retained === undefined) {
    retained = new Map();
    retainedByOwner.set(owner, retained);
  }
  rememberBounded(retained, sealDigest, seal, MAX_RETAINED_PLACEMENT_SEALS_V1);
}

/** The seal kept for `sealDigest`, if this process observed its confirmation and still holds it. */
export function readOwedPlacementSealV1(
  owner: object,
  sealDigest: Digest32V1,
): Readonly<CanonicalGraphScopedAuthorSealV1> | undefined {
  return retainedByOwner.get(owner)?.get(sealDigest);
}
