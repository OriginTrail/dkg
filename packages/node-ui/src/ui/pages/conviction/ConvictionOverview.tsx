import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useAgentsStore } from '../../stores/agents.js';
import { useTabsStore } from '../../stores/tabs.js';
import { pcaStorageScopeForContracts, usePcaStore } from '../../stores/pca.js';
import { isWrongNetwork, useWalletStore } from '../../stores/wallet.js';
import { usePcaOverview, type ResolvedPcaAccount } from '../../hooks/usePcaOverview.js';
import { useDiscoveredPcas } from '../../hooks/useDiscoveredPcas.js';
import { useConnectedWalletPcas } from '../../hooks/useConnectedWalletPcas.js';
import { listPcaContracts } from '../../api.js';
import { WalletConnectControl, WalletRow, RetryButton, truncateAddress } from '../../components/Pca/index.js';
import { isPcaSpendable } from '../../pca/coverage.js';
import { isPcaExpired } from '../../pca/pca-primitives.js';
import { PcaAccountList, type PcaListAccount } from './PcaAccountList.js';
import { CreatePcaModal } from './CreatePcaModal.js';
import { ApproveWalletsModal } from './ApproveWalletsModal.js';
import { GetSponsoredPanel } from './GetSponsoredPanel.js';
import { eqAddress as eq } from '../../web3/address.js';
import { resolvePcaOwnerAccess } from '../../pca/ownerAccess.js';
import { Badge } from '../../components/ds/Badge.js';
import { ExternalMark } from '../../components/ds/ExternalMark.js';
import { Loading } from '../../components/ds/Loading.js';
import { Plus } from 'lucide-react';
import { formatBps, formatNodeRole } from '../../lib/format.js';
import { PageHeader } from '../../components/ds/PageHeader.js';

export const PCA_DOCS_URL = 'https://docs.origintrail.io/';

type WalletBootstrapStatus = 'idle' | 'loading' | 'ready' | 'error';

function inactiveLabel(account: ResolvedPcaAccount): string {
  return account.snapshot && isPcaExpired(account.snapshot)
    ? `PCA #${account.accountId}, which has expired`
    : `PCA #${account.accountId}, which has no TRAC left this epoch`;
}

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

  const openTab = useTabsStore((s) => s.openTab);
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
  const { accounts, loading, refresh, walletsInconclusive, bestCoveringDiscountBps } = overview;
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
  const [manualTrackPending, setManualTrackPending] = useState<string | null>(null);

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

  useEffect(() => {
    if (!manualTrackPending || loading) return;
    if (enhancedAccounts.some((account) => account.accountId === manualTrackPending)) {
      setManualTrackPending(null);
    }
  }, [enhancedAccounts, loading, manualTrackPending]);

  const onManage = (id: string) => openTab({ id: `conviction:${id}`, label: `PCA #${id}`, closable: true });
  const walletCoverageRows = useMemo(
    () =>
      overview.wallets.map((wallet) => {
        const approvedOn = (spendable: boolean) => enhancedAccounts.find((account) =>
          account.snapshot &&
          isPcaSpendable(account.snapshot) === spendable &&
          account.walletProbes.some((probe) => eq(probe.wallet, wallet) && probe.registered === true),
        );
        const covering = approvedOn(true);
        if (covering) {
          return { wallet, status: `Covered by PCA #${covering.accountId}`, tone: 'success' as const };
        }
        const inactive = approvedOn(false);
        if (inactive) {
          return {
            wallet,
            status: `Approved on PCA #${inactive.accountId}, which isn't active: pays the full fee`,
            tone: 'warn' as const,
            inactive,
          };
        }
        const unknown = walletsInconclusive || enhancedAccounts.some((account) =>
          account.walletProbes.some((probe) => eq(probe.wallet, wallet) && probe.registered == null),
        );
        if (unknown) return { wallet, status: "Couldn't check", tone: 'warn' as const, unknown: true };
        return { wallet, status: 'Not covered: pays the full fee', tone: 'neutral' as const };
      }),
    [enhancedAccounts, overview.wallets, walletsInconclusive],
  );
  const coveredCount = walletCoverageRows.filter((row) => row.tone === 'success').length;
  const hasCoveredWallet = coveredCount > 0;
  const anyUnknown = walletCoverageRows.some((row) => 'unknown' in row);
  const inactiveAccount = walletCoverageRows.map((row) => ('inactive' in row ? row.inactive : undefined)).find(Boolean);

  const retryWalletBootstrap = useCallback(() => setBootstrapNonce((n) => n + 1), []);
  const switchNetwork = useCallback(() => {
    void switchToExpectedChain();
  }, [switchToExpectedChain]);
  const trackAccountById = useCallback(
    (id: string) => {
      setManualTrackPending(id);
      trackAccount(id);
    },
    [trackAccount],
  );

  const firstLoad = loading && accounts.length === 0 && overview.wallets.length === 0;
  const walletTotal = overview.wallets.length;
  // #9 - never say "None" while the wallets or the PCA lookup can't be read.
  const unconfirmed = !hasCoveredWallet && (walletsInconclusive || !!discoveredLookupError);
  const discountValue = hasCoveredWallet
    ? bestCoveringDiscountBps != null ? formatBps(bestCoveringDiscountBps) : '—'
    : unconfirmed
      ? 'Unknown'
      : inactiveAccount
        ? 'None'
        : 'None yet';
  const discountSub = hasCoveredWallet
    ? coveredCount === walletTotal
      ? `All ${walletTotal} publishing wallets covered`
      : `${coveredCount} of ${walletTotal} publishing wallets covered`
    : walletsInconclusive
      ? "Couldn't read this node's wallets, so we can't confirm your discount."
      : discoveredLookupError
        ? "Couldn't check this node's PCAs. You may still have a discount."
        : inactiveAccount
          ? `Your wallets are on ${inactiveLabel(inactiveAccount)}. They pay the full fee.`
          : walletTotal === 0 && accounts.length > 0
            ? "This node didn't report any publishing wallets."
            : "This node's publishing wallets pay the full TRAC fee.";
  const showWalletRows = walletCoverageRows.some((row) => row.tone !== 'neutral');
  const showWaysIn = !hasCoveredWallet && !walletsInconclusive && !firstLoad;
  // The lookup notice above has its own Retry, which re-reads everything.
  const showRetry = (walletsInconclusive || anyUnknown) && !discoveredLookupError;
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
            <a className="v10-pca-text-link" href={PCA_DOCS_URL} target="_blank" rel="noreferrer">What is a PCA? <ExternalMark /></a>
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
                <div className="stat-value" data-testid="pca-discount-value">{discountValue}</div>
                <div className="stat-sub">{discountSub}</div>
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
              {walletCoverageRows.map((row) => (
                <WalletRow key={row.wallet} address={row.wallet} status={row.status} statusTone={row.tone} />
              ))}
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
        onAddById={trackAccountById}
        pendingId={manualTrackPending}
        readingWallet={connectedWalletPcas.loading && connectedWallet ? truncateAddress(connectedWallet) : null}
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
      {sponsoredOpen && <GetSponsoredPanel onClose={() => { setSponsoredOpen(false); refresh(); }} />}
    </div>
  );
}
