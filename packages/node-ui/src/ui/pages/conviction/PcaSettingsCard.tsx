import React from 'react';
import { ArrowRight } from 'lucide-react';
import { useAgentsStore } from '../../stores/agents.js';
import { chooseTab as openTab } from '../../lib/shellNavigation.js';
import { usePcaOverview } from '../../hooks/usePcaOverview.js';
import { usePcaScopeBootstrap } from '../../hooks/usePcaScopeBootstrap.js';
import { RetryButton } from '../../components/ds/RetryButton.js';
import { formatBps } from '../../lib/format.js';
import { PcaPrimerLink } from './PcaPrimer.js';

function pct(bps: number | null): string {
  if (bps == null) return '—';
  return formatBps(bps);
}

/**
 * Settings → "Publisher Conviction" card (UX §3.2), inserted after Blockchain
 * Config. Driven from the SAME tracked-set summary as S1 (not a phantom backend
 * "current tier"); an operator auditing wallets/RPC is in the right mindset to
 * check their publishing discount.
 */
export function PcaSettingsCard() {
  usePcaScopeBootstrap();
  const role = useAgentsStore((s) => (s.nodeStatus as { nodeRole?: string } | null)?.nodeRole);
  const { accounts, covered, bestCoveringDiscountBps, coverage, refresh } = usePcaOverview();
  // Unreadable wallets: coverage can't be confirmed either way (T2/#9).
  const walletsUnreadable = coverage.uncertainty === 'wallets-unreadable';
  const tracked = accounts.length;
  // With no PCA there's nothing to manage, so the button matches the dashboard's.
  const action = tracked === 0 && !covered && !walletsUnreadable
    ? role === 'edge' ? 'Get added to a PCA' : 'Set up PCA'
    : 'Manage PCA';

  return (
    <section className="card ds-card">
      <div className="card-header">
        <h2 className="card-title">Publisher Conviction</h2>
      </div>
      <div className="card-body">
        {covered ? (
          <p className="v10-pca-settings-line">
            This node’s approved publishing wallets get a <strong>{pct(bestCoveringDiscountBps)}</strong> discount
            from a Publisher Conviction Account (PCA).
          </p>
        ) : walletsUnreadable ? (
          // T2/#9 — don't assert "none covers" off unreadable wallets.
          <p className="v10-pca-settings-line" role="status">
            Couldn’t check this node’s wallets, so we can’t confirm a Publisher Conviction Account (PCA) discount.
          </p>
        ) : tracked === 0 ? (
          <p className="v10-pca-settings-line">
            This node has no Publisher Conviction Accounts (PCAs) yet. A PCA gives your publishes a discount of up to 75%.
          </p>
        ) : (
          <p className="v10-pca-settings-line">
            None of the Publisher Conviction Accounts (PCAs) you’ve added ({tracked}) covers this node’s publishes.
          </p>
        )}
        <div className="v10-pca-settings-actions">
          {walletsUnreadable && <RetryButton size="md" onClick={() => refresh()} />}
          <button
            type="button"
            className="v10-pca-card-btn ds-btn"
            onClick={() => openTab({ id: 'conviction', label: 'Publisher Conviction', closable: true })}
          >
            {action}<ArrowRight size={14} aria-hidden="true" />
          </button>
          <PcaPrimerLink size="md" />
        </div>
      </div>
    </section>
  );
}
