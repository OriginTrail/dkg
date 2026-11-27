// SPDX-License-Identifier: Apache-2.0

import {
  rfc64FinalizedPrivatePlacementRepairKeyV1,
  type Rfc64FinalizedPrivatePlacementRepairV1,
} from '../rfc64/finalized-private-placement-repair-store-v1.js';

/**
 * Scheduling and persistence identify the same canonical durable marker. A listed marker is a
 * frozen snapshot that keeps its key, so a pass does not hash it again (GH#3134).
 */
export function finalizedPrivateRepairKeyV1(
  repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
): string {
  return rfc64FinalizedPrivatePlacementRepairKeyV1(repair);
}
