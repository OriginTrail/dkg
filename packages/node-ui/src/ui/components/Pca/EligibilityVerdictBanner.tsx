import React from 'react';
import type { ReactNode } from 'react';

/**
 * The publish-eligibility verdict (UX §5.5, expanded by invariant #6). FOUR
 * states — the proposal's "tri-state" splits once the fail-open TRAC check is
 * folded in:
 *  - `eligible`            GREEN   — a PCA discount will apply.
 *  - `fallthrough`         AMBER   — no discount, but the signing wallet HAS
 *                                    TRAC, so the publish pays the direct cost
 *                                    (non-blocking).
 *  - `fallthrough-no-funds` DANGER — NO wallet can fund the publish → it will
 *                                    FAIL. (#6)
 *  - `unknown`            NEUTRAL  — can't confirm; must NEVER render as green
 *                                    (P2: fail toward warning).
 *
 * The Batch E (S5) preflight computes which state applies. Post-#1327 the signer
 * selection is FUNDING-AWARE — it picks ONE authorized wallet that can pay (PCA-
 * covered OR own-TRAC, + gas) and skips the rest — so DANGER ("will FAIL") fires
 * only when NO wallet can fund the publish; a single uncovered/no-TRAC spare does
 * not. GREEN stays strict (every signing wallet covered).
 */
export type PcaVerdict = 'eligible' | 'fallthrough' | 'fallthrough-no-funds' | 'unknown';

function pctLabel(bps?: number): string | null {
  if (typeof bps !== 'number' || !Number.isFinite(bps) || bps <= 0) return null;
  const p = bps / 100;
  return `${p.toFixed(p % 1 === 0 ? 0 : 1)}%`;
}

const VERDICT_META: Record<PcaVerdict, { glyph: string; toneClass: string }> = {
  eligible: { glyph: '◉', toneClass: 'v10-pca-verdict-green' },
  fallthrough: { glyph: '⚠', toneClass: 'v10-pca-verdict-amber' },
  'fallthrough-no-funds': { glyph: '⚠', toneClass: 'v10-pca-verdict-danger' },
  unknown: { glyph: '◌', toneClass: 'v10-pca-verdict-neutral' },
};

/**
 * The verdict as a full banner or the condensed chip that sits on the publish
 * CTA. Accessibility contract (§6.3): the two LOUD states (amber fall-through,
 * danger will-fail) are `role="alert"` / assertive — they must be impossible to
 * miss; green and neutral are `role="status"` / polite. The state is always
 * conveyed as TEXT, never colour alone.
 *
 * Invariants enforced here:
 *  - #4 the escrow caveat appears ONLY on owner-publishes (`ownerPublish`);
 *    sponsored/edge verdicts are definitive.
 *  - #6 the no-TRAC fall-through is DANGER ("will FAIL"), not a soft amber.
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
  /** Failed conditions, shown in the amber/danger banner ("Reason: …"). */
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
  // The two loud states get an assertive alert; green/neutral are polite.
  const isLoud = verdict === 'fallthrough' || verdict === 'fallthrough-no-funds';
  const role = isLoud ? 'alert' : 'status';
  const ariaLive = isLoud ? 'assertive' : 'polite';
  const pcaLabel = accountId ? `PCA #${accountId}` : 'a conviction account';
  const disc = pctLabel(discountBps);
  // The escrow caveat can pre-empt BOTH a fall-through cost and a no-funds
  // failure (escrow pays, not the wallet), so it qualifies amber AND danger on
  // owner-publishes.
  const escrowCaveat = ' unless this graph’s registration escrow already covers it';
  const reasonText = reasons.length > 0 ? ` Reason: ${reasons.join('; ')}.` : '';

  if (variant === 'chip') {
    const chipLabel =
      verdict === 'eligible'
        ? `Funded by ${pcaLabel}${disc ? ` (−${disc})` : ''}`
        : verdict === 'fallthrough'
          ? '⚠ No PCA discount'
          : verdict === 'fallthrough-no-funds'
            ? '⚠ Publish will fail'
            : 'PCA status unknown';
    return (
      <span
        className={['v10-pca-verdict-chip', meta.toneClass, className].filter(Boolean).join(' ')}
        data-testid="pca-eligibility-chip"
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
    message = (
      <>
        {/* P2-interim — the chip can't see the sized per-publish fee (deferred to
            #1351), so don't assert the direct-cost publish WILL succeed; say it
            ATTEMPTS and fails if the wallet's TRAC is below the fee. */}
        No PCA discount on this publish — it will attempt to pay the direct cost from the signing
        wallet’s TRAC
        {/* F9 — name the forfeited discount when it's in context (§5.5 / #5a). */}
        {disc ? `, forfeiting ${pcaLabel}’s −${disc}` : ''}
        {ownerPublish ? escrowCaveat : ''}; the publish fails if that TRAC is below the fee.{reasonText}
      </>
    );
  } else if (verdict === 'fallthrough-no-funds') {
    message = (
      <>
        This publish will FAIL — the signing wallet has no TRAC to cover the direct cost
        {disc ? `, forfeiting ${pcaLabel}’s −${disc}` : ''}
        {ownerPublish ? escrowCaveat : ''}.{reasonText}
      </>
    );
  } else {
    message = <>Couldn’t confirm PCA eligibility — you may pay the direct cost.</>;
  }

  return (
    <div
      className={['v10-pca-verdict-banner', meta.toneClass, className].filter(Boolean).join(' ')}
      data-testid="pca-eligibility-verdict"
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
