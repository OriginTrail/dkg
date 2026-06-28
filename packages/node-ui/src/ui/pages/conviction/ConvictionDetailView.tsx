import React from 'react';
import { useFetch } from '../../hooks.js';
import { fetchPca } from '../../api.js';
import { formatTrac } from '../../lib/formatTrac.js';
import {
  HealthChip,
  WalletRow,
  healthForSnapshot,
  formatWeiToTrac,
  formatRelativeExpiry,
} from '../../components/Pca/index.js';
import { StatStrip } from '../../components/ContextGraphPrimitives.js';

/**
 * S3 PCA Detail — Batch B scaffold (read-only snapshot). Batch D (D1) adds the
 * Funding / Settlement / Publishing-wallets / CG-bind / Lifecycle action
 * sections + owner-vs-non-owner gating. This read-only foundation is the target
 * of the S1 owned card's [Manage] CTA so the `conviction:<id>` tab resolves now.
 */
export function ConvictionDetailView({ accountId }: { accountId: string }) {
  const { data: snapshot, loading, error, refresh } = useFetch(() => fetchPca(accountId), [accountId]);

  if (loading && !snapshot) {
    return <div className="lazy-spinner">Loading PCA #{accountId}…</div>;
  }
  if (error || !snapshot) {
    return (
      <div className="v10-pca-detail">
        <div className="card">
          <div className="card-body v10-pca-card-error">
            <p>Couldn’t load PCA #{accountId}.</p>
            <button type="button" className="v10-pca-card-btn" onClick={() => refresh()}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  const discountPct = snapshot.discountBps / 100;
  return (
    <div className="v10-pca-detail">
      <div className="v10-pca-detail-band">
        <span className="v10-pca-detail-id">PCA #{accountId}</span>
        <span className="badge badge-info">
          ◉ {discountPct % 1 === 0 ? discountPct.toFixed(0) : discountPct.toFixed(1)}% discount
        </span>
        <span className="v10-pca-detail-committed">{formatTrac(snapshot.committedTRACTrac)} TRAC committed</span>
        <span className="v10-pca-card-spacer" />
        <HealthChip state={healthForSnapshot(snapshot)} />
      </div>

      <StatStrip
        items={[
          { id: 'buffer', label: 'Top-up buffer', value: `${formatTrac(snapshot.topUpBufferTrac)} TRAC` },
          { id: 'per-epoch', label: 'TRAC per epoch', value: `${formatWeiToTrac(snapshot.baseEpochAllowance)} TRAC` },
          { id: 'wallets', label: 'Publishing wallets', value: `${snapshot.agentCount} / 100` },
          {
            id: 'expires',
            label: 'Expires',
            value: formatRelativeExpiry(snapshot.expiresAtTimestamp),
            tooltip: `Expiry epoch ${snapshot.expiresAtEpoch}`,
          },
        ]}
      />

      <div className="v10-pca-detail-owner">
        <span className="v10-pca-card-owner-lbl">Owner</span>
        <WalletRow address={snapshot.owner} />
      </div>

      <p className="v10-pca-detail-note">
        Top-up, approve publishing wallets, settlement, and context-graph binding are managed here —
        coming in the next build step.
      </p>
    </div>
  );
}
