// SPDX-License-Identifier: Apache-2.0

/**
 * The key that one asset's SWM-inventory work runs under, one piece after another: the observer of
 * its share, the removal at its confirmation and the removal after its finalized twin (GH#3134).
 */
export function rfc64SwmInventoryAssetKeyV1(input: Readonly<{
  contextGraphId: string;
  subGraphName?: string | null;
  authorAddress: string;
  assertionCoordinate: string;
}>): string {
  return JSON.stringify([
    input.contextGraphId,
    input.subGraphName ?? null,
    input.authorAddress.toLowerCase(),
    input.assertionCoordinate,
  ]);
}
