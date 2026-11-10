import React from 'react';
import { ArrowRight } from 'lucide-react';
import { useAgentsStore } from '../../stores/agents.js';
import { chooseTab as openTab } from '../../lib/shellNavigation.js';
import { usePcaOverview } from '../../hooks/usePcaOverview.js';
import { usePcaScopeBootstrap } from '../../hooks/usePcaScopeBootstrap.js';
import { formatBps } from '../../lib/format.js';

function pct(bps: number | null): string {
  if (bps == null) return '—';
  return formatBps(bps);
}

/**
 * Dashboard "Wallets and Spending" → "Publishing discount" row (UX §3.2) — the
 * primary benefit-framed discovery surface. Driven from the SAME `usePcaOverview`
 * summary as S1 (no phantom backend field). The CTA opens the conviction tab.
 */
export function PcaDashboardRow() {
  usePcaScopeBootstrap();
  const role = useAgentsStore((s) => (s.nodeStatus as { nodeRole?: string } | null)?.nodeRole);
  const { covered, bestCoveringDiscountBps, walletsInconclusive } = usePcaOverview();

  return (
    <div className="v10-ws-pca">
      <span className="v10-ws-pca-label">Publishing discount</span>
      <span className="v10-ws-pca-value" data-covered={covered}>
        {/* T2/#9 — don't assert "None" off unreadable wallets. */}
        {walletsInconclusive
          ? 'Couldn’t verify your wallets — retry'
          : covered
            ? `${pct(bestCoveringDiscountBps)} discount`
            : 'None — publishing at the direct cost'}
      </span>
      <button
        type="button"
        className="v10-ws-pca-cta ds-btn ds-sm"
        onClick={() => openTab({ id: 'conviction', label: 'Publisher Conviction', closable: true })}
      >
        {role === 'edge' ? 'Get added to a PCA' : 'Set up PCA'}<ArrowRight size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
