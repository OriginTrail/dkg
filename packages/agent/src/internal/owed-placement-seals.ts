// SPDX-License-Identifier: Apache-2.0

/**
 * GH#3081 — the author seals of the catalog placements this process owes.
 *
 * A confirmed private publication is terminal once its placement is durably owed. The marker names
 * the confirmed version by seal digest, and the placement reads the seal when it runs. By then the
 * author may have re-opened the assertion more than once, and neither the assertion's active seal
 * nor its one recovery archive is that seal any longer. The post-confirmation observer was handed
 * the seal itself, so it is kept here, by digest, for the placement to fall back on.
 *
 * Process-local on purpose: the marker row is a strict persisted format that does not carry the
 * seal. After a restart a placement has the stored seals only.
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
