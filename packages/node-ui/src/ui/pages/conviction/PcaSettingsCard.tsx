import React from 'react';
import { useTabsStore } from '../../stores/tabs.js';
import { usePcaOverview } from '../../hooks/usePcaOverview.js';

function pct(bps: number | null): string {
  if (bps == null) return '—';
  const p = bps / 100;
  return `${p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
}

/**
 * Settings → "Publishing Conviction" card (UX §3.2), inserted after Blockchain
 * Config. Driven from the SAME tracked-set summary as S1 (not a phantom backend
 * "current tier"); an operator auditing wallets/RPC is in the right mindset to
 * check their publishing discount.
 */
export function PcaSettingsCard() {
  const openTab = useTabsStore((s) => s.openTab);
  const { accounts, covered, bestCoveringDiscountBps } = usePcaOverview();
  const tracked = accounts.length;

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">Publishing Conviction</h2>
      </div>
      <div className="card-body">
        {tracked === 0 ? (
          <p className="v10-pca-settings-line">No tracked Publishing Conviction Account on this node.</p>
        ) : covered ? (
          <p className="v10-pca-settings-line">
            This node’s publishes get up to <strong>{pct(bestCoveringDiscountBps)}</strong> off
            (pending confirmation).
          </p>
        ) : (
          <p className="v10-pca-settings-line">
            Tracking {tracked} account{tracked === 1 ? '' : 's'}, but none currently covers this
            node’s publishes.
          </p>
        )}
        <button
          type="button"
          className="v10-pca-card-btn"
          onClick={() => openTab({ id: 'conviction', label: 'Publishing Conviction', closable: true })}
        >
          Manage publishing conviction →
        </button>
      </div>
    </section>
  );
}
