import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgentsStore } from '../../stores/agents.js';
import { chooseTab as openTab } from '../../lib/shellNavigation.js';
import { pcaStorageScopeForContracts, usePcaStore } from '../../stores/pca.js';
import { isWrongNetwork, useWalletStore } from '../../stores/wallet.js';
import { usePcaOverview } from '../../hooks/usePcaOverview.js';
import { useDiscoveredPcas } from '../../hooks/useDiscoveredPcas.js';
import { useConnectedWalletPcas } from '../../hooks/useConnectedWalletPcas.js';
import { listPcaContracts } from '../../api.js';
import { WalletConnectControl, WalletRow } from '../../components/Pca/index.js';
import { RetryButton } from '../../components/ds/RetryButton.js';
import { walletCoverageRow, summarizeCoverage, withLookupOutcome } from '../../pca/walletCoverage.js';
import { PcaAccountList, type PcaListAccount } from './PcaAccountList.js';
import { CreatePcaModal } from './CreatePcaModal.js';
import { ApproveWalletsModal } from './ApproveWalletsModal.js';
import { GetSponsoredPanel } from './GetSponsoredPanel.js';
import { resolvePcaOwnerAccess } from '../../pca/ownerAccess.js';
import { Badge } from '../../components/ds/Badge.js';
import { PcaPrimerLink } from './PcaPrimer.js';
import { Loading } from '../../components/ds/Loading.js';
import { Plus } from 'lucide-react';
import { formatNodeRole } from '../../lib/format.js';
import { PageHeader } from '../../components/ds/PageHeader.js';

type WalletBootstrapStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * S1 Conviction Overview. Answers three questions in order: do I have a discount, how
 * do I get one, and which PCAs do I have. Role only picks which way in leads; it never
 * gates the API (P3). Each PCA resolves on its own, so one failure never blanks the list.
 *
 * Create (S2), Approve wallets (S4) and Get added (S6) open from here.
 */
export function ConvictionOverview() {
  const nodeStatus = useAgentsStore((s) => s.nodeStatus) as
    | { nodeRole?: string; blockExplorerUrl?: string | null }
    | null;
  const role = nodeStatus?.nodeRole === 'core' || nodeStatus?.nodeRole === 'edge'
    ? nodeStatus.nodeRole
    : undefined;

  const trackAccount = usePcaStore((s) => s.trackAccount);
  const untrackAccount = usePcaStore((s) => s.untrackAccount);
  const setPcaScope = usePcaStore((s) => s.setScope);
  const setWalletBootstrap = useWalletStore((s) => s.setBootstrap);
  const initWallet = useWalletStore((s) => s.initWallet);
  const connectedWallet = useWalletStore((s) => s.address);
  const wrongNetwork = useWalletStore((s) => isWrongNetwork(s));
  const switchToExpectedChain = useWalletStore((s) => s.switchToExpectedChain);
  const [bootstrapState, setBootstrapState] = useState<{
    status: WalletBootstrapStatus;
    error: string | null;
  }>({ status: 'idle', error: null });
  const connectedWalletPcas = useConnectedWalletPcas();
  const [bootstrapNonce, setBootstrapNonce] = useState(0);
  const overview = usePcaOverview(30_000, connectedWalletPcas.ids);
  const { accounts, loading, refresh, walletsInconclusive } = overview;
  const primaryWallet = overview.wallets[0];

  useEffect(() => {
    let cancelled = false;
    async function bootstrapWalletLayer() {
      setBootstrapState({ status: 'loading', error: null });
      try {
        const contracts = await listPcaContracts();
        if (cancelled) return;
        setPcaScope(pcaStorageScopeForContracts(contracts));
        setWalletBootstrap(contracts);
        initWallet();
        setBootstrapState({ status: 'ready', error: null });
      } catch (err) {
        if (cancelled) return;
        setBootstrapState({
          status: 'error',
          error: (err as Error)?.message ?? 'Could not bootstrap wallet contract reads.',
        });
        initWallet();
      }
    }
    void bootstrapWalletLayer();
    return () => {
      cancelled = true;
    };
  }, [bootstrapNonce, initWallet, setPcaScope, setWalletBootstrap]);

  // GAP-1 - PCAs this node relates to on-chain (owned + agent-on) beyond the locally
  // tracked set. Agent-on auto-tracks (edge self-heal); the rest show as found rows.
  // `ownedError` = the enumeration failed retryably (#9 - don't assert "you own none").
  const { untracked: discoveredUntracked, ownedError: discoveredOwnedError, agentError: discoveredAgentError, refresh: refreshDiscovered } =
    useDiscoveredPcas();
  const discoveredLookupError = discoveredOwnedError || discoveredAgentError;

  const [createOpen, setCreateOpen] = useState(false);
  const [approve, setApprove] = useState<{ accountId: string; mode: 'self' | 'sponsor'; selfCoverage?: boolean } | null>(null);
  const [sponsoredOpen, setSponsoredOpen] = useState(false);
  // Set when "Already have a PCA?" opens Get added with an ID to check right away.
  const [sponsoredCheckId, setSponsoredCheckId] = useState<string | null>(null);

  const enhancedAccounts = useMemo<PcaListAccount[]>(
    () =>
      accounts.map((account) => {
        const access = resolvePcaOwnerAccess({
          owner: account.snapshot?.owner,
          primaryWallet,
          connectedWallet,
          walletWrongNetwork: wrongNetwork,
        });
        return {
          ...account,
          ownerMode: access.mode,
          walletWrongNetwork: access.mode === 'wallet' && access.wrongNetwork,
        };
      }),
    [accounts, connectedWallet, primaryWallet, wrongNetwork],
  );

  const onManage = (id: string) => openTab({ id: `conviction:${id}`, label: `PCA #${id}`, closable: true });
  // The overview's single coverage aggregate, with this page's PCA lookup folded in:
  // status, uncertainty and the Retry to offer all come from it.
  const node = withLookupOutcome(overview.coverage, !!discoveredLookupError);
  const coverage = node.wallets;
  const retryWalletBootstrap = useCallback(() => setBootstrapNonce((n) => n + 1), []);
  const switchNetwork = useCallback(() => {
    void switchToExpectedChain();
  }, [switchToExpectedChain]);

  const firstLoad = loading && accounts.length === 0 && overview.wallets.length === 0;
  const summary = summarizeCoverage(node);
  const { hasCoveredWallet, showWalletRows } = summary;
  const showWaysIn = !node.covered && node.uncertainty !== 'wallets-unreadable' && !firstLoad;
  // A failed lookup has its own Retry in its notice, which re-reads everything.
  const showRetry = node.recovery === 'retry-read';
  const anyWalletWrongNetwork = enhancedAccounts.some((a) => a.walletWrongNetwork);

  const getAddedCard = (
    <div className="card ds-card" key="added">
      <div className="card-header"><h3 className="card-title">Get added to a PCA</h3></div>
      <div className="card-body v10-pca-way-in">
        <p className="v10-pca-settings-line">Share this node&apos;s publishing wallets with a PCA owner, who approves them.</p>
        <button
          type="button"
          className={`v10-pca-card-btn ds-btn${role === 'core' ? '' : ' primary ds-primary'}`}
          aria-label="Get added to a PCA"
          onClick={() => setSponsoredOpen(true)}
        >
          Get added
        </button>
      </div>
    </div>
  );
  const createCard = (
    <div className="card ds-card" key="create">
      <div className="card-header"><h3 className="card-title">Create a PCA</h3></div>
      <div className="card-body v10-pca-way-in">
        <p className="v10-pca-settings-line">Commit at least 25,000 TRAC. The more you commit, the bigger the discount.</p>
        <button
          type="button"
          className={`v10-pca-card-btn ds-btn${role === 'core' ? ' primary ds-primary' : ''}`}
          data-testid="pca-create-btn"
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={14} aria-hidden="true" />Create PCA
        </button>
      </div>
    </div>
  );

  return (
    <div className="ds-page ds-page-narrow" data-testid="pca-landing">
      <PageHeader
        title="Publisher Conviction Accounts (PCAs)"
        badge={role && <Badge tone="role" size="sm" className="v10-pca-role-chip">Node role: {formatNodeRole(role)}</Badge>}
        description={(
          <>
            Commit TRAC up front to publish at a discount of up to 75%.{' '}
            <PcaPrimerLink />
          </>
        )}
      />

      {/* Failures that change what the page means come first. */}
      {discoveredLookupError && (
        <section className="v10-pca-retry-block" data-testid="pca-discovered-error" role="status">
          <p className="v10-modal-warning ds-card-nested v10-pca-notice">Couldn&apos;t check this node&apos;s PCAs. You may still have a discount.</p>
          <RetryButton onClick={() => { refreshDiscovered(); refresh(); }} />
        </section>
      )}
      {bootstrapState.status === 'error' && (
        <section className="v10-pca-retry-block" data-testid="pca-wallet-bootstrap-error" role="status">
          <p className="v10-modal-warning ds-card-nested v10-pca-notice">Couldn&apos;t load contract details, so we can&apos;t look up PCAs for your connected wallet.</p>
          <RetryButton onClick={retryWalletBootstrap} />
        </section>
      )}
      {connectedWalletPcas.error && (
        <section className="v10-pca-retry-block" data-testid="pca-wallet-discovery-error" role="status">
          <p className="v10-modal-warning ds-card-nested v10-pca-notice">Couldn&apos;t read PCAs owned by your connected wallet. The PCAs you&apos;ve added are still shown.</p>
          <RetryButton onClick={connectedWalletPcas.refresh} />
        </section>
      )}
      {anyWalletWrongNetwork && (
        <section className="v10-pca-retry-block" role="alert">
          <p className="v10-modal-warning ds-card-nested v10-pca-notice">Wrong network. You can view this PCA, but you can&apos;t change it until you switch your wallet.</p>
          <button type="button" className="v10-pca-card-btn ds-btn ds-sm" onClick={switchNetwork}>Switch network</button>
        </section>
      )}

      <section className="v10-pca-section v10-pca-coverage-summary" data-testid="pca-coverage-summary">
        <div className="stat-card ds-card v10-pca-status">
          <div>
            <div className="stat-label">Your publishing discount</div>
            {firstLoad ? (
              <Loading label="Checking your discount…" />
            ) : (
              <>
                <div className="stat-value" data-testid="pca-discount-value">{summary.value}</div>
                <div className="stat-sub">{summary.sub}</div>
              </>
            )}
          </div>
          {!firstLoad && (showRetry || hasCoveredWallet) && (
            <div className="v10-pca-overview-cta-group">
              {showRetry && <RetryButton onClick={() => refresh()} />}
              {hasCoveredWallet && (
                <>
                  <button type="button" className="v10-pca-card-btn ds-btn ds-sm" aria-label="Get added to a PCA" onClick={() => setSponsoredOpen(true)}>
                    Get added
                  </button>
                  <button type="button" className="v10-pca-card-btn ds-btn ds-sm" data-testid="pca-create-btn" onClick={() => setCreateOpen(true)}>
                    <Plus size={12} aria-hidden="true" />Create PCA
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        {showWalletRows && (
          <>
            <div className="v10-pca-wallet-list">
              {coverage.map((c) => {
                const row = walletCoverageRow(c);
                return <WalletRow key={c.wallet} address={c.wallet} status={row.status} statusTone={row.tone} />;
              })}
            </div>
            <p className="v10-pca-overview-caveat">The discount follows the wallet that signs each publish.</p>
          </>
        )}
      </section>

      {showWaysIn && (
        <section className="v10-pca-section" data-testid="pca-ways-in">
          <div className="v10-pca-ways-in">
            {role === 'core' ? [createCard, getAddedCard] : [getAddedCard, createCard]}
          </div>
          <p className="v10-pca-overview-caveat">You still pay gas. A PCA only covers the TRAC publishing fee.</p>
        </section>
      )}

      <PcaAccountList
        accounts={enhancedAccounts}
        found={discoveredUntracked}
        loading={loading && accounts.length === 0}
        walletsInconclusive={walletsInconclusive}
        onManage={onManage}
        onApproveWallets={(id) => setApprove({ accountId: id, mode: 'sponsor' })}
        onRemove={untrackAccount}
        onRetry={() => refresh()}
        onAddFound={trackAccount}
        onCheckId={(id) => { setSponsoredCheckId(id); setSponsoredOpen(true); }}
        readingWallet={connectedWalletPcas.loading && connectedWallet ? connectedWallet : null}
      />

      <div className="v10-pca-overview-wallet">
        <WalletConnectControl className="compact" testId="pca-wallet-connect" />
      </div>

      {createOpen && (
        <CreatePcaModal
          onClose={() => { setCreateOpen(false); refresh(); }}
          onApproveOwnWallets={(id) => { setCreateOpen(false); setApprove({ accountId: id, mode: 'self', selfCoverage: true }); }}
          onManage={(id) => { setCreateOpen(false); onManage(id); }}
          onGetSponsored={() => { setCreateOpen(false); setSponsoredOpen(true); }}
        />
      )}
      {approve && (
        <ApproveWalletsModal
          accountId={approve.accountId}
          initialMode={approve.mode}
          selfCoverage={approve.selfCoverage}
          onClose={() => { setApprove(null); refresh(); }}
        />
      )}
      {sponsoredOpen && (
        <GetSponsoredPanel
          initialAccountId={sponsoredCheckId ?? undefined}
          onClose={() => { setSponsoredOpen(false); setSponsoredCheckId(null); refresh(); }}
        />
      )}
    </div>
  );
}
