import React from 'react';

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
    toneClass: 'badge-warn',
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
