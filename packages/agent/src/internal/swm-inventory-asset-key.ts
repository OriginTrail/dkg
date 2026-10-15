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

/** Whether `assetKey` is the key of one of this author's assets in the graph's root lane. */
export function rfc64SwmInventoryAssetKeyIsAuthorsV1(
  assetKey: string,
  author: Readonly<{ contextGraphId: string; authorAddress: string }>,
): boolean {
  const lane = JSON.stringify([author.contextGraphId, null, author.authorAddress.toLowerCase()]);
  return assetKey.startsWith(`${lane.slice(0, -1)},`);
}
