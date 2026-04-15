import React from 'react';
import type { TrustLevel } from '../../hooks/useMemoryEntities.js';

const TRUST_META: Record<TrustLevel, { label: string; abbr: string; icon: string; className: string }> = {
  verified: { label: 'Verified Memory', abbr: 'VM', icon: '◉', className: 'trust-verified' },
  shared:   { label: 'Shared Working Memory', abbr: 'SWM', icon: '◈', className: 'trust-shared' },
  working:  { label: 'Working Memory', abbr: 'WM', icon: '◇', className: 'trust-working' },
};

export function TrustBadge({ level, showLabel }: { level: TrustLevel; showLabel?: boolean }) {
  const meta = TRUST_META[level];
  return (
    <span className={`v10-trust-badge ${meta.className}`} title={meta.label}>
      <span className="v10-trust-badge-icon">{meta.icon}</span>
      {showLabel && <span className="v10-trust-badge-label">{meta.abbr}</span>}
    </span>
  );
}

export function TrustRing({ level }: { level: TrustLevel }) {
  const meta = TRUST_META[level];
  return (
    <span className={`v10-trust-ring ${meta.className}`} title={meta.label}>
      {meta.icon}
    </span>
  );
}

export function TrustSummaryBar({ counts }: { counts: { wm: number; swm: number; vm: number; total: number } }) {
  const total = counts.wm + counts.swm + counts.vm;
  if (total === 0) return null;

  const wmPct = (counts.wm / total) * 100;
  const swmPct = (counts.swm / total) * 100;
  const vmPct = (counts.vm / total) * 100;

  return (
    <div className="v10-trust-summary">
      <div className="v10-trust-summary-bar">
        {counts.wm > 0 && <div className="v10-trust-bar-seg trust-working" style={{ width: `${wmPct}%` }} />}
        {counts.swm > 0 && <div className="v10-trust-bar-seg trust-shared" style={{ width: `${swmPct}%` }} />}
        {counts.vm > 0 && <div className="v10-trust-bar-seg trust-verified" style={{ width: `${vmPct}%` }} />}
      </div>
      <div className="v10-trust-summary-labels">
        <span className="v10-trust-summary-item trust-working">
          <span className="v10-trust-summary-dot" />
          {counts.wm} draft{counts.wm !== 1 ? 's' : ''}
        </span>
        <span className="v10-trust-summary-item trust-shared">
          <span className="v10-trust-summary-dot" />
          {counts.swm} shared
        </span>
        <span className="v10-trust-summary-item trust-verified">
          <span className="v10-trust-summary-dot" />
          {counts.vm} verified
        </span>
      </div>
    </div>
  );
}
