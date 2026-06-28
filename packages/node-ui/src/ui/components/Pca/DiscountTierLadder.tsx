import React from 'react';

/**
 * The PCA discount tiers (research §2). `minTrac` is the inclusive commitment
 * floor for the tier; `bps` is the discount in basis points. Labels are baked
 * in (rather than `toLocaleString`) so rendering is deterministic across locales
 * — `toLocaleString` would render "1,000" vs "1.000" by locale and flake CI.
 */
export interface PcaDiscountTier {
  minTrac: number;
  bps: number;
  tracLabel: string;
  pctLabel: string;
}

export const PCA_DISCOUNT_TIERS: PcaDiscountTier[] = [
  { minTrac: 0, bps: 0, tracLabel: '< 25,000 TRAC', pctLabel: '0%' },
  { minTrac: 25_000, bps: 1000, tracLabel: '25,000 TRAC', pctLabel: '10%' },
  { minTrac: 50_000, bps: 2000, tracLabel: '50,000 TRAC', pctLabel: '20%' },
  { minTrac: 100_000, bps: 3000, tracLabel: '100,000 TRAC', pctLabel: '30%' },
  { minTrac: 250_000, bps: 4000, tracLabel: '250,000 TRAC', pctLabel: '40%' },
  { minTrac: 500_000, bps: 5000, tracLabel: '500,000 TRAC', pctLabel: '50%' },
  { minTrac: 1_000_000, bps: 7500, tracLabel: '1,000,000+ TRAC', pctLabel: '75%' },
];

/**
 * The tier a given committed TRAC amount lands in: the highest tier whose
 * `minTrac` floor it meets. Pure — drives the S2 live preview and the ladder
 * highlight. `null`/negative resolves to the 0% tier.
 */
export function discountTierForTrac(trac: number | null | undefined): PcaDiscountTier {
  const value = typeof trac === 'number' && Number.isFinite(trac) ? trac : 0;
  let tier = PCA_DISCOUNT_TIERS[0]!;
  for (const t of PCA_DISCOUNT_TIERS) {
    if (value >= t.minTrac) tier = t;
  }
  return tier;
}

/**
 * The discount tiers rendered as a live-highlighting ladder. Labelled
 * "estimated — confirmed on-chain at creation" because the real `discountBps`
 * is only known after the create receipt. Deliberately NOT an aria-live region
 * (per-keystroke updates would spam a screen reader — UX §5.2 step 2).
 */
export function DiscountTierLadder({
  committedTrac,
  caption = 'Estimated — confirmed on-chain at creation.',
  className = '',
}: {
  committedTrac?: number | null;
  caption?: React.ReactNode;
  className?: string;
}) {
  const active =
    committedTrac == null ? null : discountTierForTrac(committedTrac);

  return (
    <div className={['v10-pca-tier-ladder', className].filter(Boolean).join(' ')} data-testid="pca-tier-ladder">
      <ul className="v10-pca-tier-list" role="list">
        {PCA_DISCOUNT_TIERS.map((tier) => {
          const isActive = active != null && active.minTrac === tier.minTrac;
          return (
            <li
              key={tier.minTrac}
              className={['v10-pca-tier-row', isActive ? 'active' : ''].filter(Boolean).join(' ')}
              data-bps={tier.bps}
              {...(isActive ? { 'aria-current': 'true' as const } : {})}
            >
              <span className="v10-pca-tier-trac">{tier.tracLabel}</span>
              <span className="v10-pca-tier-pct">{tier.pctLabel}</span>
            </li>
          );
        })}
      </ul>
      {caption != null && <p className="v10-pca-tier-caption">{caption}</p>}
    </div>
  );
}
