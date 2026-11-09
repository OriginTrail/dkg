import React from 'react';
import { ArrowRight } from 'lucide-react';
import { RetryButton } from '../../components/Pca/RetryButton.js';
import { useAgentsStore } from '../../stores/agents.js';
import { useTabsStore } from '../../stores/tabs.js';
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
  const openTab = useTabsStore((s) => s.openTab);
  const { covered, bestCoveringDiscountBps, walletsInconclusive, refresh } = usePcaOverview();

  return (
    <div className="v10-ws-pca">
      <span className="v10-ws-pca-label">Publishing discount</span>
      <span className="v10-ws-pca-value" data-covered={covered}>
        {/* T2/#9 — don't assert "None" off unreadable wallets. */}
        {walletsInconclusive
          ? 'Couldn’t check your wallets'
          : covered
            ? pct(bestCoveringDiscountBps)
            : 'None. Publishing pays the full fee'}
      </span>
      {/* Coverage is unknown, so offer the re-read rather than a way to get a PCA. */}
      {walletsInconclusive ? (
        <RetryButton className="v10-ws-pca-cta" onClick={() => refresh()} />
      ) : (
        <button
          type="button"
          className="v10-ws-pca-cta ds-btn ds-sm"
          onClick={() => openTab({ id: 'conviction', label: 'Publisher Conviction', closable: true })}
        >
          {covered ? 'Manage PCA' : role === 'edge' ? 'Get added to a PCA' : 'Set up PCA'}<ArrowRight size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
