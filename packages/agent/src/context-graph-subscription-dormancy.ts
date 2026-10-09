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

/**
 * Dormancy of a saved row whose read authority did not come back allowed.
 *
 * A denial is final for the process. So is the chain's answer that the id
 * does not exist or is not active: asking again only repeats it, while a
 * timeout or a failed read has its own reason and stays retryable. The row
 * stays saved either way, and the next start checks it again.
 */
export function contextGraphDormancyAfterAuthority(
  authority: Readonly<{ outcome: string; reason: string }>,
): 'authorityDenied' | 'authorityUnavailable' | 'deactivated' {
  if (authority.outcome === 'denied') return 'authorityDenied';
  return authority.reason === 'chain-access-policy-unknown' ? 'deactivated' : 'authorityUnavailable';
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
