// SPDX-License-Identifier: Apache-2.0

import type { Rfc64FinalizedPrivatePlacementRepairV1 } from
  '../rfc64/finalized-private-placement-repair-store-v1.js';

/** The catalog supervisor's identity of one durable finalized-private placement marker. */
export function finalizedPrivateRepairKeyV1(
  repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
): string {
  return JSON.stringify([
    repair.version,
    repair.contextGraphId,
    repair.authorAddress,
    repair.inventoryScope.networkId,
    repair.inventoryScope.contextGraphId,
    repair.inventoryScope.governanceChainId,
    repair.inventoryScope.governanceContractAddress,
    repair.inventoryScope.ownershipTransitionDigest,
    repair.inventoryScope.authorAddress,
    repair.inventoryScope.subGraphName,
    repair.inventoryScope.era,
    repair.assertionCoordinate,
    repair.kaUal,
    repair.assertionVersion,
    repair.sealDigest,
  ]);
}
