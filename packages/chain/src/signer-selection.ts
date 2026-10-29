// SPDX-License-Identifier: Apache-2.0

import type { SignerTxLaneState } from './signer-tx-serializer.js';

export function preferredFundableCandidate<T extends { address: string }>(
  assessments: readonly { candidate: T }[],
  policy: { preferIdle: boolean; idleAwareSelectionDisabled: boolean; laneState: (address: string) => SignerTxLaneState },
): T | undefined {
  const first = assessments[0]?.candidate;
  if (first === undefined || !policy.preferIdle || policy.idleAwareSelectionDisabled) return first;

  // GH#953 — soft-prefer a wallet with no in-flight or queued write.
  // GH#1574 — a lane whose holder is wedged is NOT idle, but it is not
  // healthy either: routing new work behind it inherits the wedge
  // invisibly, which is the failure that issue reports. Rank the
  // serializer's OWN health verdict rather than reading raw timings and
  // re-deriving the threshold here — two copies of that policy would
  // drift, and diagnostics could call a lane stalled while selection
  // still called it healthy.
  const laneRank: Record<SignerTxLaneState, number> = {
    idle: 0,
    busy: 1,
    stalled: 2,
  };
  const rank = (address: string): number =>
    laneRank[policy.laneState(address)];
  let best = first;
  let bestRank = rank(first.address);
  if (bestRank === 0) return best;
  for (const { candidate } of assessments.slice(1)) {
    const r = rank(candidate.address);
    if (r < bestRank) { bestRank = r; best = candidate; }
    if (bestRank === 0) break;
  }
  return best;
}
