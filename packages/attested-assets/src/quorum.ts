import type { QuorumPolicy } from './types.js';

export function quorumThreshold(policy: QuorumPolicy, activeMemberCount: number): number {
  const fractional = Math.ceil(
    (activeMemberCount * policy.numerator) / policy.denominator,
  );
  return Math.max(fractional, policy.minSigners);
}

export function isQuorumMet(
  policy: QuorumPolicy,
  activeMemberCount: number,
  ackCount: number,
): boolean {
  return ackCount >= quorumThreshold(policy, activeMemberCount);
}

export function getActiveMemberCount(
  totalMembers: number,
  equivocatorCount: number,
  inactiveCount: number,
): number {
  return totalMembers - equivocatorCount - inactiveCount;
}
