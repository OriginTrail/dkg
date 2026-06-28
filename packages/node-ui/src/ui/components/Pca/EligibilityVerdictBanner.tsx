import React from 'react';
import type { ReactNode } from 'react';

/**
 * The tri-state publish-eligibility verdict (UX §5.5). NEUTRAL is a real third
 * state — "can't confirm" — and must NEVER render as green (P2: fail toward
 * warning).
 */
export type PcaVerdict = 'eligible' | 'fallthrough' | 'unknown';

function pctLabel(bps?: number): string | null {
  if (typeof bps !== 'number' || !Number.isFinite(bps) || bps <= 0) return null;
  const p = bps / 100;
  return `${p.toFixed(p % 1 === 0 ? 0 : 1)}%`;
}

const VERDICT_META: Record<PcaVerdict, { glyph: string; toneClass: string; chipText: string }> = {
  eligible: { glyph: '◉', toneClass: 'v10-pca-verdict-green', chipText: 'Funded by' },
  fallthrough: { glyph: '⚠', toneClass: 'v10-pca-verdict-amber', chipText: 'No PCA discount' },
  unknown: { glyph: '◌', toneClass: 'v10-pca-verdict-neutral', chipText: 'PCA status unknown' },
};

/**
 * Green/amber/neutral publish verdict, as a full banner or the condensed chip
 * that sits on the publish CTA. Accessibility contract: amber is `role="alert"`
 * / assertive (the fall-through must be impossible to miss); green and neutral
 * are `role="status"` / polite. The state is always conveyed as TEXT, never
 * colour alone.
 *
 * Invariants enforced here:
 *  - #4 the escrow caveat appears ONLY on owner-publishes (`ownerPublish`);
 *    sponsored/edge verdicts are definitive.
 *  - #9 a green verdict is a PREDICTION — callers label the post-publish line
 *    "pending confirmation" until B8 confirms (this component states the
 *    pre-spend verdict only; it never claims a confirmed discount).
 */
export function EligibilityVerdictBanner({
  verdict,
  accountId,
  discountBps,
  reasons = [],
  ownerPublish = false,
  variant = 'banner',
  onWhy,
  whyExpanded = false,
  controlsId,
  children,
  className = '',
}: {
  verdict: PcaVerdict;
  accountId?: string;
  discountBps?: number;
  /** Failed conditions, shown in the amber banner ("Reason: …"). */
  reasons?: string[];
  /** #4 — when true (you own the target CG), append the escrow caveat. */
  ownerPublish?: boolean;
  variant?: 'banner' | 'chip';
  /** Chip "why?" disclosure → opens the full S5 popover. */
  onWhy?: () => void;
  whyExpanded?: boolean;
  controlsId?: string;
  /** Banner-only fix-it links / extra content. */
  children?: ReactNode;
  className?: string;
}) {
  const meta = VERDICT_META[verdict];
  const isAmber = verdict === 'fallthrough';
  const role = isAmber ? 'alert' : 'status';
  const ariaLive = isAmber ? 'assertive' : 'polite';
  const pcaLabel = accountId ? `PCA #${accountId}` : 'a conviction account';
  const disc = pctLabel(discountBps);
  const escrowCaveat = ' unless this graph’s registration escrow already covers it';

  if (variant === 'chip') {
    const chipLabel =
      verdict === 'eligible'
        ? `Funded by ${pcaLabel}${disc ? ` (−${disc})` : ''}`
        : verdict === 'fallthrough'
          ? '⚠ No PCA discount'
          : 'PCA status unknown';
    return (
      <span
        className={['v10-pca-verdict-chip', meta.toneClass, className].filter(Boolean).join(' ')}
        data-verdict={verdict}
      >
        <span className="v10-pca-verdict-chip-label" role={role} aria-live={ariaLive}>
          {chipLabel}
        </span>
        {onWhy && (
          <button
            type="button"
            className="v10-pca-verdict-why"
            onClick={onWhy}
            aria-expanded={whyExpanded}
            {...(controlsId ? { 'aria-controls': controlsId } : {})}
          >
            why?
          </button>
        )}
      </span>
    );
  }

  let message: ReactNode;
  if (verdict === 'eligible') {
    message = (
      <>
        This publish will use {pcaLabel}
        {disc ? ` (−${disc})` : ''}.{ownerPublish ? `${escrowCaveat}.` : ''}
      </>
    );
  } else if (verdict === 'fallthrough') {
    const reasonText = reasons.length > 0 ? ` Reason: ${reasons.join('; ')}.` : '';
    message = (
      <>
        No PCA discount on this publish — it will pay the direct cost (TRAC from the signing wallet)
        {ownerPublish ? escrowCaveat : ''}.{reasonText}
      </>
    );
  } else {
    message = <>Couldn’t confirm PCA eligibility — you may pay the direct cost.</>;
  }

  return (
    <div
      className={['v10-pca-verdict-banner', meta.toneClass, className].filter(Boolean).join(' ')}
      data-verdict={verdict}
      role={role}
      aria-live={ariaLive}
    >
      <p className="v10-pca-verdict-message">
        <span className="v10-pca-verdict-glyph" aria-hidden="true">
          {meta.glyph}
        </span>
        {message}
      </p>
      {children && <div className="v10-pca-verdict-actions">{children}</div>}
    </div>
  );
}
