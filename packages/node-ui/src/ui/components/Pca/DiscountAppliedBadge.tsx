import React from 'react';
// B8 — the CostCovered wire type now lives at the api boundary (api.ts); re-export it
// here so existing `components/Pca` importers (the barrel + mocks) keep resolving it.
import type { ConvictionCostCovered } from '../../api.js';
export type { ConvictionCostCovered };

/**
 * The CONFIRMED discount in basis points, derived from the event (the bps
 * isn't in the event itself): `10000 · (baseCost − discountedCost) / baseCost`.
 * BigInt math (uint96 wei can exceed `Number.MAX_SAFE_INTEGER`). Returns `null`
 * when the costs are missing/zero/un-parseable OR when there is NO actual discount
 * (`discounted >= base`) — a genuine 0% draw is reachable on-chain (the contract
 * floors discountedCost back to baseCost, and discountBps==0 accounts exist), and
 * must NOT render a bogus "−0%"/"saved 0" claim (#9). Only a POSITIVE discount returns.
 */
export function convictionDiscountBps(covered: ConvictionCostCovered | null | undefined): number | null {
  if (!covered) return null;
  let base: bigint;
  let discounted: bigint;
  try {
    base = BigInt(covered.baseCost);
    discounted = BigInt(covered.discountedCost);
  } catch {
    return null;
  }
  // `discounted >= base` (not `>`) → a 0% draw resolves to null, so the badge hides
  // and the bell row drops the −%/saved rather than claiming a discount that isn't.
  if (base <= 0n || discounted < 0n || discounted >= base) return null;
  // Round to nearest bps.
  return Number(((base - discounted) * 10000n + base / 2n) / base);
}

/**
 * Renders the CONFIRMED post-publish discount badge — invariant #9: this is the
 * confirmed CostCovered signal, distinct from S5's pre-spend eligibility tier.
 *
 * P0 has no B8 propagation yet, so `convictionCostCovered` is always absent and
 * this component renders **nothing** (degrade-to-hidden) — it must NEVER assert
 * a discount the backend hasn't confirmed. It lights up automatically once the
 * publish response carries the field.
 */
export function DiscountAppliedBadge({
  convictionCostCovered,
  className = '',
}: {
  convictionCostCovered?: ConvictionCostCovered | null;
  className?: string;
}) {
  const bps = convictionDiscountBps(convictionCostCovered);
  if (convictionCostCovered == null || bps == null) return null;
  const pct = (bps / 100).toFixed(bps % 100 === 0 ? 0 : 1);
  const attribution = convictionCostCovered.accountId
    ? `via PCA #${convictionCostCovered.accountId}`
    : 'across multiple PCAs';
  return (
    <span
      className={['badge', 'badge-success', 'v10-pca-discount-applied', className]
        .filter(Boolean)
        .join(' ')}
      data-testid="pca-discount-badge"
      role="status"
    >
      <span aria-hidden="true">◉ </span>
      Discount applied — −{pct}% {attribution}
    </span>
  );
}
