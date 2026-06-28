import React from 'react';
import type { PcaSnapshot } from '../../api.js';

/**
 * The health states a PCA can be in (S1/S3 `HealthChip`). Each maps to a
 * DISTINCT glyph (not colour-only) and a text label that is NEVER dropped — the
 * label is the accessible name, the glyph is decorative (`aria-hidden`).
 */
export type PcaHealthState =
  | 'healthy'
  | 'expiring'
  | 'expired'
  | 'insolvent'
  | 'swept'
  | 'cap-near';

interface HealthMeta {
  glyph: string;
  label: string;
  /** Badge tone class from `12-observability.css`. */
  toneClass: string;
  /** Longer advisory shown on hover (`title`). */
  hint: string;
}

export const HEALTH_CHIP_META: Record<PcaHealthState, HealthMeta> = {
  healthy: {
    glyph: '✓',
    label: 'Healthy',
    toneClass: 'badge-success',
    hint: 'Active, solvent, and not expiring soon.',
  },
  expiring: {
    glyph: '⏳',
    label: 'Expiring soon',
    toneClass: 'badge-warn',
    hint: 'The lock period ends soon — top-up does NOT extend it; renew to keep the discount.',
  },
  expired: {
    glyph: '✕',
    label: 'Expired',
    toneClass: 'badge-error',
    hint: 'The lock period has ended — publishes no longer get this discount. Renew to continue.',
  },
  insolvent: {
    glyph: '⚠',
    label: 'Insolvent',
    // Danger tone (§6.4 / G5): insolvency is more severe than the warn-tone
    // Expiring-soon / Cap-near states — a depleted buffer means publishes pay
    // the direct cost (or fail). Distinct from those amber states.
    toneClass: 'badge-error',
    hint: 'The spendable buffer is depleted — publishes will quietly pay the direct cost. Top up.',
  },
  swept: {
    glyph: '⊘',
    label: 'Fully swept',
    toneClass: 'badge',
    hint: 'Every epoch budget has been swept to the staker reward pool.',
  },
  'cap-near': {
    glyph: '⚠',
    label: 'Cap near 100',
    toneClass: 'badge-warn',
    hint: 'Approaching the 100 approved-publishing-wallet cap.',
  },
};

/** Approved-wallet count at which a PCA is flagged "Cap near 100". */
export const PCA_CAP_NEAR_THRESHOLD = 90;
/** Window (seconds) before expiry at which a PCA is flagged "Expiring soon" (7 days). */
export const PCA_EXPIRING_SOON_SECONDS = 7 * 24 * 60 * 60;

/**
 * The SINGLE source of truth for deriving a PCA's `HealthChip` state from its
 * snapshot — used by S1/S3/S5 so the derivation can't drift across screens.
 * Precedence (highest first), per the lead's contract:
 *   expired → swept → cap-near → expiring → healthy.
 *
 * `insolvent` is intentionally NOT derived in P0: accurate insolvency needs the
 * current-epoch `remainingAllowance` (GAP-4/5 extended snapshot), which the P0
 * snapshot doesn't carry — asserting it from P0 data would be a false claim
 * (invariant #9). The `insolvent` STATE still exists for the P2 budget widget.
 */
export function healthForSnapshot(
  snapshot: Pick<PcaSnapshot, 'expiresAtTimestamp' | 'fullySwept' | 'agentCount'>,
  nowSec: number = Math.floor(Date.now() / 1000),
): PcaHealthState {
  const { expiresAtTimestamp, fullySwept, agentCount } = snapshot;
  const hasExpiry = typeof expiresAtTimestamp === 'number' && expiresAtTimestamp > 0;
  if (hasExpiry && nowSec >= expiresAtTimestamp) return 'expired';
  if (fullySwept) return 'swept';
  if (typeof agentCount === 'number' && agentCount >= PCA_CAP_NEAR_THRESHOLD) return 'cap-near';
  if (hasExpiry && expiresAtTimestamp - nowSec <= PCA_EXPIRING_SOON_SECONDS) return 'expiring';
  return 'healthy';
}

/**
 * A status pill for a PCA's health. The text label always renders (the
 * accessible name); the glyph is decorative. `label` overrides the default copy
 * (e.g. to append a wall-clock "in ~12 days").
 */
export function HealthChip({
  state,
  label,
  className = '',
}: {
  state: PcaHealthState;
  label?: string;
  className?: string;
}) {
  const meta = HEALTH_CHIP_META[state];
  const text = label ?? meta.label;
  // Dedupe tokens — the `swept` neutral tone reuses the base `.badge` class, so
  // a naive join would emit "badge badge".
  const classes = [...new Set(['badge', meta.toneClass, 'v10-pca-health-chip', className])]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={classes}
      data-health={state}
      title={meta.hint}
    >
      <span className="v10-pca-health-glyph" aria-hidden="true">
        {meta.glyph}
      </span>
      <span className="v10-pca-health-label">{text}</span>
    </span>
  );
}
