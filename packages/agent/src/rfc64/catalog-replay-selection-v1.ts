// SPDX-License-Identifier: Apache-2.0

/** Deterministic immutable selection over independently supplied receiver or serving authority. */
export function selectCatalogReplayGraphsV1(candidateIds: Iterable<string>,
  resolveAuthority: (contextGraphId: string) => Readonly<{ active: boolean; mode: string }>): readonly string[] {
  return Object.freeze([...new Set(candidateIds)].filter(id => {
    const authority = resolveAuthority(id);
    return authority.active && authority.mode !== 'legacy';
  }).sort());
}
