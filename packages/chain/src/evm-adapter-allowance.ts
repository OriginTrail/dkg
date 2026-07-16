// SPDX-License-Identifier: Apache-2.0

/**
 * V10 publish/update TRAC-allowance sizing extracted from evm-adapter.ts:
 * the on-chain minimum floor (`effectivePublishAllowance`) and the
 * per-policy approval decision (`computeApprovalAction`). Bodies are a
 * 1:1 move from the original module.
 */
import {
  DEFAULT_REPLENISH_TARGET_ALLOWANCE,
  DEFAULT_REFILL_BELOW_FRACTION,
  type ApprovalPolicy,
} from './chain-adapter.js';

/**
 * On-chain minimum the `KnowledgeAssetsLifecycle.publish` / `update` contract
 * pulls via `token.transferFrom(msg.sender, CSS, fullCost)` even for
 * zero-byte / zero-value publishes — the contract rounds `fullCost` up to
 * `1` wei-TRAC. Empirically reproduced on Base Sepolia, May 2026: a
 * publish with JS-side `params.tokenAmount === 0n` reverted with
 * `TooLowAllowance(token, 0, 1)` because the auto-approve path (then
 * gated on `tokenAmount > 0n` / `currentAllowance < tokenAmount`) skipped
 * approval entirely.
 *
 * On mainnet the same fires whenever the pricing oracle returns `0`
 * (new / dust-value CGs, certain edge cases in `getRequiredPublishTokenAmount`),
 * so we floor the approval ceiling at the on-chain minimum.
 */
export const V10_PUBLISH_ONCHAIN_MIN_ALLOWANCE: bigint = 1n;

/**
 * Returns the TRAC allowance ceiling required to cover one V10 publish /
 * update. Floors at the on-chain minimum so the direct-spend branch
 * (`token.transferFrom(..., fullCost)`) never reverts with
 * `TooLowAllowance` when the JS-side `tokenAmount` is `0n`.
 *
 * This is the *building block* for the `per-publish` approval policy and
 * the lower-bound clamp used by every other policy mode in
 * `computeApprovalAction`. The bounded-per-publish security property of
 * the legacy code path lives here.
 */
export function effectivePublishAllowance(
  tokenAmount: bigint,
  onChainMin: bigint = V10_PUBLISH_ONCHAIN_MIN_ALLOWANCE,
): bigint {
  return tokenAmount > onChainMin ? tokenAmount : onChainMin;
}

const MAX_UINT256_ALLOWANCE: bigint = (1n << 256n) - 1n;

function clampApprovalFraction(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REFILL_BELOW_FRACTION;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Computes the approval action for one V10 publish / update, dispatched
 * by `ApprovalPolicy.mode`.
 *
 * Contract:
 *   - `needsApprove === true`  → caller MUST submit `approve(KA,
 *     targetAllowance)` before the publish to satisfy
 *     `token.transferFrom(..., fullCost)` on-chain.
 *   - `needsApprove === false` → skip the approve; the existing allowance
 *     already covers this publish.
 *
 * Invariants enforced for every mode:
 *   - `targetAllowance >= effectivePublishAllowance(tokenAmount)` — even
 *     a misconfigured `replenishing` target gets raised to the on-chain
 *     minimum so the immediate publish succeeds.
 *   - `needsApprove` is monotone in `currentAllowance` — strictly more
 *     existing allowance never flips a `false` to `true`.
 *
 * See {@link ApprovalPolicy} in `chain-adapter.ts` for the mode
 * semantics; see `evm-adapter.unit.test.ts` for the pinned-down behaviour
 * under every combination of `(mode, tokenAmount, currentAllowance)`.
 */
export function computeApprovalAction(
  policy: ApprovalPolicy,
  tokenAmount: bigint,
  currentAllowance: bigint,
): { needsApprove: boolean; targetAllowance: bigint } {
  const publishFloor = effectivePublishAllowance(tokenAmount);
  switch (policy.mode) {
    case 'unlimited': {
      // Approve `MaxUint256` once per wallet. After that, currentAllowance
      // covers any plausible tokenAmount — re-approve only if some external
      // actor brought it back under the immediate publish's floor (manual
      // `approve(KA, 0)`, contract upgrade, etc.).
      return {
        needsApprove: currentAllowance < publishFloor,
        targetAllowance: MAX_UINT256_ALLOWANCE,
      };
    }
    case 'replenishing': {
      // Approve a configurable ceiling once, then refill when current drops
      // below `target × fraction`. Raise the target to at least the publish
      // floor so a misconfigured low `targetAllowance` doesn't brick the
      // publish — the bigger of (operator's intent, what we need right now).
      const requestedTarget =
        policy.targetAllowance ?? DEFAULT_REPLENISH_TARGET_ALLOWANCE;
      const target = requestedTarget > publishFloor ? requestedTarget : publishFloor;
      const fraction = clampApprovalFraction(
        policy.refillBelowFraction ?? DEFAULT_REFILL_BELOW_FRACTION,
      );
      // bigint-safe `target * fraction` via basis points so a fractional
      // refill threshold never drifts on round-trip.
      const fractionBp = BigInt(Math.round(fraction * 10_000));
      let threshold = (target * fractionBp) / 10_000n;
      // The refill threshold must cover the immediate publish's floor too —
      // refilling below it would just let the next publish revert with
      // `TooLowAllowance` again.
      if (threshold < publishFloor) threshold = publishFloor;
      return { needsApprove: currentAllowance < threshold, targetAllowance: target };
    }
    case 'per-publish':
    default: {
      // Approve exactly the publish floor. Matches the legacy bounded-
      // per-publish behaviour (with the 1n on-chain minimum closing the
      // gap that previously bricked zero-cost publishes).
      return {
        needsApprove: currentAllowance < publishFloor,
        targetAllowance: publishFloor,
      };
    }
  }
}
