import React from 'react';
// #1355 V2 — health derivation lives in the domain module `pca/health.ts`; this
// presentation file only consumes `PcaHealthState` for its pill (every other consumer
// imports the derivation directly from `pca/health.js`, so no re-export here).
import { type PcaHealthState } from '../../pca/health.js';
import { Badge, type BadgeTone, StatusGlyph } from '../ds/Badge.js';

interface HealthMeta {
  glyph: React.ReactNode;
  label: string;
  tone: BadgeTone;
  /** Longer advisory shown on hover (`title`). */
  hint: string;
}

export const HEALTH_CHIP_META: Record<PcaHealthState, HealthMeta> = {
  healthy: {
    glyph: <StatusGlyph tone="success" />,
    label: 'Healthy',
    tone: 'success',
    hint: 'Active, solvent, and not expiring soon.',
  },
  expiring: {
    glyph: <StatusGlyph tone="pending" />,
    label: 'Expiring soon',
    tone: 'warning',
    hint: 'This PCA ends soon. Topping up doesn’t make it last longer. Renew to keep the discount.',
  },
  expired: {
    glyph: <StatusGlyph tone="danger" />,
    label: 'Expired',
    tone: 'danger',
    hint: 'This PCA has ended, so publishes no longer get its discount. Renew to continue.',
  },
  insolvent: {
    glyph: <StatusGlyph tone="warning" />,
    label: 'Insolvent',
    // Danger tone (§6.4 / G5): insolvency is more severe than the warn-tone
    // Expiring-soon / Cap-near states — a depleted buffer means publishes pay
    // the direct cost (or fail). Distinct from those amber states.
    tone: 'danger',
    hint: 'The spendable buffer has run out, so publishes pay the full fee, without warning. Top up.',
  },
  'cap-near': {
    glyph: <StatusGlyph tone="warning" />,
    label: 'Cap near 100',
    tone: 'warning',
    hint: 'Close to the limit of 100 approved publishing wallets.',
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
  return (
    <Badge
      tone={meta.tone}
      size="sm"
      icon={<span className="v10-pca-health-glyph" aria-hidden="true">{meta.glyph}</span>}
      className={['v10-pca-health-chip', className].filter(Boolean).join(' ')}
      data-testid="pca-health-chip"
      data-health={state}
      title={meta.hint}
    >
      <span className="v10-pca-health-label">{text}</span>
    </Badge>
  );
}
