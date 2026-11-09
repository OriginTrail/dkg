// SPDX-License-Identifier: Apache-2.0

export interface CatalogReplayRolesV1 { readonly receiving: boolean; readonly serving: boolean }

/** Immutable role selection over a bounded candidate universe. */
export function selectCatalogReplayGraphsV1(candidateIds: Iterable<string>,
  resolveRoles: (contextGraphId: string) => CatalogReplayRolesV1,
  role: keyof CatalogReplayRolesV1): readonly string[] {
  return Object.freeze([...new Set(candidateIds)].filter(id => resolveRoles(id)[role]).sort());
}

/** Role policy is explicit and does not modify either canonical authority. */
export function resolveCatalogReplayRolesV1(selected: boolean, compatibilityServing: boolean,
  receiver: Readonly<{ active: boolean; mode: string }>, serving: Readonly<{ active: boolean; mode: string }>): CatalogReplayRolesV1 {
  return Object.freeze({ receiving: selected && receiver.active && receiver.mode !== 'legacy',
    serving: (selected || compatibilityServing) && serving.active && serving.mode !== 'legacy' });
}
