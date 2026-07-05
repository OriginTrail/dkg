import React from 'react';
import type { PcaSnapshot } from '../../api.js';
import { formatRelativeExpiry } from '../../components/Pca/index.js';
import { useRenewalChaining } from '../../pca/useRenewalChaining.js';
import type { PcaHealthState } from '../../pca/health.js';
import { ApproveWalletsModal } from './ApproveWalletsModal.js';
import { CreatePcaModal } from './CreatePcaModal.js';
import type { DetailOwnerMode } from './ConvictionDetailView.js';

/** Lifecycle / Renew — re-mint a REPLACEMENT account (deliberately omits refresh; the mint is a NEW id). */
export function LifecycleSection({
  accountId,
  snapshot,
  ownerMode,
  ownerWritesEnabled,
  ownerTitle,
  health,
}: {
  accountId: string;
  snapshot: PcaSnapshot;
  ownerMode: DetailOwnerMode;
  ownerWritesEnabled: boolean;
  ownerTitle?: string;
  health: PcaHealthState;
}) {
  const renewal = useRenewalChaining(accountId);
  return (
    <>
      <section className="v10-pca-detail-section">
        <h3 className="v10-pca-detail-section-title">Lifecycle</h3>
        {(health === 'expiring' || health === 'expired') && (
          <p className="v10-pca-card-warn">
            {formatRelativeExpiry(snapshot.expiresAtTimestamp)}. The lock period can’t be extended —
            Renew creates a fresh replacement account seeded from this one (the old TRAC stays locked
            until its own expiry).
          </p>
        )}
        {/* S2b — Renew = re-mint a REPLACEMENT (owner-signed create), emphasized as the
            account nears/passes expiry. Honest copy lives in the seeded create modal (#9). */}
        <button
          type="button"
          className={`v10-pca-card-btn${health === 'expiring' || health === 'expired' ? ' primary' : ''}`}
          data-testid="pca-renew-btn"
          onClick={() => renewal.openRenew()}
          disabled={!ownerWritesEnabled}
          title={ownerTitle}
        >
          Renew — create a replacement PCA
        </button>
      </section>

      {/* S2b renew — the seeded create modal (re-mint replacement). */}
      {renewal.renewOpen && (
        <CreatePcaModal
          seed={{
            tokens: snapshot.committedTRACTrac,
            primaryNode:
              snapshot.primaryNode && snapshot.primaryNode !== '0' ? String(snapshot.primaryNode) : undefined,
            // LOW — distinguish "extended read failed" (null) from a genuine "none" ('0'),
            // so the modal can flag a silent fall-back to this node.
            primaryNodeUnknown: snapshot.primaryNode == null,
          }}
          replacingAccountId={accountId}
          initialOwnerKey={ownerMode === 'wallet' ? 'hardware' : 'hot'}
          onClose={() => renewal.closeRenew()}
          onApproveOwnWallets={renewal.onRenewSuccess}
          onManage={renewal.onManageNew}
          onGetSponsored={() => renewal.closeRenew()}
        />
      )}
      {/* LOW#3 — brief in-flight state between the mint and the seeded re-approval. */}
      {renewal.renewChaining && (
        <div className="lazy-spinner" role="status" data-testid="pca-renew-chaining">
          Preparing re-approval…
        </div>
      )}
      {/* S2b renew — chained Approve, pre-seeded with the OLD account's agents, which it
          DEREGISTERS from the old account first (expiry doesn't free them — gate-HIGH). */}
      {renewal.renewApprove && (
        <ApproveWalletsModal
          accountId={renewal.renewApprove.newAccountId}
          initialMode="sponsor"
          seedBulk={renewal.renewApprove.seedBulk}
          deregisterFrom={accountId}
          seedAgentsResolved={renewal.renewApprove.agentsResolved}
          onClose={() => renewal.clearRenewApprove()}
        />
      )}
    </>
  );
}
