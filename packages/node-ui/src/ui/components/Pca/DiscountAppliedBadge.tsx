import React from 'react';

/**
 * The post-publish CostCovered signal (B8). Decoded from the on-chain
 * `CostCovered(accountId, epoch, baseCost, discountedCost, drawnFromEpoch,
 * drawnFromTopUp)` event. Wei amounts are decimal strings.
 */
export interface ConvictionCostCovered {
  accountId: string;
  epoch: number;
  baseCost: string;
  discountedCost: string;
  drawnFromEpoch: string;
  drawnFromTopUp: string;
}

/**
 * The CONFIRMED discount in basis points, derived from the event (the bps
 * isn't in the event itself): `10000 · (baseCost − discountedCost) / baseCost`.
 * BigInt math (uint96 wei can exceed `Number.MAX_SAFE_INTEGER`). Returns `null`
 * when the costs are missing/zero/un-parseable so the caller can hide rather
 * than assert a bogus 0%.
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
  if (base <= 0n || discounted < 0n || discounted > base) return null;
  // Round to nearest bps.
  return Number(((base - discounted) * 10000n + base / 2n) / base);
}

/**
 * Renders the CONFIRMED post-publish discount badge — invariant #9: this is the
 * confirmed signal, distinct from S5's "pending confirmation" PREDICTION.
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
  return (
    <span
      className={['badge', 'badge-success', 'v10-pca-discount-applied', className]
        .filter(Boolean)
        .join(' ')}
      data-testid="pca-discount-badge"
      role="status"
    >
      <span aria-hidden="true">◉ </span>
      Discount applied — −{pct}% via PCA #{convictionCostCovered.accountId}
    </span>
  );
}
