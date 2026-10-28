// SPDX-License-Identifier: Apache-2.0

import {
  digestRfc64FinalizedPrivatePlacementRepairV1,
  encodeRfc64FinalizedPrivatePlacementRepairV1,
  type Rfc64FinalizedPrivatePlacementRepairV1,
} from '../rfc64/finalized-private-placement-repair-store-v1.js';

/** Scheduling and persistence identify the same canonical durable marker. */
export function finalizedPrivateRepairKeyV1(
  repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
): string {
  return Buffer.from(digestRfc64FinalizedPrivatePlacementRepairV1(
    encodeRfc64FinalizedPrivatePlacementRepairV1(repair),
  )).toString('hex');
}
