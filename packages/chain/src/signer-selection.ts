// SPDX-License-Identifier: Apache-2.0

import type { SignerTxLaneState } from './signer-tx-serializer.js';

/**
 * Per-tx-type funding requirement for operational-wallet selection. A
 * discriminated union so "native-only" (RS challenge/proof, relay, settle —
 * gas only, no TRAC transfer) is UNREPRESENTABLE-AS-TRAC-GATED: applying a
 * publish TRAC floor to a gas-only tx would wrongly reject a valid,
 * gas-funded, zero-TRAC wallet. `native+trac` (publish/update) additionally
 * requires own-TRAC to cover the publish above the operator floor, with an
 * explicit Publishing Conviction Account (PCA) policy: disabled, provisional
 * signer discovery, or an exact epoch-bearing publish plan.
 */
export type PcaFundingMode =
  | { kind: 'none' }
  /** Candidate discovery while an omitted lifetime is still signer-dependent. */
  | { kind: 'provisional-publish' }
  /** Exact publish plan: the PCA lock must equal `epochs`. */
  | { kind: 'publish'; epochs: number };

export type FundingMode =
  | { kind: 'native-only'; nativeFloorWei: bigint }
  | {
      kind: 'native+trac';
      nativeFloorWei: bigint;
      tracFloorWei: bigint;
      requiredTracWei: bigint;
      /** Explicit PCA semantics; exact publish checks cannot omit the lock. */
      pca: PcaFundingMode;
    };

export type NativeOnlyFundingMode = Extract<FundingMode, { kind: 'native-only' }>;
export type NativeAndTracFundingMode = Extract<FundingMode, { kind: 'native+trac' }>;

/**
 * Generalized operational-wallet selection request. The discriminant fixes the
 * eligible-wallet scope and the required funding model together, so invalid
 * combinations (for example, publish policy selection without a context graph or
 * with native-only funding) do not compile.
 *
 * - `rotatable-policy`  → publish: eligible = on-chain authorized publishers
 *                          for `contextGraphId` (whole pool when no ContextGraphs surface).
 * - `rotatable-funded`  → update: eligible = whole pool, native+TRAC funding.
 * - `rotatable-free`    → RS / relay / settle: eligible = whole pool, native-only funding.
 */
export type SelectSignerSpec =
  | {
      txClass: 'rotatable-policy';
      funding: NativeAndTracFundingMode;
      /** The CG whose authorized publishers gate publish eligibility. */
      contextGraphId: bigint;
      /** Soft, fail-open bias toward a funded wallet whose per-wallet lock is free. Default false. */
      preferIdle?: boolean;
    }
  | {
      txClass: 'rotatable-funded';
      funding: NativeAndTracFundingMode;
      contextGraphId?: never;
      /** Soft, fail-open bias toward a funded wallet whose per-wallet lock is free. Default false. */
      preferIdle?: boolean;
    }
  | {
      txClass: 'rotatable-free';
      funding: NativeOnlyFundingMode;
      contextGraphId?: never;
      /** Soft, fail-open bias toward a funded wallet whose per-wallet lock is free. Default false. */
      preferIdle?: boolean;
    };

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
