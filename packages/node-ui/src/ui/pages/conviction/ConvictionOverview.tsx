import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { Address } from 'viem';
import { useAgentsStore } from '../../stores/agents.js';
import { useTabsStore } from '../../stores/tabs.js';
import { usePcaStore } from '../../stores/pca.js';
import { isWrongNetwork, useWalletStore } from '../../stores/wallet.js';
import { usePcaOverview, type ResolvedPcaAccount } from '../../hooks/usePcaOverview.js';
import { useDiscoveredPcas, type DiscoveredPca } from '../../hooks/useDiscoveredPcas.js';
import { listPcaContracts, type PcaContracts } from '../../api.js';
import { publicClientFor } from '../../web3/clients.js';
import { publishingConvictionNftAbi } from '../../web3/pcaContract.js';
import { DiscountTierLadder, WalletConnectControl, truncateAddress } from '../../components/Pca/index.js';
import { EmptyState } from '../../components/ContextGraphPrimitives.js';
import { PcaAccountCard, type PcaAccountOwnerMode } from './PcaAccountCard.js';
import { CreatePcaModal } from './CreatePcaModal.js';
import { ApproveWalletsModal } from './ApproveWalletsModal.js';
import { GetSponsoredPanel } from './GetSponsoredPanel.js';

type ViewFilter = 'owned' | 'approved';
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
  const { accounts, loading, covered, refresh, walletsInconclusive } = overview;
  const primaryWallet = overview.wallets[0];

  useEffect(() => {
    let cancelled = false;
    async function bootstrapWalletLayer() {
      setBootstrapState({ status: 'loading', error: null });
      try {
        const contracts = await listPcaContracts();
        if (cancelled) return;
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
  }, [bootstrapNonce, initWallet, setWalletBootstrap]);

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
  // GAP-1 — PCAs this node relates to on-chain (owned + agent-on) beyond the locally
  // tracked set. Agent-on auto-tracks (edge self-heal); the rest surface in the strip.
  // `ownedError` = the enumeration failed retryably (#9 — don't assert "you own none").
  const { untracked: discoveredUntracked, ownedError: discoveredOwnedError, refresh: refreshDiscovered } =
    useDiscoveredPcas();

  // O2 — DERIVED default so the filter auto-reacts to the async role (a useState
  // initializer runs ONCE, so an edge node whose status resolved AFTER mount stayed
  // stuck on 'owned' and hid its sponsorships). The role default applies until the
  // user explicitly picks a tab, after which their choice is preserved.
  const [userFilter, setUserFilter] = useState<ViewFilter | null>(null);
  const defaultFilter: ViewFilter = role === 'edge' ? 'approved' : 'owned';
  const filter = userFilter ?? defaultFilter;
  const [createOpen, setCreateOpen] = useState(false);
  const [approve, setApprove] = useState<{ accountId: string; mode: 'self' | 'sponsor'; selfCoverage?: boolean } | null>(null);
  const [sponsoredOpen, setSponsoredOpen] = useState(false);

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
        (a) => (a.ownerMode !== 'daemon' && a.ownerMode !== 'wallet' && a.approvedCount > 0) || (!a.snapshot && !a.notFound),
      ),
    [enhancedAccounts],
  );

  const onManage = (id: string) => openTab({ id: `conviction:${id}`, label: `PCA #${id}`, closable: true });
  const visible = filter === 'owned' ? [...daemonOwned, ...walletOwned, ...trackedExternal] : approved;

  const retryWalletBootstrap = useCallback(() => setBootstrapNonce((n) => n + 1), []);
  const retryWalletDiscovery = useCallback(() => setWalletDiscoveryNonce((n) => n + 1), []);
  const switchNetwork = useCallback(() => {
    void switchToExpectedChain();
  }, [switchToExpectedChain]);

  return (
    <div className="v10-pca-overview" data-testid="pca-landing">
      <header className="v10-pca-overview-head">
        <div className="v10-pca-overview-titlerow">
          <h2 className="v10-pca-overview-title">Publishing Conviction</h2>
          {role && <span className="badge v10-pca-role-chip">Role: ◆ {role}</span>}
        </div>
        <p className="v10-pca-overview-explainer">
          {role === 'edge'
            ? "Edge nodes usually start by getting sponsored: a core node approves your operational wallet(s), and you still pay your own gas. You can also create a PCA by choosing a staked primary node; getting sponsored is the free path."
            : "A Publishing Conviction Account (PCA) lets you lock TRAC up front, publish at a discount, and sponsor other nodes. The discount applies to the wallet that SIGNS the publish (on-chain msg.sender) — not a peerId, admin wallet, or author identity."}
        </p>
      </header>

      {/* T2/#9 — suppress the definitive "no discount" banner when the wallets read
          failed; coverage can't be confirmed off an empty wallet set. */}
      {role === 'edge' && !loading && !covered && !walletsInconclusive && (
        <div className="v10-pca-edge-banner" role="status">
          <EmptyState
            tone="warning"
            title="No PCA discount on this node"
            description="No conviction account covers this node’s publishes, so each publish pays the direct cost from the signing wallet. Ask a core-node operator to sponsor you."
            actions={[{ label: 'Get sponsored', onClick: () => setSponsoredOpen(true), variant: 'primary' }]}
          />
        </div>
      )}

      {walletsInconclusive && (
        <div className="v10-pca-edge-banner" role="status">
          <p className="v10-pca-overview-caveat">
            ⓘ Couldn’t read this node’s wallets — ownership and coverage can’t be confirmed.{' '}
            <button type="button" className="v10-pca-card-btn" onClick={() => refresh()}>Retry</button>
          </p>
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
        <div className="v10-pca-overview-wallet">
          <WalletConnectControl />
        </div>
        {role === 'edge' ? (
          // Sub-PR 1 (§5.6/§5.1) — edge can now create too: Get sponsored stays the
          // PRIMARY/recommended-free CTA; Create is an available SECONDARY alongside it.
          <div className="v10-pca-overview-cta-group">
            <button
              type="button"
              className="v10-pca-card-btn primary"
              onClick={() => setSponsoredOpen(true)}
            >
              Share my wallet → get sponsored
            </button>
            <button
              type="button"
              className="v10-pca-card-btn"
              data-testid="pca-create-btn"
              onClick={() => setCreateOpen(true)}
            >
              + Create a conviction account
            </button>
          </div>
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
          {filter === 'owned' ? (
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
              <AccountGroup
                title="Tracked (external - connect to manage)"
                description="Read-only until the owner wallet is connected. Reads still work."
                accounts={trackedExternal}
                blockExplorerUrl={blockExplorerUrl}
                onManage={onManage}
                onApproveWallets={(id) => setApprove({ accountId: id, mode: 'sponsor' })}
                onRemove={untrackAccount}
                onRetry={() => refresh()}
                onSwitchNetwork={switchNetwork}
              />
            </div>
          ) : (
            <div className="v10-pca-card-grid">
              {approved.map((account) => (
                <PcaAccountCard
                  key={account.accountId}
                  account={account}
                  blockExplorerUrl={blockExplorerUrl}
                  onManage={onManage}
                  onApproveWallets={(id) => setApprove({ accountId: id, mode: 'sponsor' })}
                  onRemove={untrackAccount}
                  onRetry={() => refresh()}
                  onSwitchNetwork={switchNetwork}
                />
              ))}
            </div>
          )}
          {filter === 'approved' && (
            <p className="v10-pca-overview-caveat">
              ⓘ The chain exposes how many wallets are approved, not the full list. Wallets you
              approved here and any you probe are shown; others may exist.
            </p>
          )}
        </>
      ) : walletsInconclusive ? (
        // T2 — the "couldn't read wallets" notice above already explains; don't also
        // assert a misleading OwnedEmpty/ApprovedEmpty off the unreadable wallet set.
        null
      ) : filter === 'owned' ? (
        <OwnedEmpty role={role} />
      ) : (
        <ApprovedEmpty />
      )}

      {/* GAP-1/#9 — the OWNED enumeration failed retryably: offer a retry instead of
          silently asserting "you own none". (Agent-on discovery is independent and may
          still have populated the strip below.) */}
      {discoveredOwnedError && (
        <section className="v10-pca-discovered" data-testid="pca-discovered-error" role="status">
          <p className="v10-pca-overview-caveat">
            ⓘ Couldn’t load your Publishing Conviction Accounts — any you own may still exist.{' '}
            <button type="button" className="v10-pca-card-btn" onClick={() => refreshDiscovered()}>Retry</button>
          </p>
        </section>
      )}

      {bootstrapState.status === 'error' && (
        <section className="v10-pca-discovered" data-testid="pca-wallet-bootstrap-error" role="status">
          <p className="v10-pca-overview-caveat">
            ⓘ Couldn’t load wallet contract bootstrap, so connected-wallet PCA discovery is paused.{' '}
            <button type="button" className="v10-pca-card-btn" onClick={retryWalletBootstrap}>Retry</button>
          </p>
        </section>
      )}

      {walletDiscovery.error && (
        <section className="v10-pca-discovered" data-testid="pca-wallet-discovery-error" role="status">
          <p className="v10-pca-overview-caveat">
            ⓘ Couldn’t read PCAs owned by the connected wallet. Existing tracked PCAs are still shown.{' '}
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

      <TrackByIdDisclosure onTrack={trackAccount} />

      <p className="v10-pca-overview-foot">
        ⓘ PCAs you own or whose approved wallet is one of this node’s are discovered from the chain;
        ids you track persist across reloads. Approved-on accounts are tracked automatically.
      </p>

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
 * GAP-1 — the "discovered, not tracked" strip: PCAs this node relates to on-chain
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
      <h3 className="v10-pca-discovered-title">Discovered — not tracked here</h3>
      <p className="v10-pca-overview-caveat">
        ⓘ Found on-chain for this node’s wallets or the connected wallet. Track to show them in the grid above.
      </p>
      {items.map((d) => {
        const bps = d.basics?.discountBps;
        return (
          <div key={d.accountId} className="v10-pca-discovered-row" data-testid="pca-discovered-row">
            <span className="v10-pca-discovered-label">
              <button type="button" className="v10-notif-cg-link" onClick={() => onManage(d.accountId)}>
                PCA #{d.accountId}
              </button>{' '}
              —{' '}
              {d.relation === 'agent'
                ? `your wallet ${d.agentWallet ? truncateAddress(d.agentWallet) : ''} is approved here`
                : d.relation === 'both'
                  ? 'you own this · your wallet is approved here'
                  : 'you own this account'}
              {/* 🟢/#9 — only show the discount on accounts this node actually DRAWS from
                  (a wallet is an approved agent). On an owned-ONLY account no wallet is
                  approved, so the account's tier isn't a discount this node realizes —
                  showing "◉ %" there reads as a false "you'd get this %". */}
              {(d.relation === 'agent' || d.relation === 'both') && typeof bps === 'number' && bps > 0 && (
                <span className="badge badge-info"> ◉ {(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%</span>
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

function OwnedEmpty({ role }: { role?: 'core' | 'edge' }) {
  if (role === 'edge') {
    // Sub-PR 1 (§5.6) — edge CAN own a PCA now (by designating a staked node as primary).
    // Get sponsored stays the recommended free path; creating is the available alternative.
    return (
      <EmptyState
        tone="neutral"
        title="Get sponsored — or create your own"
        description="The free path: have a core node approve your operational wallets (Get sponsored — no TRAC locked). You can also create your own conviction account by designating a staked node as its primary node — you get the discount, and the reward weight accrues to the node you pick."
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
