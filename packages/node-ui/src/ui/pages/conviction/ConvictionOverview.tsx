import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { Address } from 'viem';
import { useAgentsStore } from '../../stores/agents.js';
import { useTabsStore } from '../../stores/tabs.js';
import { pcaStorageScopeForContracts, usePcaStore } from '../../stores/pca.js';
import { isWrongNetwork, useWalletStore } from '../../stores/wallet.js';
import { usePcaOverview, type ResolvedPcaAccount } from '../../hooks/usePcaOverview.js';
import { useDiscoveredPcas, type DiscoveredPca } from '../../hooks/useDiscoveredPcas.js';
import { listPcaContracts, type PcaContracts } from '../../api.js';
import { publicClientFor } from '../../web3/clients.js';
import { publishingConvictionNftAbi } from '../../web3/pcaContract.js';
import { WalletConnectControl, WalletRow, truncateAddress } from '../../components/Pca/index.js';
import { isPcaSpendable } from '../../pca/coverage.js';
import { PcaAccountCard, type PcaAccountOwnerMode } from './PcaAccountCard.js';
import { CreatePcaModal } from './CreatePcaModal.js';
import { ApproveWalletsModal } from './ApproveWalletsModal.js';
import { GetSponsoredPanel } from './GetSponsoredPanel.js';

type WalletBootstrapStatus = 'idle' | 'loading' | 'ready' | 'error';

type OverviewAccount = ResolvedPcaAccount & {
  ownerMode: PcaAccountOwnerMode;
  primaryWallet?: string;
  connectedWallet: string | null;
  walletWrongNetwork: boolean;
};

const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

function ownerModeFor(owner: string | undefined, primaryWallet: string | undefined, connectedWallet: string | null): PcaAccountOwnerMode {
  if (!owner) return 'unknown';
  if (eq(owner, primaryWallet)) return 'daemon';
  if (connectedWallet && eq(owner, connectedWallet) && !eq(owner, primaryWallet)) return 'wallet';
  return 'external';
}

/**
 * S1 Conviction Overview + S7 role-adaptive landing (UX section 5.1/5.7). Role only
 * changes the DEFAULT-selected view-filter and which CTA is emphasized - it
 * never reorders the fixed "Owned | Approved" filter and never gates the API
 * (P3: role is guidance, not a gate). Discovery runs on the locally-tracked id
 * set (no enumeration endpoint yet - P4); each card resolves independently so
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
  const setPcaScope = usePcaStore((s) => s.setScope);
  const setWalletBootstrap = useWalletStore((s) => s.setBootstrap);
  const initWallet = useWalletStore((s) => s.initWallet);
  const walletBootstrap = useWalletStore((s) => s.bootstrap);
  const connectedWallet = useWalletStore((s) => s.address);
  const wrongNetwork = useWalletStore((s) => isWrongNetwork(s));
  const switchToExpectedChain = useWalletStore((s) => s.switchToExpectedChain);
  const [bootstrapState, setBootstrapState] = useState<{
    status: WalletBootstrapStatus;
    error: string | null;
  }>({ status: 'idle', error: null });
  const [walletDiscovery, setWalletDiscovery] = useState<{
    loading: boolean;
    error: string | null;
    ids: string[];
  }>({ loading: false, error: null, ids: [] });
  const [bootstrapNonce, setBootstrapNonce] = useState(0);
  const [walletDiscoveryNonce, setWalletDiscoveryNonce] = useState(0);
  const overview = usePcaOverview(30_000, walletDiscovery.ids);
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

  useEffect(() => {
    let cancelled = false;
    async function discoverConnectedWalletPcas(contracts: PcaContracts, wallet: `0x${string}`) {
      setWalletDiscovery((prev) => ({ ...prev, loading: true, error: null }));
      try {
        if (!contracts.rpcUrls?.length) throw new Error('No PCA RPC endpoints were provided.');
        const client = publicClientFor(contracts.chainId, contracts.rpcUrls);
        const nft = contracts.nft as Address;
        const owner = wallet as Address;
        const balance = await client.readContract({
          address: nft,
          abi: publishingConvictionNftAbi,
          functionName: 'balanceOf',
          args: [owner],
        });
        const ids: string[] = [];
        const count = typeof balance === 'bigint' ? balance : BigInt(String(balance));
        for (let i = 0n; i < count; i += 1n) {
          const tokenId = await client.readContract({
            address: nft,
            abi: publishingConvictionNftAbi,
            functionName: 'tokenOfOwnerByIndex',
            args: [owner, i],
          });
          ids.push((typeof tokenId === 'bigint' ? tokenId : BigInt(String(tokenId))).toString());
        }
        if (cancelled) return;
        setWalletDiscovery({ loading: false, error: null, ids });
      } catch (err) {
        if (cancelled) return;
        setWalletDiscovery({
          loading: false,
          error: (err as Error)?.message ?? 'Could not read connected-wallet PCAs.',
          ids: [],
        });
      }
    }

    if (!connectedWallet || !walletBootstrap) {
      setWalletDiscovery({ loading: false, error: null, ids: [] });
      return () => {
        cancelled = true;
      };
    }
    void discoverConnectedWalletPcas(walletBootstrap, connectedWallet);
    return () => {
      cancelled = true;
    };
  }, [connectedWallet, walletBootstrap, walletDiscoveryNonce]);
  // GAP-1 - PCAs this node relates to on-chain (owned + agent-on) beyond the locally
  // tracked set. Agent-on auto-tracks (edge self-heal); the rest surface in the strip.
  // `ownedError` = the enumeration failed retryably (#9 - don't assert "you own none").
  const { untracked: discoveredUntracked, ownedError: discoveredOwnedError, agentError: discoveredAgentError, refresh: refreshDiscovered } =
    useDiscoveredPcas();
  const discoveredLookupError = discoveredOwnedError || discoveredAgentError;

  // O2 - DERIVED default so the filter auto-reacts to the async role (a useState
  // initializer runs ONCE, so an edge node whose status resolved AFTER mount stayed
  // stuck on 'owned' and hid its sponsorships). The role default applies until the
  // user explicitly picks a tab, after which their choice is preserved.
  const [createOpen, setCreateOpen] = useState(false);
  const [approve, setApprove] = useState<{ accountId: string; mode: 'self' | 'sponsor'; selfCoverage?: boolean } | null>(null);
  const [sponsoredOpen, setSponsoredOpen] = useState(false);
  const [manualTrackPending, setManualTrackPending] = useState<string | null>(null);

  const enhancedAccounts = useMemo<OverviewAccount[]>(
    () =>
      accounts.map((account) => {
        const ownerMode = ownerModeFor(account.snapshot?.owner, primaryWallet, connectedWallet);
        return {
          ...account,
          ownerMode,
          primaryWallet,
          connectedWallet,
          walletWrongNetwork: ownerMode === 'wallet' && wrongNetwork,
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

  const daemonOwned = useMemo(
    () => enhancedAccounts.filter((a) => a.ownerMode === 'daemon'),
    [enhancedAccounts],
  );
  const walletOwned = useMemo(
    () => enhancedAccounts.filter((a) => a.ownerMode === 'wallet'),
    [enhancedAccounts],
  );
  const trackedExternal = useMemo(
    () =>
      enhancedAccounts.filter(
        (a) => a.ownerMode === 'external' && a.snapshot && a.approvedCount === 0,
      ),
    [enhancedAccounts],
  );
  const approved = useMemo(
    () =>
      enhancedAccounts.filter(
        (a) => a.approvedCount > 0 || (!a.snapshot && !a.notFound),
      ),
    [enhancedAccounts],
  );

  const onManage = (id: string) => openTab({ id: `conviction:${id}`, label: `PCA #${id}`, closable: true });
  const ownedAccounts = useMemo(
    () => [...daemonOwned, ...walletOwned],
    [daemonOwned, walletOwned],
  );
  const walletCoverageRows = useMemo(
    () =>
      overview.wallets.map((wallet) => {
        const covering = enhancedAccounts.find((account) =>
          account.snapshot &&
          isPcaSpendable(account.snapshot) &&
          account.walletProbes.some((probe) => eq(probe.wallet, wallet) && probe.registered === true),
        );
        if (covering?.snapshot) {
          return {
            wallet,
            status: `covered by PCA #${covering.accountId}`,
            tone: 'success' as const,
          };
        }
        const inactive = enhancedAccounts.find((account) =>
          account.snapshot &&
          !isPcaSpendable(account.snapshot) &&
          account.walletProbes.some((probe) => eq(probe.wallet, wallet) && probe.registered === true),
        );
        if (inactive?.snapshot) {
          return {
            wallet,
            status: `approved on inactive PCA #${inactive.accountId}`,
            tone: 'warn' as const,
          };
        }
        const unknown = walletsInconclusive || enhancedAccounts.some((account) =>
          account.walletProbes.some((probe) => eq(probe.wallet, wallet) && probe.registered == null),
        );
        if (unknown) {
          return { wallet, status: 'unknown - retry wallet/PCA read', tone: 'warn' as const };
        }
        if (loading && accounts.length === 0) {
          return { wallet, status: 'checking', tone: 'neutral' as const };
        }
        return { wallet, status: 'direct cost', tone: 'danger' as const };
      }),
    [accounts.length, enhancedAccounts, loading, overview.wallets, walletsInconclusive],
  );
  const hasCoveredWallet = walletCoverageRows.some((row) => row.tone === 'success');

  const retryWalletBootstrap = useCallback(() => setBootstrapNonce((n) => n + 1), []);
  const retryWalletDiscovery = useCallback(() => setWalletDiscoveryNonce((n) => n + 1), []);
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

  return (
    <div className="v10-pca-overview" data-testid="pca-landing">
      <header className="v10-pca-overview-head">
        <div className="v10-pca-overview-titlerow">
          <h2 className="v10-pca-overview-title">Publisher Conviction</h2>
          {role && <span className="badge v10-pca-role-chip">Node role: {role}</span>}
        </div>
        <p className="v10-pca-overview-explainer">
          {role === 'edge'
            ? "Publisher Conviction Accounts let publishers dedicate TRAC spend in advance and receive a publishing discount by tier: 0%, 10%, 20%, 30%, 40%, 50%, or 75%, based on the committed amount. Nodes can create their own PCA or get added to an existing PCA by sharing operational publishing wallets with the PCA owner. You still pay gas; the PCA covers only the TRAC publishing fee for approved wallets."
            : "A Publisher Conviction Account (PCA) lets you lock TRAC up front and approve publishing wallets to publish at a discount. The discount applies to the wallet that signs the publish (on-chain msg.sender), not a peerId, admin wallet, or author identity."}
        </p>
      </header>

      <section className="v10-pca-section v10-pca-coverage-summary" data-testid="pca-coverage-summary">
        <div className="v10-pca-section-head">
          <div>
            <h3 className="v10-pca-section-title">This node's publishing wallet coverage</h3>
            <p className="v10-pca-overview-caveat">
              The discount follows the operational wallet that signs a publish.
            </p>
          </div>
          <div className="v10-pca-overview-cta-group">
            <button type="button" className="v10-pca-card-btn primary" onClick={() => setSponsoredOpen(true)}>
              Get added to a PCA
            </button>
            <button type="button" className="v10-pca-card-btn" data-testid="pca-create-btn" onClick={() => setCreateOpen(true)}>
              + Create PCA
            </button>
          </div>
        </div>
        {walletCoverageRows.length > 0 ? (
          <div className="v10-pca-wallet-list">
            {walletCoverageRows.map((row) => (
              <WalletRow key={row.wallet} address={row.wallet} status={row.status} statusTone={row.tone} />
            ))}
          </div>
        ) : walletsInconclusive ? (
          <p className="v10-pca-overview-caveat" role="status">
            Couldn't read this node's wallets, so coverage can't be confirmed.{' '}
            <button type="button" className="v10-pca-card-btn" onClick={() => refresh()}>Retry</button>
          </p>
        ) : (
          <p className="v10-pca-overview-caveat">No operational publishing wallets were reported by this node.</p>
        )}
        {!hasCoveredWallet && !loading && !walletsInconclusive && !discoveredLookupError && (
          <p className="v10-pca-inline-status" role="status">
            No PCA discount is active for this node yet. Publishes from direct-cost wallets use the signing wallet.
          </p>
        )}
        {!loading && approved.length > 0 && (
          <div className="v10-pca-linked-pcas" data-testid="pca-approved-section">
            <div className="v10-pca-account-group-head">
              <h3 className="v10-pca-account-group-title">PCAs linked to this node</h3>
              <span className="v10-pca-account-group-count">{approved.length}</span>
            </div>
            <p className="v10-pca-overview-caveat">
              Account summaries for PCAs that approve at least one of this node&apos;s publishing wallets.
              Wallet coverage above is the source of truth for publish discounts.
            </p>
            <div className="v10-pca-card-grid v10-pca-card-grid-compact">
              {approved.map((account) => (
                <PcaAccountCard
                  key={`approved-${account.accountId}`}
                  account={account}
                  view="coverage"
                  blockExplorerUrl={blockExplorerUrl}
                  onManage={onManage}
                  onApproveWallets={(id) => setApprove({ accountId: id, mode: 'sponsor' })}
                  onRemove={untrackAccount}
                  onRetry={() => refresh()}
                  onSwitchNetwork={switchNetwork}
                />
              ))}
            </div>
          </div>
        )}
      </section>

      {loading && accounts.length === 0 ? (
        <div className="v10-pca-card-grid">
          <div className="card v10-pca-card v10-pca-card-skeleton" aria-hidden="true" />
          <div className="card v10-pca-card v10-pca-card-skeleton" aria-hidden="true" />
        </div>
      ) : (
        <>
          <section className="v10-pca-section" data-testid="pca-owned-section">
            <div className="v10-pca-section-head">
              <div>
                <h3 className="v10-pca-section-title">Owned by me</h3>
                <p className="v10-pca-overview-caveat">
                  Connect an owner wallet to discover and manage wallet-owned PCAs. Node-owned PCAs use the daemon wallet.
                </p>
              </div>
              <div className="v10-pca-overview-cta-group">
                <button type="button" className="v10-pca-card-btn" data-testid="pca-create-owned-btn" onClick={() => setCreateOpen(true)}>
                  + Create PCA
                </button>
              </div>
            </div>
            <div className="v10-pca-overview-wallet">
              <WalletConnectControl className="compact" />
            </div>
            {ownedAccounts.length > 0 ? (
              <div className="v10-pca-owned-groups">
                <AccountGroup
                  title="This node (hot wallet)"
                  description="Daemon-owned PCAs. Owner writes use the node daemon."
                  accounts={daemonOwned}
                  blockExplorerUrl={blockExplorerUrl}
                  onManage={onManage}
                  onApproveWallets={(id) => setApprove({ accountId: id, mode: 'sponsor' })}
                  onRemove={untrackAccount}
                  onRetry={() => refresh()}
                  onSwitchNetwork={switchNetwork}
                />
                <AccountGroup
                  title={connectedWallet ? `${truncateAddress(connectedWallet)} (connected)` : 'Connected wallet'}
                  description="Wallet-managed PCAs. Owner writes are signed by the connected wallet."
                  accounts={walletOwned}
                  blockExplorerUrl={blockExplorerUrl}
                  onManage={onManage}
                  onApproveWallets={(id) => setApprove({ accountId: id, mode: 'sponsor' })}
                  onRemove={untrackAccount}
                  onRetry={() => refresh()}
                  onSwitchNetwork={switchNetwork}
                />
              </div>
            ) : walletsInconclusive ? null : (
              <p className="v10-pca-inline-status">No owned PCAs are tracked yet.</p>
            )}
          </section>

          <section className="v10-pca-section" data-testid="pca-tracked-external-section">
            <div className="v10-pca-account-group-head">
              <h3 className="v10-pca-section-title">Tracked external accounts</h3>
              <span className="v10-pca-account-group-count">{trackedExternal.length}</span>
            </div>
            <p className="v10-pca-overview-caveat">
              Read-only PCA records you track manually. Connect the owner wallet to manage one.
            </p>
            {trackedExternal.length > 0 ? (
              <div className="v10-pca-card-grid">
                {trackedExternal.map((account) => (
                  <PcaAccountCard
                    key={`external-${account.accountId}`}
                    account={account}
                    view="owner"
                    blockExplorerUrl={blockExplorerUrl}
                    onManage={onManage}
                    onRemove={untrackAccount}
                    onRetry={() => refresh()}
                    onSwitchNetwork={switchNetwork}
                  />
                ))}
              </div>
            ) : (
              <p className="v10-pca-inline-status">No external PCAs are tracked manually.</p>
            )}
            <TrackByIdDisclosure onTrack={trackAccountById} />
          </section>
        </>
      )}

      {manualTrackPending && (
        <p className="v10-pca-track-status" role="status" data-testid="pca-track-status">
          Checking PCA #{manualTrackPending}. It will appear here when the chain read returns.
        </p>
      )}

      {/* GAP-1/#9 - the OWNED enumeration failed retryably: offer a retry instead of
          silently asserting "you own none". (Agent-on discovery is independent and may
          still have populated the strip below.) */}
      {discoveredLookupError && (
        <section className="v10-pca-discovered" data-testid="pca-discovered-error" role="status">
          <p className="v10-pca-overview-caveat">
            Couldn&apos;t verify this node&apos;s Publisher Conviction Accounts; approved PCA coverage may still exist.{' '}
            <button type="button" className="v10-pca-card-btn" onClick={() => refreshDiscovered()}>Retry</button>
          </p>
        </section>
      )}

      {bootstrapState.status === 'error' && (
        <section className="v10-pca-discovered" data-testid="pca-wallet-bootstrap-error" role="status">
          <p className="v10-pca-overview-caveat">
            Note: Couldn&apos;t load wallet contract bootstrap, so connected-wallet PCA discovery is paused.{' '}
            <button type="button" className="v10-pca-card-btn" onClick={retryWalletBootstrap}>Retry</button>
          </p>
        </section>
      )}

      {walletDiscovery.error && (
        <section className="v10-pca-discovered" data-testid="pca-wallet-discovery-error" role="status">
          <p className="v10-pca-overview-caveat">
            Note: Couldn&apos;t read PCAs owned by the connected wallet. Existing tracked PCAs are still shown.{' '}
            <button type="button" className="v10-pca-card-btn" onClick={retryWalletDiscovery}>Retry</button>
          </p>
        </section>
      )}

      {walletDiscovery.loading && connectedWallet && (
        <p className="v10-pca-overview-caveat" role="status">
          Reading PCAs owned by {truncateAddress(connectedWallet)}...
        </p>
      )}

      <DiscoveredStrip items={discoveredUntracked} onTrack={trackAccount} onManage={onManage} />

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

/**
 * GAP-1 - the "discovered, not tracked" strip: PCAs this node relates to on-chain
 * (owned + agent-on) that aren't in the locally-tracked set. Agent-on ones auto-track
 * (so they don't linger here); this surfaces the rest (typically OWNED accounts created
 * elsewhere) with a [Track] affordance. Renders nothing when there's nothing to surface.
 */
function DiscoveredStrip({
  items,
  onTrack,
  onManage,
}: {
  items: DiscoveredPca[];
  onTrack: (id: string) => void;
  onManage: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="v10-pca-discovered" data-testid="pca-discovered-strip">
      <h3 className="v10-pca-discovered-title">Discovered - not tracked here</h3>
      <p className="v10-pca-overview-caveat">
        Found on-chain for this node&apos;s wallets or the connected wallet. Track to show them in the grid above.
      </p>
      {items.map((d) => {
        const bps = d.basics?.discountBps;
        return (
          <div key={d.accountId} className="v10-pca-discovered-row" data-testid="pca-discovered-row">
            <span className="v10-pca-discovered-label">
              <button type="button" className="v10-notif-cg-link" onClick={() => onManage(d.accountId)}>
                PCA #{d.accountId}
              </button>{' '}
              -{' '}
              {d.relation === 'agent'
                ? `your wallet ${d.agentWallet ? truncateAddress(d.agentWallet) : ''} is approved here`
                : d.relation === 'both'
                  ? 'you own this; your wallet is approved here'
                  : 'you own this account'}
              {/* #9 - only show the discount on accounts this node actually DRAWS from
                  (a wallet is an approved agent). On an owned-ONLY account no wallet is
                  approved, so the account's tier isn't a discount this node realizes -
                  showing a percentage there reads as a false "you'd get this %". */}
              {(d.relation === 'agent' || d.relation === 'both') && typeof bps === 'number' && bps > 0 && (
                <span className="badge badge-info"> {(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%</span>
              )}
            </span>
            <button
              type="button"
              className="v10-pca-card-btn primary"
              data-testid="pca-discovered-track"
              onClick={() => onTrack(d.accountId)}
            >
              Track
            </button>
          </div>
        );
      })}
    </section>
  );
}

function AccountGroup({
  title,
  description,
  accounts,
  blockExplorerUrl,
  onManage,
  onApproveWallets,
  onRemove,
  onRetry,
  onSwitchNetwork,
}: {
  title: string;
  description: string;
  accounts: OverviewAccount[];
  blockExplorerUrl?: string | null;
  onManage?: (id: string) => void;
  onApproveWallets?: (id: string) => void;
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
  onSwitchNetwork?: () => void;
}) {
  if (accounts.length === 0) return null;
  return (
    <section className="v10-pca-account-group">
      <div className="v10-pca-account-group-head">
        <h3 className="v10-pca-account-group-title">{title}</h3>
        <span className="v10-pca-account-group-count">{accounts.length}</span>
      </div>
      <p className="v10-pca-overview-caveat">{description}</p>
      <div className="v10-pca-card-grid">
        {accounts.map((account) => (
          <PcaAccountCard
            key={account.accountId}
            account={account}
            view="owner"
            blockExplorerUrl={blockExplorerUrl}
            onManage={onManage}
            onApproveWallets={onApproveWallets}
            onRemove={onRemove}
            onRetry={onRetry}
            onSwitchNetwork={onSwitchNetwork}
          />
        ))}
      </div>
    </section>
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
        Track PCA by ID
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
