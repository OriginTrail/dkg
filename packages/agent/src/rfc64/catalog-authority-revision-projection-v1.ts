// SPDX-License-Identifier: Apache-2.0

export interface Rfc64CatalogAuthorityRevisionTargetsV1 {
  readonly onChainContextGraphIds: readonly bigint[];
  readonly localContextGraphIdsByOnChainId: ReadonlyMap<string, readonly string[]>;
}

/** Pure grouping boundary between local binding provenance and one index read. */
export function projectRfc64CatalogAuthorityRevisionTargetsV1(
  contextGraphIds: readonly string[],
  resolveBinding: (
    contextGraphId: string,
  ) => string | undefined,
): Rfc64CatalogAuthorityRevisionTargetsV1 {
  const localContextGraphIdsByOnChainId = new Map<string, string[]>();
  for (const contextGraphId of new Set(contextGraphIds)) {
    const onChainId = resolveBinding(contextGraphId);
    if (onChainId === undefined) continue;
    const localIds = localContextGraphIdsByOnChainId.get(onChainId) ?? [];
    localIds.push(contextGraphId);
    localContextGraphIdsByOnChainId.set(onChainId, localIds);
  }
  return Object.freeze({
    onChainContextGraphIds: Object.freeze(
      [...localContextGraphIdsByOnChainId.keys()].map((id) => BigInt(id)),
    ),
    localContextGraphIdsByOnChainId: new Map(
      [...localContextGraphIdsByOnChainId].map(([id, localIds]) => [
        id,
        Object.freeze([...localIds]),
      ]),
    ),
  });
}

/** Project opaque per-slot revisions back onto every local responsibility. */
export function mapRfc64CatalogAuthorityRevisionsToLocalV1(
  revisions: readonly Readonly<{ contextGraphId: string; revision: string }>[],
  localContextGraphIdsByOnChainId: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, string> {
  const byLocalContextGraph = new Map<string, string>();
  for (const { contextGraphId, revision } of revisions) {
    for (const localContextGraphId of localContextGraphIdsByOnChainId.get(contextGraphId) ?? []) {
      byLocalContextGraph.set(localContextGraphId, revision);
    }
  }
  return byLocalContextGraph;
}
