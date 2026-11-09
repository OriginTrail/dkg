import React from 'react';
import { useFetch } from '../../hooks.js';
import { fetchPca, fetchWalletsBalances, type PcaSnapshot } from '../../api.js';
import { usePinnedOwnerActionSubmitter } from '../../pca/ownerActions.js';
import { useWalletTxProgress } from '../../pca/useWalletTxProgress.js';
import { useWalletBootstrap } from '../../hooks/useWalletBootstrap.js';
import { detailDeviceFlow, describeDetailWalletError, type DetailDeviceAction } from '../../pca/detailWalletTx.js';
import { useAgentsStore } from '../../stores/agents.js';
import { useWalletStore } from '../../stores/wallet.js';
import {
  HealthChip,
  WalletRow,
  WalletConnectControl,
  WalletPill,
  DeviceConfirmProgress,
  formatPcaTrac,
  formatWeiToTrac,
  formatExpiryShort,
  RetryButton,
  truncateAddress,
} from '../../components/Pca/index.js';
import { healthForSnapshot } from '../../pca/health.js';
import { StatStrip } from '../../components/ContextGraphPrimitives.js';
import { FundingSection } from './FundingSection.js';
import { PublishingWalletsSection } from './PublishingWalletsSection.js';
import { LifecycleSection } from './LifecycleSection.js';
import { eqAddress } from '../../web3/address.js';
import { resolvePrimaryWalletState, type PcaOwnerAccess } from '../../pca/ownerAccess.js';
import { usePcaOwnerAccess } from '../../pca/usePcaOwnerAccess.js';
import { Badge, StatusGlyph } from '../../components/ds/Badge.js';
import { BadgePercent } from 'lucide-react';
import { Loading } from '../../components/ds/Loading.js';
import { bpsToPercent } from '../../lib/format.js';
import { ExternalMark } from '../../components/ds/ExternalMark.js';
import { Breadcrumbs } from '../../components/ds/Breadcrumbs.js';
import { useTabsStore } from '../../stores/tabs.js';

function formatExpiryTileValue(expiresAtTimestamp?: number): string {
  return formatExpiryShort(expiresAtTimestamp) ?? 'Expiry unknown';
}

/**
 * S3 PCA Detail (Manage). Owner actions are enabled for the daemon-owned branch
 * and for the connected-wallet-owned branch on the right network; external PCAs
 * remain read-only. The wallet probe stays enabled for everyone.
 */
export function ConvictionDetailView({ accountId }: { accountId: string }) {
  // GAP-4/5 — the S3 detail view opts into the EXTENDED snapshot (remainingAllowance /
  // primaryNode / currentEpoch) for the budget widget. It's a single on-mount read (not a
  // hot poll), so the extra readback cost is fine here; the fields are best-effort (absent
  // on read-failure → the widget shows nothing, never a false value).
  const { data: rawSnapshot, loading, error, refresh } = useFetch(() => fetchPca(accountId, undefined, { extended: true }), [accountId]);
  const snapshot = rawSnapshot?.accountId === accountId ? rawSnapshot : null;
  const { data: wb, error: wbError, refresh: refreshWallets } = useFetch(fetchWalletsBalances, [], 0);
  const nodeStatus = useAgentsStore((s) => s.nodeStatus) as { blockExplorerUrl?: string | null } | null;
  const explorer = nodeStatus?.blockExplorerUrl ?? null;
  const connectedWallet = useWalletStore((s) => s.address);
  const wallets = wb?.wallets ?? [];
  // The wallet-list load state (#1470): split loading from unreadable so a daemon PCA shows
  // "loading" (mode 'unknown'), NOT a read-only/external flash, while the balances fetch is in
  // flight. L3: a balances READ FAILURE (wb null + error) still classifies unknown ('unreadable') —
  // the owner controls read "can't confirm ownership" + Retry, never a definitive non-owner.
  const primaryWalletState = resolvePrimaryWalletState(wb, wbError);
  // #1375 — the single owner-access model. Called before the early returns (Rules of
  // Hooks); while the snapshot is still loading `owner` is undefined and this render path
  // returns early below, so the resulting access is never consumed on that path.
  const access = usePcaOwnerAccess({ owner: snapshot?.owner, primaryWallet: wallets[0], primaryWalletState });

  useWalletBootstrap();

  if (loading && !snapshot) return <Loading block label={`Loading PCA #${accountId}…`} />;
  if (error || !snapshot) {
    return (
      <div className="v10-pca-detail">
        <div className="card ds-card">
          <div className="card-body v10-pca-card-error">
            <p>Couldn’t load PCA #{accountId}.</p>
            <RetryButton onClick={() => refresh()} />
          </div>
        </div>
      </div>
    );
  }

  const ownerInPool = wallets.some((w) => eqAddress(w, snapshot.owner));
  // Owner can't be classified because this node's wallet list is loading or unreadable (#1470).
  // `owner` is present here (past the snapshot early-returns), so this is never the no-snapshot
  // cause — split the two so a still-LOADING read shows a neutral "confirming ownership" affordance
  // (no false "Couldn't load", no Retry), while a FAILED read keeps the "can't confirm" + Retry.
  // Both stay `unknown` (never a definitive read-only/external verdict — the daemon-flash fix).
  const walletsLoading = access.ownerUnknownCause === 'wallets-loading';
  const walletsUnreadable = access.ownerUnknownCause === 'wallets-unreadable';

  // gateReason stays consumer-built for now (model gateReason deferred to a later step): the
  // exact same branches, re-expressed on access.mode / access.wrongNetwork — identical values
  // to the old ownerMode / walletWrongNetwork now that both come from the one model.
  const owner = truncateAddress(snapshot.owner);
  const ownerGateReason = walletsLoading
    ? `Confirming ownership of PCA #${accountId}…`
    : walletsUnreadable
    ? `Couldn’t load this node’s wallets, so we can’t confirm who owns PCA #${accountId}.`
    : access.mode === 'wallet' && access.wrongNetwork
    ? `The PCA owner wallet is on another network. Switch it to this node’s network to change PCA #${accountId}.`
    : access.mode === 'wallet'
    ? `Your connected wallet is the PCA owner wallet, so you can change PCA #${accountId}.`
    : ownerInPool
    ? `Only the PCA owner wallet (${owner}) can change PCA #${accountId}. It’s one of this node’s operational wallets, but the node signs PCA changes only with its primary operational wallet.`
    : connectedWallet
    ? `You’re connected with a different wallet. Only the PCA owner wallet (${owner}) can change PCA #${accountId}.`
    : `Only the PCA owner wallet (${owner}) can change PCA #${accountId}.`;

  return (
    <DetailBody
      accountId={accountId}
      snapshot={snapshot}
      wallets={wallets}
      ownerTrac={wb?.balances?.find((b) => eqAddress(b.address, snapshot.owner))?.trac}
      explorer={explorer}
      access={access}
      connectedWallet={connectedWallet}
      ownerOnlyReason={ownerGateReason}
      walletsLoading={walletsLoading}
      walletsUnreadable={walletsUnreadable}
      onRetryWallets={refreshWallets}
      refresh={refresh}
    />
  );
}

function DetailBody({
  accountId,
  snapshot,
  wallets,
  ownerTrac,
  explorer,
  access,
  connectedWallet,
  ownerOnlyReason,
  walletsLoading,
  walletsUnreadable,
  onRetryWallets,
  refresh,
}: {
  accountId: string;
  snapshot: PcaSnapshot;
  wallets: string[];
  ownerTrac?: string;
  explorer: string | null;
  access: PcaOwnerAccess;
  connectedWallet?: string | null;
  ownerOnlyReason: string;
  /** Wallet list still loading (owner unconfirmed) → neutral affordance, no Retry. */
  walletsLoading: boolean;
  /** Wallet list read FAILED (owner unconfirmable) → "can't confirm" + Retry. */
  walletsUnreadable: boolean;
  onRetryWallets: () => void;
  refresh: () => void;
}) {
  const deviceProgress = useWalletTxProgress<DetailDeviceAction>({
    labels: {
      idle: 'Confirm on your device',
      approveActive: 'Confirm on your device (1 of 2): approve TRAC',
      approveReady: 'Allowance ready — continue to the owner action',
      actionActive: (v) =>
        v === 'remove' ? 'Confirm on your device: remove wallet' : 'Confirm on your device (2 of 2): top up',
      submitted: 'Waiting for on-chain confirmation',
      confirmed: 'Transaction confirmed on-chain',
      failed: 'Wallet transaction failed',
    },
    flow: (v) => detailDeviceFlow(v ?? 'topup'),
    describeActionError: (err, v) => describeDetailWalletError(err, v ?? 'topup'),
  });
  const owner = usePinnedOwnerActionSubmitter({
    // Item 3 (#1375) — resolve the owner submitter ONCE from `access` for THIS account. daemon
    // pins (server-side); a wallet-owned account re-verifies ownership per write (T1). Wallet
    // device progress flows through onWalletProgress; the submitter liveness stays per-prompt.
    access,
    onWalletProgress: access.mode === 'wallet' ? deviceProgress.onProgress : undefined,
  });
  const health = healthForSnapshot(snapshot);
  const ownerTitle = access.writesEnabled ? undefined : ownerOnlyReason;

  const pct = bpsToPercent(snapshot.discountBps);
  const walletSurfaceCopy = connectedWallet
    ? access.mode === 'wallet'
      ? access.wrongNetwork
        ? 'Your connected wallet is the PCA owner wallet, but it’s on another network. Switch networks to top up, approve wallets or renew this PCA.'
        : 'Your connected wallet is the PCA owner wallet. It signs top-ups, wallet approvals, removals and renewals.'
      : access.mode === 'daemon'
        ? 'This node owns this PCA and signs changes itself. You don’t need to connect a wallet.'
        : `Your connected wallet isn’t the PCA owner wallet. To top up, approve wallets or renew this PCA, switch to ${truncateAddress(snapshot.owner)}.`
    : access.mode === 'external'
      ? 'To top up, approve wallets or renew this PCA, connect the PCA owner wallet.'
      : 'To manage a PCA that a wallet owns, connect that wallet.';
  // Not connected to someone else's PCA: the line above already says what to do, so no warning repeats it.
  const ownerNoticeRepeats = !connectedWallet && access.mode === 'external' && !walletsUnreadable
    && !wallets.some((w) => eqAddress(w, snapshot.owner));

  const openTab = useTabsStore.getState().openTab;
  return (
    <div className="v10-pca-detail" data-testid="pca-detail">
      <div className="ds-crumbs-bar">
        <Breadcrumbs items={[{ label: 'Publisher Conviction', onClick: () => openTab({ id: 'conviction', label: 'Publisher Conviction', closable: true }) }, { label: `PCA #${accountId}` }]} />
      </div>
      <div className="v10-pca-detail-band">
        <h1 className="ds-page-title">PCA #{accountId}</h1>
        <Badge size="sm" icon={<BadgePercent size={12} />}>{pct}% discount</Badge>
        <span className="v10-pca-detail-committed">{formatPcaTrac(snapshot.committedTRACTrac)} TRAC committed</span>
        <span className="v10-pca-card-spacer" />
        <HealthChip state={health} />
      </div>

      {snapshot.fullySwept && (
        <p className="v10-pca-overview-caveat">Any leftover top-up went to the staker reward pool.</p>
      )}

      <div className="v10-modal-tip ds-card-nested v10-pca-wallet-surface" role="status">
        <p className="v10-pca-wallet-surface-copy">{walletSurfaceCopy}</p>
        {connectedWallet ? <WalletPill /> : <WalletConnectControl testId="pca-wallet-connect" />}
      </div>

      {deviceProgress.steps.length > 0 && (
        <DeviceConfirmProgress
          steps={deviceProgress.steps}
          currentLabel={deviceProgress.currentLabel}
          blockExplorerUrl={explorer}
        />
      )}

      {!access.writesEnabled && !ownerNoticeRepeats && (
        // Pure LOADING window (#1470): a neutral "confirming ownership" tip — no false "Couldn't
        // load", no Retry (the balances are auto-fetching); owner controls stay disabled for the
        // brief window. FAILED/EXTERNAL/wrong-network keep the warning box (+ Retry when unreadable).
        walletsLoading ? (
          <div className="v10-modal-tip ds-card-nested" role="status">{ownerOnlyReason}</div>
        ) : (
          <div className="v10-pca-retry-block">
            <div className="v10-modal-warning ds-card-nested v10-pca-notice" role="status">
              <StatusGlyph tone="warning" /> {ownerOnlyReason}{walletsUnreadable ? null : ' You can still check whether a wallet is approved.'}
            </div>
            {walletsUnreadable && <RetryButton onClick={onRetryWallets} />}
          </div>
        )
      )}

      <StatStrip
        items={[
          { id: 'buffer', label: 'Top-up buffer', value: `${formatPcaTrac(snapshot.topUpBufferTrac)} TRAC` },
          { id: 'per-epoch', label: 'Per-epoch allowance', value: `${formatWeiToTrac(snapshot.baseEpochAllowance)} TRAC` },
          // GAP-4/5 — the precise current-epoch remaining allowance (extended snapshot,
          // best-effort). Display only — the coverage spine stays the coarse proxy (#1349
          // is a separate decision). Omitted when the extended read didn't return it.
          ...(snapshot.remainingAllowanceTrac != null
            ? [{
                id: 'remaining',
                label: 'Remaining this epoch',
                value: `${formatPcaTrac(snapshot.remainingAllowanceTrac)} TRAC`,
                tooltip: snapshot.currentEpoch != null ? `Current epoch ${snapshot.currentEpoch}` : undefined,
              }]
            : []),
          { id: 'wallets', label: 'Publishing wallets', value: `${snapshot.agentCount} / 100` },
          { id: 'expires', label: 'Expires in', value: formatExpiryTileValue(snapshot.expiresAtTimestamp), tooltip: `Expiry epoch ${snapshot.expiresAtEpoch}` },
          // GAP-4/5 — the node this PCA directs publishing-reward weight to. '0' = none set;
          // ABSENT (read-failed) → omit, never a false value.
          ...(snapshot.primaryNode != null
            ? [{
                id: 'primary-node',
                label: 'Primary node',
                value: snapshot.primaryNode === '0' ? 'None set' : `Node #${snapshot.primaryNode}`,
                tooltip: snapshot.lastPrimaryNodeChangeEpoch != null ? `Last changed epoch ${snapshot.lastPrimaryNodeChangeEpoch}` : undefined,
              }]
            : []),
        ]}
      />
      <div className="v10-pca-detail-owner">
        <span className="v10-pca-card-owner-lbl">Owner</span>
        <WalletRow
          address={snapshot.owner}
          trailing={explorer ? <a className="v10-pca-text-link" href={`${explorer}/address/${snapshot.owner}`} target="_blank" rel="noreferrer" aria-label="View owner on explorer"><ExternalMark /></a> : undefined}
        />
      </div>

      <FundingSection
        accountId={accountId}
        snapshot={snapshot}
        ownerTrac={ownerTrac}
        explorer={explorer}
        access={access}
        ownerTitle={ownerTitle}
        owner={owner}
        deviceProgress={deviceProgress}
        refresh={refresh}
      />
      <PublishingWalletsSection
        accountId={accountId}
        snapshot={snapshot}
        wallets={wallets}
        explorer={explorer}
        access={access}
        ownerTitle={ownerTitle}
        owner={owner}
        deviceProgress={deviceProgress}
        refresh={refresh}
      />
      <LifecycleSection
        accountId={accountId}
        snapshot={snapshot}
        access={access}
        ownerTitle={ownerTitle}
        health={health}
      />
    </div>
  );
}
