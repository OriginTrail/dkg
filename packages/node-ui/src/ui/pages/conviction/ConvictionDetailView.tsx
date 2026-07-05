import React from 'react';
import { useFetch } from '../../hooks.js';
import { fetchPca, fetchWalletsBalances, type PcaSnapshot } from '../../api.js';
import { useOwnerActionSubmitter } from '../../pca/ownerActions.js';
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
  formatRelativeExpiry,
} from '../../components/Pca/index.js';
import { healthForSnapshot } from '../../pca/health.js';
import { StatStrip } from '../../components/ContextGraphPrimitives.js';
import { FundingSection } from './FundingSection.js';
import { PublishingWalletsSection } from './PublishingWalletsSection.js';
import { LifecycleSection } from './LifecycleSection.js';
import { eqAddress } from '../../pca/address.js';
import { usePcaOwnerAccess, type PcaOwnerAccess } from '../../pca/ownerAccess.js';

function formatExpiryTileValue(expiresAtTimestamp?: number): string {
  return formatRelativeExpiry(expiresAtTimestamp).replace(/^Expires in /, '');
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
  // L3: a transient balances blip (wb null + error) must NOT reclassify
  // owned→not-owner and flicker the owner controls into a definitive "you're not
  // the owner" — show "can't confirm" instead and keep the retry.
  const walletsUnknown = !wb && !!wbError;
  // #1375 — the single owner-access model. Called before the early returns (Rules of
  // Hooks); while the snapshot is still loading `owner` is undefined and this render path
  // returns early below, so the resulting access is never consumed on that path.
  const access = usePcaOwnerAccess({ owner: snapshot?.owner, primaryWallet: wallets[0], walletsUnknown });

  useWalletBootstrap();

  if (loading && !snapshot) return <div className="lazy-spinner">Loading PCA #{accountId}…</div>;
  if (error || !snapshot) {
    return (
      <div className="v10-pca-detail">
        <div className="card">
          <div className="card-body v10-pca-card-error">
            <p>Couldn’t load PCA #{accountId}.</p>
            <button type="button" className="v10-pca-card-btn" onClick={() => refresh()}>Retry</button>
          </div>
        </div>
      </div>
    );
  }

  const ownerInPool = wallets.some((w) => eqAddress(w, snapshot.owner));

  // gateReason stays consumer-built for now (model gateReason deferred to a later step): the
  // exact same branches, re-expressed on access.mode / access.wrongNetwork — identical values
  // to the old ownerMode / walletWrongNetwork now that both come from the one model.
  const ownerGateReason = walletsUnknown
    ? `Couldn't load this node's wallets - can't confirm ownership of PCA #${accountId}.`
    : access.mode === 'wallet' && access.wrongNetwork
      ? `Wrong network - switch the connected wallet to this node's PCA network to manage PCA #${accountId}.`
      : access.mode === 'wallet'
        ? `Connected wallet ${snapshot.owner} owns PCA #${accountId}; device-signed owner actions are enabled.`
        : ownerInPool
          ? `Owner-only - PCA #${accountId} is owned by ${snapshot.owner}, not this node's primary operational wallet, so node-UI can't sign for it.`
          : connectedWallet
            ? `Owner-only - connected as ${connectedWallet}; switch to ${snapshot.owner} to manage PCA #${accountId}.`
            : `Owner-only - connect ${snapshot.owner} to manage PCA #${accountId}.`;

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
      walletsUnknown={walletsUnknown}
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
  walletsUnknown,
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
  walletsUnknown: boolean;
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
  const owner = useOwnerActionSubmitter({
    accountId,
    // Item 3 (#1375) — resolve the owner submitter ONCE from `access` (no per-write re-fetch);
    // top-up / deregister on THIS account submit directly. Wallet liveness stays per-prompt.
    access,
    onWalletProgress: access.mode === 'wallet' ? deviceProgress.onProgress : undefined,
  });
  const health = healthForSnapshot(snapshot);
  const ownerTitle = access.writesEnabled ? undefined : ownerOnlyReason;

  const pct = (snapshot.discountBps / 100).toFixed(snapshot.discountBps % 100 === 0 ? 0 : 1);
  const walletSurfaceCopy = connectedWallet
    ? access.mode === 'wallet'
      ? access.wrongNetwork
        ? 'Owner wallet matches; switch network before signing owner actions.'
        : 'Connected owner wallet will sign top-up, approve, remove, and renewal actions.'
      : access.mode === 'daemon'
        ? 'Connected wallet is available for wallet-owned PCAs; this account uses the node daemon for owner actions.'
        : `Connected as ${connectedWallet}; switch to ${snapshot.owner} to manage owner actions.`
    : access.mode === 'external'
      ? 'Connect the PCA owner wallet to manage this account. Provider metadata is display-only.'
      : 'Connect a wallet to view and manage wallet-owned PCAs from this tab.';

  return (
    <div className="v10-pca-detail" data-testid="pca-detail">
      <div className="v10-pca-detail-band">
        <span className="v10-pca-detail-id">PCA #{accountId}</span>
        <span className="badge badge-info">◉ {pct}% discount</span>
        <span className="v10-pca-detail-committed">{formatPcaTrac(snapshot.committedTRACTrac)} TRAC committed</span>
        <span className="v10-pca-card-spacer" />
        <HealthChip state={health} />
      </div>

      <div className="v10-modal-tip" role="status">
        {walletSurfaceCopy}
        {connectedWallet ? <WalletPill /> : <WalletConnectControl />}
      </div>

      {deviceProgress.steps.length > 0 && (
        <DeviceConfirmProgress
          steps={deviceProgress.steps}
          currentLabel={deviceProgress.currentLabel}
          blockExplorerUrl={explorer}
        />
      )}

      {!access.writesEnabled && (
        <div className="v10-modal-warning" role="status">
          ⓘ {ownerOnlyReason}{' '}
          {walletsUnknown ? (
            <button type="button" className="v10-pca-card-btn" onClick={onRetryWallets}>Retry</button>
          ) : (
            'Wallet probe stays available.'
          )}
        </div>
      )}

      <StatStrip
        items={[
          { id: 'buffer', label: 'Top-up buffer', value: `${formatPcaTrac(snapshot.topUpBufferTrac)} TRAC` },
          { id: 'per-epoch', label: 'TRAC per epoch', value: `${formatWeiToTrac(snapshot.baseEpochAllowance)} TRAC` },
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
          trailing={explorer ? <a className="v10-pca-card-explorer" href={`${explorer}/address/${snapshot.owner}`} target="_blank" rel="noreferrer" aria-label="View owner on explorer">↗</a> : undefined}
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
