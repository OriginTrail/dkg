// SPDX-License-Identifier: Apache-2.0

import type { SignerTxLaneState } from './signer-tx-serializer.js';

export function preferredFundableCandidate<T extends { address: string }>(
  candidates: readonly T[],
  fundableIdx: readonly number[],
  policy: { preferIdle: boolean; idleAwareSelectionDisabled: boolean; laneState: (address: string) => SignerTxLaneState },
): T {
  if (policy.preferIdle && !policy.idleAwareSelectionDisabled) {
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
    let best: number | undefined;
    let bestRank = Number.POSITIVE_INFINITY;
    for (const index of fundableIdx) {
      const r = rank(candidates[index].address);
      if (r < bestRank) { bestRank = r; best = index; }
      if (bestRank === 0) break;
    }
    if (best !== undefined) return candidates[best];
  }
  return candidates[fundableIdx[0]];
}
