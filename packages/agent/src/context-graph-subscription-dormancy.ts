// SPDX-License-Identifier: Apache-2.0

export const CONTEXT_GRAPH_DORMANCY_REASONS = [
  'activationCap',
  'authorityDenied',
  'authorityUnavailable',
  'rehydrationDisabled',
  'deactivated',
] as const;

export type ContextGraphDormancyReason = typeof CONTEXT_GRAPH_DORMANCY_REASONS[number];

export type ContextGraphDormancyProjection = {
  dormantIds: string[];
  dormantReasons: Record<ContextGraphDormancyReason, string[]>;
};

export function contextGraphDormancyMapFromProjection(
  projection: ContextGraphDormancyProjection,
): Map<string, ContextGraphDormancyReason> {
  const result = new Map<string, ContextGraphDormancyReason>();
  for (const reason of CONTEXT_GRAPH_DORMANCY_REASONS) {
    for (const id of projection.dormantReasons[reason]) result.set(id, reason);
  }
  return result;
}

export function projectContextGraphDormancy(
  dormancyById: ReadonlyMap<string, ContextGraphDormancyReason>,
): ContextGraphDormancyProjection {
  const dormantReasons: ContextGraphDormancyProjection['dormantReasons'] = {
    activationCap: [],
    authorityDenied: [],
    authorityUnavailable: [],
    rehydrationDisabled: [],
    deactivated: [],
  };
  for (const [id, reason] of dormancyById) dormantReasons[reason].push(id);
  const sort = (ids: string[]): string[] => ids.sort((a, b) => (
    a < b ? -1 : a > b ? 1 : 0
  ));
  for (const reason of CONTEXT_GRAPH_DORMANCY_REASONS) sort(dormantReasons[reason]);
  return { dormantIds: sort([...dormancyById.keys()]), dormantReasons };
}
