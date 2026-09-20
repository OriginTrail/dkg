// SPDX-License-Identifier: Apache-2.0

/**
 * V10 publish/update TRAC-allowance sizing extracted from evm-adapter.ts:
 * the on-chain minimum floor (`effectivePublishAllowance`) and the
 * per-policy approval decision (`computeApprovalAction`). Bodies are a
 * 1:1 move from the original module.
 */
import {
  DEFAULT_REPLENISH_TARGET_MULTIPLE,
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
 * Normalizes `ApprovalPolicy.targetAllowanceMultiple` for the relative
 * `replenishing` ceiling. Legal values are integers >= 1.
 *
 * Operator-supplied values are rejected loudly one layer up, in
 * `resolveApprovalPolicy` (CLI config), matching how `finalityConfirmations`
 * and `refillBelowFraction` fail fast at startup. This function is the
 * in-adapter backstop for programmatic callers that construct an
 * `ApprovalPolicy` directly, and follows this module's existing convention
 * for those (`clampApprovalFraction`): normalize, never throw — an approval
 * decision on the publish hot path must not become a new failure mode.
 *
 * A multiple below 1 is the interesting case: it would put the ceiling
 * under the publish floor on *every* call, so the floor clamp would fire
 * every time and `replenishing` would silently degrade into `per-publish`.
 * Falling back to the default keeps the configured mode meaningful.
 */
function normalizeApprovalMultiple(value: number | undefined): bigint {
  if (value === undefined) return BigInt(DEFAULT_REPLENISH_TARGET_MULTIPLE);
  if (!Number.isSafeInteger(value) || value < 1) {
    return BigInt(DEFAULT_REPLENISH_TARGET_MULTIPLE);
  }
  return BigInt(value);
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
 *     existing allowance never flips a `false` to `true`. Both the target
 *     and the refill threshold are functions of `(policy, tokenAmount)`
 *     alone; `currentAllowance` enters only through the final `<`.
 *
 * ## `replenishing` sizing, and what the defaults mean
 *
 * With no absolute `targetAllowance`, the ceiling is relative to the
 * publish that triggered the refill:
 *
 *     C         = effectivePublishAllowance(tokenAmount)   // this publish
 *     target    = C × targetAllowanceMultiple              // default 20×
 *     threshold = max(target × refillBelowFraction, C)     // default 2×C
 *
 * Approve to `20 × C`, then skip the approve until the standing allowance
 * falls under `2 × C`. For a node whose publishes all cost about `C`, the
 * allowance walks `20C, 19C, … , 2C` and only the next one re-approves:
 * **one approve per 19 publishes** (generally `multiple × (1 - fraction)
 * + 1`). That ratio is scale-free — it holds at any publish price, which
 * is the point of sizing relatively rather than flat.
 *
 * ## Honest limits when publish costs vary
 *
 * Nothing here is persisted: `target` and `threshold` are recomputed from
 * whatever *this* publish costs. Only the on-chain allowance carries over.
 * So the standing exposure is set by the most expensive recent publish,
 * not by the typical one, and two cases behave worse than a flat ceiling:
 *
 *   - **One outlier publish raises the ceiling.** A publish costing 100×
 *     the node's usual price approves `20 × 100C = 2000C` and the node
 *     then coasts on that allowance across many ordinary publishes. A
 *     flat `targetAllowance` bounds exposure by an absolute number no
 *     matter what gets published; this does not. Operators who need a
 *     hard TRAC cap should set `targetAllowance` — it overrides the
 *     multiple precisely so that bound stays available.
 *   - **An unusually cheap publish lowers it.** A publish at `C/100`
 *     approves only `20C/100`, and the next ordinary publish sees a
 *     standing allowance under its own `2C` threshold and re-approves.
 *     A node whose costs spread wider than `multiple × fraction` (10× at
 *     the defaults) therefore drifts back toward `per-publish` gas. It
 *     self-corrects — the next ordinary publish re-establishes `20C` —
 *     and it never bricks a publish, because the floor clamp still lifts
 *     the target to `C`. It just stops amortising.
 *
 * Relative sizing is the better default for a node with a stable price
 * profile, and it removes the "1000 TRAC is wrong for my volume" problem
 * in both directions. It is not uniformly better than a flat ceiling: a
 * wide cost spread costs gas, and an outlier costs blast radius.
 *
 * See {@link ApprovalPolicy} in `chain-adapter.ts` for the mode
 * semantics; see `evm-adapter.unit.test.ts` for the pinned-down behaviour
 * under every combination of `(mode, tokenAmount, currentAllowance,
 * targetAllowanceMultiple)`.
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
      // Approve a ceiling once, then refill when current drops below
      // `target × fraction`.
      //
      // Precedence: an ABSOLUTE `targetAllowance` wins over the relative
      // `targetAllowanceMultiple`. An operator who wrote a TRAC number
      // meant that number, it is the only way to cap standing exposure
      // absolutely, and honouring it keeps every pre-existing config
      // behaving exactly as it did before relative sizing existed.
      // The multiple is the DEFAULT sizing, not an override.
      const multiple = normalizeApprovalMultiple(policy.targetAllowanceMultiple);
      // `publishFloor >= 1n` and `multiple >= 1n`, so the derived target is
      // itself always >= publishFloor — the clamp below is load-bearing only
      // for an explicit too-low `targetAllowance`. Zero-cost publish: floor
      // 1n × 20 = 20n wei-TRAC, dust, and the threshold is 2n, so a
      // zero-cost chain approves once and never again (allowance never
      // decreases). Strictly fewer approves than `per-publish` there.
      const requestedTarget = policy.targetAllowance ?? publishFloor * multiple;
      // Raise the target to at least the publish floor so a misconfigured
      // low `targetAllowance` doesn't brick the publish — the bigger of
      // (operator's intent, what we need right now).
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
