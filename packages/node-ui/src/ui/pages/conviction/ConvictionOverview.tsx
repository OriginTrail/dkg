import React, { useId, useMemo, useState } from 'react';
import { useAgentsStore } from '../../stores/agents.js';
import { useTabsStore } from '../../stores/tabs.js';
import { usePcaStore } from '../../stores/pca.js';
import { usePcaOverview } from '../../hooks/usePcaOverview.js';
import { DiscountTierLadder } from '../../components/Pca/index.js';
import { EmptyState } from '../../components/ContextGraphPrimitives.js';
import { PcaAccountCard } from './PcaAccountCard.js';
import { CreatePcaModal } from './CreatePcaModal.js';
import { ApproveWalletsModal } from './ApproveWalletsModal.js';
import { GetSponsoredPanel } from './GetSponsoredPanel.js';

type ViewFilter = 'owned' | 'approved';

/**
 * S1 Conviction Overview + S7 role-adaptive landing (UX §5.1/§5.7). Role only
 * changes the DEFAULT-selected view-filter and which CTA is emphasized — it
 * never reorders the fixed "Owned | Approved" filter and never gates the API
 * (P3: role is guidance, not a gate). Discovery runs on the locally-tracked id
 * set (no enumeration endpoint yet — P4); each card resolves independently so
 * one failure never blanks the grid.
 *
 * Create (S2), Approve-wallets (S4), and Get-sponsored (S6) are wired here.
 * Use-for-publishing (S5/Batch E) still renders neutral-disabled until that lands.
 */
export function ConvictionOverview() {
  const nodeStatus = useAgentsStore((s) => s.nodeStatus) as
    | { nodeRole?: string; blockExplorerUrl?: string | null }
    | null;
  const role = nodeStatus?.nodeRole === 'core' || nodeStatus?.nodeRole === 'edge'
    ? nodeStatus.nodeRole
    : undefined;
  const blockExplorerUrl = nodeStatus?.blockExplorerUrl ?? null;

  const openTab = useTabsStore((s) => s.openTab);
  const trackAccount = usePcaStore((s) => s.trackAccount);
  const untrackAccount = usePcaStore((s) => s.untrackAccount);
  const overview = usePcaOverview();
  const { accounts, loading, covered, refresh } = overview;

  // O2 — DERIVED default so the filter auto-reacts to the async role (a useState
  // initializer runs ONCE, so an edge node whose status resolved AFTER mount stayed
  // stuck on 'owned' and hid its sponsorships). The role default applies until the
  // user explicitly picks a tab, after which their choice is preserved.
  const [userFilter, setUserFilter] = useState<ViewFilter | null>(null);
  const defaultFilter: ViewFilter = role === 'edge' ? 'approved' : 'owned';
  const filter = userFilter ?? defaultFilter;
  const [createOpen, setCreateOpen] = useState(false);
  const [approve, setApprove] = useState<{ accountId: string; mode: 'self' | 'sponsor' } | null>(null);
  const [sponsoredOpen, setSponsoredOpen] = useState(false);

  const owned = useMemo(() => accounts.filter((a) => a.classification === 'owned'), [accounts]);
  const others = useMemo(() => accounts.filter((a) => a.classification !== 'owned'), [accounts]);

  const onManage = (id: string) => openTab({ id: `conviction:${id}`, label: `PCA #${id}`, closable: true });
  const visible = filter === 'owned' ? owned : others;

  return (
    <div className="v10-pca-overview" data-testid="pca-landing">
      <header className="v10-pca-overview-head">
        <div className="v10-pca-overview-titlerow">
          <h2 className="v10-pca-overview-title">Publishing Conviction</h2>
          {role && <span className="badge v10-pca-role-chip">Role: ◆ {role}</span>}
        </div>
        <p className="v10-pca-overview-explainer">
          {role === 'edge'
            ? "Edge nodes don’t own a Publishing Conviction Account (PCA) — there’s no staked identity to set as primary node. A core node can sponsor your publishes by approving your operational wallet(s) on its PCA. You still pay your own gas."
            : "A Publishing Conviction Account (PCA) lets you lock TRAC up front, publish at a discount, and sponsor other nodes. The discount applies to the wallet that SIGNS the publish (on-chain msg.sender) — not a peerId, admin wallet, or author identity."}
        </p>
      </header>

      {role === 'edge' && !loading && !covered && (
        <div className="v10-pca-edge-banner" role="status">
          <EmptyState
            tone="warning"
            title="No PCA discount on this node"
            description="No conviction account covers this node’s publishes, so each publish pays the direct cost from the signing wallet. Ask a core-node operator to sponsor you."
            actions={[{ label: 'Get sponsored', onClick: () => setSponsoredOpen(true), variant: 'primary' }]}
          />
        </div>
      )}

      <div className="v10-pca-overview-toolbar">
        <div className="v10-pca-filter" role="tablist" aria-label="Account view filter">
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'owned'}
            className={`v10-pca-filter-tab ${filter === 'owned' ? 'active' : ''}`}
            onClick={() => setUserFilter('owned')}
          >
            Owned by me
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'approved'}
            className={`v10-pca-filter-tab ${filter === 'approved' ? 'active' : ''}`}
            onClick={() => setUserFilter('approved')}
          >
            Approved for me
          </button>
        </div>
        {role === 'edge' ? (
          <button
            type="button"
            className="v10-pca-card-btn primary"
            onClick={() => setSponsoredOpen(true)}
          >
            Share my wallet → get sponsored
          </button>
        ) : (
          <button
            type="button"
            className="v10-pca-card-btn primary"
            data-testid="pca-create-btn"
            onClick={() => setCreateOpen(true)}
          >
            + Create PCA
          </button>
        )}
      </div>

      {loading && accounts.length === 0 ? (
        <div className="v10-pca-card-grid">
          <div className="card v10-pca-card v10-pca-card-skeleton" aria-hidden="true" />
          <div className="card v10-pca-card v10-pca-card-skeleton" aria-hidden="true" />
        </div>
      ) : visible.length > 0 ? (
        <>
          <div className="v10-pca-card-grid">
            {visible.map((account) => (
              <PcaAccountCard
                key={account.accountId}
                account={account}
                blockExplorerUrl={blockExplorerUrl}
                onManage={onManage}
                onApproveWallets={(id) => setApprove({ accountId: id, mode: 'sponsor' })}
                onRemove={untrackAccount}
                onRetry={() => refresh()}
              />
            ))}
          </div>
          {filter === 'approved' && (
            <p className="v10-pca-overview-caveat">
              ⓘ The chain exposes how many wallets are approved, not the full list. Wallets you
              approved here and any you probe are shown; others may exist.
            </p>
          )}
        </>
      ) : filter === 'owned' ? (
        <OwnedEmpty role={role} />
      ) : (
        <ApprovedEmpty />
      )}

      <TrackByIdDisclosure onTrack={trackAccount} />

      <p className="v10-pca-overview-foot">
        ⓘ No “list my accounts” API yet — this view tracks ids you create or add. Owned vs approved
        is resolved by probing your wallets.
      </p>

      {createOpen && (
        <CreatePcaModal
          onClose={() => { setCreateOpen(false); refresh(); }}
          onApproveOwnWallets={(id) => { setCreateOpen(false); setApprove({ accountId: id, mode: 'self' }); }}
          onManage={(id) => { setCreateOpen(false); onManage(id); }}
          onGetSponsored={() => { setCreateOpen(false); setSponsoredOpen(true); }}
        />
      )}
      {approve && (
        <ApproveWalletsModal
          accountId={approve.accountId}
          initialMode={approve.mode}
          onClose={() => { setApprove(null); refresh(); }}
        />
      )}
      {sponsoredOpen && <GetSponsoredPanel onClose={() => { setSponsoredOpen(false); refresh(); }} />}
    </div>
  );
}

function OwnedEmpty({ role }: { role?: 'core' | 'edge' }) {
  if (role === 'edge') {
    return (
      <EmptyState
        tone="neutral"
        title="Edge nodes can’t own a Publishing Conviction Account"
        description="Creating a PCA requires a staked core-node identity to set as its primary node. Get sponsored by a core node instead."
      />
    );
  }
  return (
    <div className="v10-pca-owned-empty">
      <EmptyState
        tone="neutral"
        title="What is a Publishing Conviction Account (PCA)?"
        description="Lock TRAC up front and every publish signed by an approved wallet pays a discounted fee from the account’s escrow instead of the direct cost. The more you commit, the bigger the discount:"
      />
      <DiscountTierLadder />
    </div>
  );
}

function ApprovedEmpty() {
  return (
    <EmptyState
      tone="neutral"
      title="No sponsorships tracked"
      description="If another operator approved one of your operational wallets on their account, add the account id below to track it."
    />
  );
}

function TrackByIdDisclosure({ onTrack }: { onTrack: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();

  const submit = () => {
    const id = value.trim();
    if (!/^\d+$/.test(id)) {
      setError('Enter a numeric account id.');
      return;
    }
    onTrack(id);
    setValue('');
    setError(null);
    setOpen(false);
  };

  return (
    <div className="v10-pca-track">
      <button
        type="button"
        className="v10-pca-track-toggle"
        data-testid="pca-track-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        Track an account by id ↵
      </button>
      {open && (
        <div id={panelId} className="v10-pca-track-panel">
          <input
            type="text"
            className="v10-form-input"
            data-testid="pca-track-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Account id (e.g. 7)"
            aria-label="Account id to track"
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
          <button type="button" className="v10-pca-card-btn primary" data-testid="pca-track-submit" onClick={submit}>
            Track
          </button>
          {error && (
            <p className="v10-pca-crux-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
