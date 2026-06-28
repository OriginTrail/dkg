import React from 'react';
import { useAgentsStore } from '../../stores/agents.js';
import { useTabsStore } from '../../stores/tabs.js';
import { usePcaOverview } from '../../hooks/usePcaOverview.js';

function pct(bps: number | null): string {
  if (bps == null) return '—';
  const p = bps / 100;
  return `${p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
}

/**
 * Dashboard "Wallets and Spending" → "Publishing discount" row (UX §3.2) — the
 * primary benefit-framed discovery surface. Driven from the SAME `usePcaOverview`
 * summary as S1 (no phantom backend field), and labelled "pending confirmation"
 * (#9 — no B8 confirmation yet). The CTA opens the conviction tab.
 */
export function PcaDashboardRow() {
  const role = useAgentsStore((s) => (s.nodeStatus as { nodeRole?: string } | null)?.nodeRole);
  const openTab = useTabsStore((s) => s.openTab);
  const { covered, bestCoveringDiscountBps, walletsInconclusive } = usePcaOverview();

  return (
    <div className="v10-ws-pca">
      <span className="v10-ws-pca-label">Publishing discount</span>
      <span className="v10-ws-pca-value" data-covered={covered}>
        {/* T2/#9 — don't assert "None" off unreadable wallets. */}
        {walletsInconclusive
          ? 'Couldn’t verify your wallets — retry'
          : covered
            ? `${pct(bestCoveringDiscountBps)} (pending confirmation)`
            : 'None — publishing at the direct cost'}
      </span>
      <button
        type="button"
        className="v10-ws-pca-cta"
        onClick={() => openTab({ id: 'conviction', label: 'Publishing Conviction', closable: true })}
      >
        {role === 'edge' ? 'Get sponsored' : 'Set up conviction account'} →
      </button>
    </div>
  );
}
