import React, { useMemo, useState } from 'react';
import { useFetch } from '../../hooks.js';
import {
  fetchWalletsBalances,
  fetchPca,
  describePcaError,
  isPcaFeatureUnavailable,
  HttpError,
  type CreatePcaResult,
  type PcaSnapshot,
} from '../../api.js';
import { useOwnerActionSubmitterForAccount, type OwnerKey } from '../../pca/ownerActions.js';
import { probeWalletBindings, selfCoverageOutlook } from '../../pca/walletBinding.js';
import { useDesignatableNodes } from '../../hooks/useDesignatableNodes.js';
import { usePrimaryNodeSelection } from '../../hooks/usePrimaryNodeSelection.js';
import { useAgentsStore } from '../../stores/agents.js';
import { usePcaStore } from '../../stores/pca.js';
import { useWalletStore, isWrongNetwork } from '../../stores/wallet.js';
import {
  describeWalletTxError,
  WalletReceiptRevertedError,
  WalletReceiptWaitError,
} from '../../web3/walletTxError.js';
import { useWalletTxProgress } from '../../pca/useWalletTxProgress.js';
import {
  DeviceConfirmProgress,
  DiscountTierLadder,
  WalletConnectControl,
  WalletPill,
  WalletRow,
  formatPcaTrac,
  discountTierForTrac,
  PrimaryNodePicker,
} from '../../components/Pca/index.js';
import { PcaModalShell } from './PcaModalShell.js';

type Phase = 'form' | 'creating' | 'success' | 'reconcile';

function pctFromBps(bps: number): string {
  const p = bps / 100;
  return `${p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
}

const AMOUNT_RE = /^\d+(\.\d+)?$/;

/**
 * S2 — Create PCA (single-page, 4 sections for HW owner-key selection; DRIFT-1/2).
 * Owner key, commitment + live tier ladder, primary-node prefill, review (owner ≠ coverage), then Create →
 * read-back real discountBps → self-coverage success (#11). Guards the
 * double-mint footgun: a 504 `{code:'TIMEOUT', txHash}` persists a create-pending
 * marker and enters reconcile-before-retry (Retry disabled). The marker is
 * durable — re-opening with a pending marker resumes the reconcile state.
 */
export function CreatePcaModal({
  onClose,
  onApproveOwnWallets,
  onManage,
  onGetSponsored,
  seed,
  replacingAccountId,
  initialOwnerKey,
}: {
  onClose: () => void;
  onApproveOwnWallets: (accountId: string) => void;
  onManage: (accountId: string) => void;
  /** Routes the gated (edge / no-identity) state to S6 Get-sponsored. */
  onGetSponsored?: () => void;
  /** S2b renew — prefill the commit amount / primary node from an expiring account
   *  (re-mint REPLACEMENT). The create flow is otherwise unchanged. `primaryNodeUnknown`
   *  = the old account's primary node couldn't be read (extended snapshot failed), so the
   *  field falls back to THIS node — surface that rather than silently defaulting (LOW). */
  seed?: { tokens?: string; primaryNode?: string; primaryNodeUnknown?: boolean };
  /** S2b renew — the account being replaced; non-null drives the honest renew copy. */
  replacingAccountId?: string;
  /** S2b/HW renew — default owner key for the replacement create. */
  initialOwnerKey?: OwnerKey;
}) {
  void onGetSponsored;
  const nodeStatus = useAgentsStore((s) => s.nodeStatus) as
    | { nodeRole?: string; hasIdentity?: boolean; identityId?: string; blockExplorerUrl?: string | null }
    | null;
  // The edge/no-identity CREATE GATE is REMOVED: any node can create a PCA by designating a
  // staked sharding-table node as its `primaryNode` (via the picker). A node without its own
  // staked identity gets a non-blocking explainer (not a hard block); `hasIdentity === false`
  // (or edge) only drives that explainer now, never a gate.
  const noOwnIdentity = nodeStatus?.nodeRole === 'edge' || nodeStatus?.hasIdentity === false;
  // Still fail CLOSED while status is loading/failed (nodeStatus null): create needs the owner
  // wallet (double-mint marker) and status (picker pre-select / own-staked cross-check)
  // resolved first. A financial mutation must not proceed on unknown eligibility.
  const statusUnknown = nodeStatus == null;
  const explorer = nodeStatus?.blockExplorerUrl ?? null;

  const { data: wb } = useFetch(fetchWalletsBalances, [], 0);
  const wallets = wb?.wallets ?? [];
  const ownerWallet = wallets[0];
  const ownerTrac = wb?.balances?.find((b) => b.address === ownerWallet)?.trac;
  const ownerTracNum = ownerTrac != null ? Number(ownerTrac) : NaN;
  const walletsKey = wallets.join(',');

  const [ownerKey, setOwnerKey] = useState<OwnerKey>(initialOwnerKey ?? 'hardware');
  const walletAddress = useWalletStore((s) => s.address);
  const walletProvider = useWalletStore((s) => s.provider);
  const walletBootstrap = useWalletStore((s) => s.bootstrap);
  const walletExpectedChainId = useWalletStore((s) => s.expectedChainId);
  const walletChainId = useWalletStore((s) => s.chainId);
  const walletWrongNetwork = useWalletStore((s) => isWrongNetwork(s));
  const hardwareSelected = ownerKey === 'hardware';
  const createProgress = useWalletTxProgress({
    labels: {
      idle: 'Confirm on your device',
      approveActive: 'Confirm on your device (1 of 2): approve TRAC',
      approveReady: 'Allowance ready — continue to Create PCA',
      actionActive: 'Confirm on your device (2 of 2): Create PCA',
      submitted: 'Waiting for on-chain confirmation',
      confirmed: 'Create confirmed on-chain',
      failed: 'Wallet transaction failed',
    },
    flow: () => ({ requiresApproval: true, actionLabel: 'Sign Create PCA' }),
  });
  const owner = useOwnerActionSubmitterForAccount({ ownerKey, onWalletProgress: createProgress.onProgress });
  const finishCreate = usePcaStore((s) => s.finishCreate);
  const setCreatePending = usePcaStore((s) => s.setCreatePending);
  const clearCreatePending = usePcaStore((s) => s.clearCreatePending);
  const createPending = usePcaStore.getState().createPending;
  // T3 — reactive: whether the marker actually hit localStorage (false in a
  // no-storage env), so the reconcile screen doesn't falsely claim it survives a refresh.
  const createPendingPersisted = usePcaStore((s) => s.createPendingPersisted);

  // S2b renew — seed the commit amount from the expiring account.
  const [tokens, setTokens] = useState(seed?.tokens ?? '');
  // Resume the reconcile guard if a create is already in flight from a prior
  // session (durable marker) — never drop straight to a retryable form.
  const [phase, setPhase] = useState<Phase>(createPending ? 'reconcile' : 'form');
  const [result, setResult] = useState<(CreatePcaResult & { snapshot: PcaSnapshot | null }) | null>(null);
  const [pendingTxHash, setPendingTxHash] = useState<string | undefined>(createPending?.txHash);
  const [error, setError] = useState<string | null>(null);

  // Form-only reads are gated to the form phase: the reconcile / status-unknown / success screens
  // don't render the form, so they must not start the wallet-binding probe or the sharding-table read.
  const formActive = phase === 'form' && !statusUnknown;

  // Pre-flight wallet-binding probe — READ-ONLY, while the form is showing. Surfaces the
  // self-coverage outlook BEFORE the TRAC commit: if EVERY op wallet is already bound to a
  // sponsor's PCA, the new account would discount none of this node's own publishes (a loud
  // informed-consent warning — NOT a hard block; a node may create purely to sponsor others).
  // The per-wallet deregister-first then runs in the self-coverage loop (ApproveWalletsModal).
  const bindingSigners = useMemo(
    () => [
      { address: ownerWallet, kind: 'daemon' as const },
      ...(hardwareSelected ? [{ address: walletAddress, kind: 'wallet' as const }] : []),
    ],
    [hardwareSelected, ownerWallet, walletAddress],
  );
  const { data: bindings } = useFetch(
    () => (formActive ? probeWalletBindings(wallets, bindingSigners) : Promise.resolve([])),
    [walletsKey, ownerWallet, walletAddress, hardwareSelected, formActive],
    0,
  );
  const b1 = useMemo(() => selfCoverageOutlook(bindings ?? []), [bindings]);

  // §3b — the REQUIRED staked-node picker's list (B-staked-nodes; fetched whole, sorted desc).
  const { nodes: stakedNodes, loading: nodesLoading, error: nodesError, refresh: refreshNodes } =
    useDesignatableNodes(formActive);
  // All primary-node selection policy (renew seed / staked-default / list-down fallback / stale-clear
  // / rejected-node recovery) lives in one hook — the modal just wires value/actions to the picker.
  const { primaryNode, setPrimaryNode, ownStaked, onRejected: onPrimaryNodeRejected } = usePrimaryNodeSelection({
    seedPrimaryNode: seed?.primaryNode,
    replacingAccountId,
    identityId: nodeStatus?.identityId,
    stakedNodes,
    nodesError,
    nodesLoading,
    enabled: formActive,
  });

  const amountNum = AMOUNT_RE.test(tokens.trim()) ? Number(tokens.trim()) : NaN;
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;
  const insufficient = ownerKey !== 'hardware' && amountValid && Number.isFinite(ownerTracNum) && amountNum > ownerTracNum;
  const belowMinTier = amountValid && amountNum < 25_000;
  const estTier = useMemo(() => discountTierForTrac(amountValid ? amountNum : null), [amountNum, amountValid]);
  const primaryValid = /^\d+$/.test(primaryNode.trim()) && Number(primaryNode.trim()) > 0;
  const hardwareReady =
    !!walletProvider &&
    !!walletAddress &&
    !!walletBootstrap &&
    walletExpectedChainId != null &&
    walletChainId === walletExpectedChainId;
  const hardwarePrimaryLive =
    !hardwareSelected || stakedNodes.some((n) => String(n.identityId) === primaryNode.trim());
  const createOwnerAddress = hardwareSelected ? walletAddress ?? undefined : ownerWallet;
  // Don't allow submit until the owner wallet has loaded — the durable double-mint
  // marker is keyed on `ownerWallet`, so submitting before wallets resolve would skip
  // persisting it (the in-session reconcile would still fire, but the refresh-survival
  // guarantee wouldn't). Cheap belt-and-suspenders.
  const canSubmit =
    amountValid &&
    !insufficient &&
    primaryValid &&
    !!createOwnerAddress &&
    !statusUnknown &&
    phase === 'form' &&
    (!hardwareSelected || (hardwareReady && hardwarePrimaryLive));
  const hardwareDismissDisabled = hardwareSelected && phase === 'creating';

  const hardwareReadiness = !walletAddress
    ? 'Connect the owner wallet before choosing the hardware path.'
    : walletWrongNetwork
      ? "Switch the connected wallet to this node's PCA network before signing."
      : !walletBootstrap
        ? 'PCA contract addresses are still loading for wallet signing.'
        : null;

  const handleCreate = async () => {
    if (hardwareSelected) {
      if (!hardwareReady) {
        setError(hardwareReadiness ?? 'Connect the owner wallet before signing.');
        return;
      }
      if (!hardwarePrimaryLive) {
        onPrimaryNodeRejected();
        refreshNodes();
        setError('The selected primary node is no longer in the live staked-node list. Pick another staked node before signing.');
        return;
      }
    }
    setPhase('creating');
    setError(null);
    if (hardwareSelected) {
      createProgress.begin('create');
    } else {
      createProgress.reset();
    }
    // Set the double-mint guard at SUBMIT — before the await — so an ambiguous
    // failure (network drop / 500 / timeout, or the browser closing) AFTER the
    // tx may have broadcast can never silently fall back to a retryable form and
    // mint a second fund-locking PCA. Cleared only on success or a
    // definitely-pre-broadcast error below.
    if (createOwnerAddress) {
      const persisted = setCreatePending({ ownerEoa: createOwnerAddress, submittedAt: Date.now() });
      if (!persisted) {
        clearCreatePending();
        setError(
          'Create is blocked because this browser cannot save the create-pending safety marker. Enable local storage or use a browser profile where site storage is available.',
        );
        setPhase('form');
        return;
      }
    }
    try {
      const res = await owner.create({ tokens: tokens.trim(), primaryNode: primaryNode.trim() });
      // P1 — atomically clear the marker + track the id in one synchronous write so a
      // reload in the debounce window can't resurrect the marker or lose the new id.
      finishCreate(res.accountId);
      const snapshot = await fetchPca(res.accountId).catch(() => null);
      setResult({ ...res, snapshot });
      setPhase('success');
    } catch (err) {
      // DEFINITELY pre-broadcast → nothing hit the chain, safe to retry: clear
      // the guard and return to the form. Only a 400 (InvalidAmount /
      // PrimaryNodeNotInShardingTable / ZeroAgentAddress) or the CAPABILITY 503
      // (FEATURE_UNAVAILABLE, not a transport RPC_* 503) qualify.
      if (err instanceof HttpError && (err.status === 400 || isPcaFeatureUnavailable(err))) {
        clearCreatePending();
        const info = describePcaError(err);
        // PrimaryNodeNotInShardingTable is RECOVERABLE, not terminal: the picked node was unstaked
        // between picking and submit. CLEAR the rejected node AND refetch the list FRESH, so submit
        // stays disabled until a still-listed node is picked (the prefill re-defaults to the core's
        // own id only if it's still staked) — never re-submit the same rejected id on its numeric shape.
        if (info?.code === 'PrimaryNodeNotInShardingTable') {
          onPrimaryNodeRejected(); // clear the rejected node so it can't be re-submitted
          refreshNodes();
        }
        setError(info?.message ?? (err as Error)?.message ?? 'Create failed.');
        setPhase('form');
        return;
      }
      if (err instanceof WalletReceiptWaitError) {
        if (err.txStep === 'action' && err.txHash) {
          setPendingTxHash(err.txHash);
          if (createOwnerAddress) {
            setCreatePending({ ownerEoa: createOwnerAddress, submittedAt: Date.now(), txHash: err.txHash });
          }
          setPhase('reconcile');
          return;
        }
        clearCreatePending();
        const info = describeWalletTxError(err, 'approve');
        setError(`${info.message} Retry will re-check the allowance before asking you to sign again.`);
        setPhase('form');
        return;
      }
      if (err instanceof WalletReceiptRevertedError) {
        clearCreatePending();
        setError(describeWalletTxError(err, 'action').message);
        setPhase('form');
        return;
      }
      if (hardwareSelected) {
        clearCreatePending();
        const info = describeWalletTxError(err, 'action');
        if (info.kind === 'revert' && info.revertName === 'PrimaryNodeNotInShardingTable') {
          onPrimaryNodeRejected();
          refreshNodes();
        }
        setError(
          info.kind === 'rejected'
            ? 'The TRAC allowance is set, but account not created because you rejected the Create PCA signature. Retry to finish (no new approval needed).'
            : info.message,
        );
        setPhase('form');
        return;
      }
      // ANY ambiguous failure (504 timeout, 500, transport RPC_* 503/504, or a
      // non-HttpError network drop) → the tx MAY have broadcast. Fail toward
      // reconcile: keep the submit-time marker, enriching it with the broadcast
      // txHash when the 504 carries one. A double-mint dwarfs the friction of an
      // extra "No PCA minted — clear & retry" click on a genuine pre-broadcast blip.
      if (err instanceof HttpError && err.status === 504) {
        const body = (err.body ?? {}) as { txHash?: string };
        if (body.txHash) {
          setPendingTxHash(body.txHash);
          if (createOwnerAddress) setCreatePending({ ownerEoa: createOwnerAddress, submittedAt: Date.now(), txHash: body.txHash });
        }
      }
      setPhase('reconcile');
    }
  };

  // ----- Reconcile (double-mint guard) -----
  if (phase === 'reconcile') {
    const txUrl = explorer && pendingTxHash ? `${explorer}/tx/${pendingTxHash}` : undefined;
    const pendingOwner = createPending?.ownerEoa ?? createOwnerAddress ?? ownerWallet;
    return (
      <PcaModalShell onClose={onClose} testId="pca-create-modal" title="Confirm before retrying">
        <div className="v10-modal-body">
          <div className="v10-modal-warning" role="alert">
            ⚠ Your create transaction was submitted but we lost confirmation. We’re checking the chain
            before letting you retry — creating again could lock a <strong>second</strong> commitment of
            TRAC.
          </div>
          <div className="v10-pca-create-recon">
            {pendingTxHash && (
              <p>
                Broadcast tx{' '}
                {txUrl ? (
                  <a href={txUrl} target="_blank" rel="noreferrer">{pendingTxHash} ↗</a>
                ) : (
                  <code>{pendingTxHash}</code>
                )}
              </p>
            )}
            {createPendingPersisted ? (
              <p>
                A “create-pending” marker is saved, so this guard survives a refresh. Verify on the
                explorer whether a PCA was minted to <code>{pendingOwner ?? 'your owner wallet'}</code>:
              </p>
            ) : (
              <p className="v10-pca-create-warn" role="alert">
                ⚠ This browser blocked saving the safety marker (storage disabled or full), so this
                guard will <strong>NOT</strong> survive a refresh. Do not create again until you’ve
                verified on the explorer whether a PCA was minted to{' '}
                <code>{pendingOwner ?? 'your owner wallet'}</code>:
              </p>
            )}
            <ul className="v10-pca-create-recon-actions">
              <li>If a PCA <strong>was</strong> minted → close this, then use “Track PCA by ID” on the overview.</li>
              <li>If <strong>none</strong> was minted → clear the marker below, then you can create again.</li>
            </ul>
          </div>
        </div>
        <div className="v10-modal-footer">
          {txUrl && (
            <a className="v10-modal-btn" href={txUrl} target="_blank" rel="noreferrer">Recheck on explorer ↗</a>
          )}
          <button
            type="button"
            className="v10-modal-btn"
            onClick={() => { clearCreatePending(); setPendingTxHash(undefined); setPhase('form'); }}
          >
            No PCA minted — clear &amp; retry
          </button>
          <button type="button" className="v10-modal-btn" onClick={onClose}>Close</button>
        </div>
      </PcaModalShell>
    );
  }

  // ----- Status unknown (loading / failed) — fail CLOSED (S1) -----
  // Placed AFTER the reconcile resume (a durable create-pending marker must still
  // surface on a null-status reload) and before the form. We never assert "edge" while
  // unknown — just a neutral checking state until status (owner wallet + identity for
  // the picker pre-select) resolves.
  if (statusUnknown) {
    return (
      <PcaModalShell onClose={onClose} testId="pca-create-modal" title="Checking node eligibility…">
        <div className="v10-modal-body">
          <p className="v10-pca-create-hint" role="status">
            Confirming this node can create a Publisher Conviction Account…
          </p>
        </div>
        <div className="v10-modal-footer">
          <button type="button" className="v10-modal-btn" onClick={onClose}>Close</button>
        </div>
      </PcaModalShell>
    );
  }

  // ----- Success (self-coverage, #11) -----
  if (phase === 'success' && result) {
    const realBps = result.snapshot?.discountBps;
    const estBps = estTier.bps;
    const delta = typeof realBps === 'number' && realBps !== estBps;
    const txUrl = explorer && result.txHash ? `${explorer}/tx/${result.txHash}` : undefined;
    return (
      <PcaModalShell onClose={onClose} testId="pca-create-modal" title={`PCA #${result.accountId} created`}>
        <div className="v10-modal-body">
          <div className="v10-pca-create-success" data-testid="pca-create-success">
            <div className="v10-pca-create-success-stats">
              <span>Account <strong>#{result.accountId}</strong></span>
              {typeof realBps === 'number' && (
                <span>Discount tier <strong>{pctFromBps(realBps)}</strong></span>
              )}
              <span>Committed <strong>{formatPcaTrac(result.committedTokens)} TRAC</strong></span>
            </div>
            {delta && (
              <p className="v10-pca-create-warn">
                Heads up: the created account returned a {pctFromBps(realBps!)} discount tier instead of the previewed {pctFromBps(estBps)} tier.
              </p>
            )}
            {result.txHash && (
              <p className="v10-pca-create-tx">
                Tx{' '}
                {txUrl ? <a href={txUrl} target="_blank" rel="noreferrer">{result.txHash} ↗</a> : <code>{result.txHash}</code>}
              </p>
            )}
            <div className="v10-pca-create-warn" role="alert">
              ⚠ 0/100 wallets approved — this PCA discounts nothing yet. It covers nothing until you
              approve this node’s operational (signing) wallets.
            </div>
          </div>
        </div>
        <div className="v10-modal-footer">
          <button
            type="button"
            className="v10-modal-btn primary"
            data-testid="pca-approve-own-wallets"
            onClick={() => onApproveOwnWallets(result.accountId)}
          >
            {replacingAccountId
              ? `Re-approve PCA #${replacingAccountId}’s wallets`
              : 'Approve this node’s operational wallets'}
          </button>
          <button type="button" className="v10-modal-btn" onClick={() => onManage(result.accountId)}>
            Manage PCA #{result.accountId}
          </button>
        </div>
      </PcaModalShell>
    );
  }

  // ----- Form (4 sections, single page) -----
  return (
    <PcaModalShell
      onClose={onClose}
      testId="pca-create-modal"
      title={replacingAccountId ? `Renew — new PCA to replace #${replacingAccountId}` : 'Create a Publisher Conviction Account'}
      subtitle={replacingAccountId ? 'Re-mint a fresh account seeded from the expiring one.' : 'Lock TRAC up front to publish at a discount.'}
      dismissDisabled={hardwareDismissDisabled}
    >
      <div className="v10-modal-body">
        {error && <div className="v10-modal-error" role="alert">{error}</div>}
        {hardwareSelected && phase === 'creating' && (
          <div className="v10-modal-warning" role="status" data-testid="pca-create-hw-lock">
            Finish or reject the prompt in your wallet. Closing, backdrop click, and Esc are disabled while the
            approve-to-create sequence is in flight.
          </div>
        )}
        {hardwareSelected && phase === 'creating' && (
          <DeviceConfirmProgress
            steps={createProgress.steps.length ? createProgress.steps : createProgress.initialSteps()}
            currentLabel={createProgress.currentLabel}
            blockExplorerUrl={explorer}
          />
        )}

        {/* Section 1 — Owner key (H-D). Hardware is recommended but not verifiable; hot stays daemon-signed. */}
        <section className="v10-pca-create-section" data-testid="pca-create-owner-key">
          <h3 className="v10-pca-create-section-title">1 · Owner key</h3>
          <div className="v10-pca-owner-key-grid" role="radiogroup" aria-label="PCA owner key">
            <label className={`v10-pca-owner-key-card${ownerKey === 'hardware' ? ' selected' : ''}`}>
              <input
                type="radio"
                name="pca-owner-key"
                value="hardware"
                checked={ownerKey === 'hardware'}
                onChange={() => setOwnerKey('hardware')}
                disabled={phase === 'creating'}
              />
              <span>
                <strong>Hardware wallet (recommended)</strong>
                <small>
                  If your browser wallet is backed by a device, verify the amount and contract there.
                  The app cannot verify hardware backing from provider metadata.
                </small>
              </span>
            </label>
            <label className={`v10-pca-owner-key-card${ownerKey === 'hot' ? ' selected' : ''}`}>
              <input
                type="radio"
                name="pca-owner-key"
                value="hot"
                checked={ownerKey === 'hot'}
                onChange={() => setOwnerKey('hot')}
                disabled={phase === 'creating'}
              />
              <span>
                <strong>This node&apos;s hot wallet</strong>
                <small>No connected browser wallet is required. The daemon signs with this node&apos;s primary operational wallet.</small>
              </span>
            </label>
          </div>
          {hardwareSelected ? (
            <div className="v10-pca-owner-key-readiness">
              <WalletConnectControl />
              {hardwareReadiness && (
                <p className="v10-pca-create-warn" role="status" data-testid="pca-create-hw-readiness">
                  {hardwareReadiness}
                </p>
              )}
            </div>
          ) : ownerWallet ? (
            <div className="v10-pca-create-owner">
              <span className="v10-pca-card-owner-lbl">Hot owner</span>
              <WalletRow address={ownerWallet} />
            </div>
          ) : null}
        </section>

        {/* Sub-PR 1 (§5.2 Step 1) — NON-BLOCKING explainer for a node without its own staked
            identity (edge / no-identity). Create is NOT gated; this just surfaces the free
            alternative. Never a redirect that prevents Create. */}
        {noOwnIdentity && !replacingAccountId && (
          <div className="v10-modal-tip" role="status" data-testid="pca-create-no-identity-note">
            This node has no staked identity of its own — you can still create a PCA by choosing a
            staked node as its primary node below (you get the discount; the reward weight accrues to
            the node you pick).
          </div>
        )}

        {/* Zero-self-coverage informed consent: every op wallet is already on another PCA, so this
            account discounts NONE of your own publishes. NOT a block. (Only the ones on a LIVE
            sponsor PCA are actually "free"; dead ones get the separate warning below.) */}
        {b1.zeroSelfCoverage && (
          <div className="v10-modal-warning" role="alert" data-testid="pca-b1-zero-coverage">
            ⚠ All of this node’s operational wallets are already approved on other PCAs
            {b1.sponsorBound.length > 0 ? ' (you already get the discount free where those are live)' : ''}.
            This new account will <strong>NOT</strong> discount your own publishes. Create it only if
            you intend to approve publishing wallets for other nodes; otherwise getting added to an
            existing PCA avoids locking TRAC.
          </div>
        )}
        {b1.sponsorDead.length > 0 && (
          <div className="v10-modal-warning" role="alert" data-testid="pca-b1-sponsor-dead">
            Warning: {b1.sponsorDead.length} of this node&apos;s wallet(s) are approved on another PCA that is
            <strong> expired or swept</strong> - they are <strong>not covered</strong>, and this node
            cannot free them (it does not own that account). Ask that PCA owner to remove you, then
            re-approve them here; otherwise they stay uncovered.
          </div>
        )}
        {!b1.zeroSelfCoverage && b1.sponsorBound.length > 0 && (
          <div className="v10-modal-tip" role="status" data-testid="pca-b1-preview">
            After creating, {b1.sponsorBound.length} of your wallet(s) stay on another PCA
            (already discounted) and will not be moved; the rest are approved on the new account
            (any already on a PCA you own are deregistered from it first).
          </div>
        )}
        {/* Own-bound migration must be disclosed: these wallets are MOVED off a PCA this node
            already owns. Independent of the sponsor-bound preview (fires even when sponsorBound===0). */}
        {!b1.zeroSelfCoverage && b1.ownBound.length > 0 && (
          <div className="v10-modal-warning" role="status" data-testid="pca-b1-own-bound">
            ⚠ {b1.ownBound.length} of this node’s wallet(s) are already approved on a PCA you own.
            Self-coverage will <strong>move</strong> them — deregister from that account, then approve
            on the new one. The old account’s committed TRAC stays locked until its own expiry and
            would then cover nothing, so only proceed if you’re replacing it.
          </div>
        )}

        {/* Renew — HONEST framing: this is a NEW separate account, not an in-place
            extension; the old account's TRAC stays locked until its own expiry. */}
        {replacingAccountId && (
          <div className="v10-modal-warning" role="status" data-testid="pca-renew-note">
            ⓘ This creates a <strong>new, separate</strong> account (a new id) — it does not extend or
            reclaim PCA #{replacingAccountId}. The old account’s committed TRAC stays locked until its
            own expiry (it can’t be withdrawn early), and the new account starts at <strong>0/100</strong>
            approved wallets. The next step is pre-filled with the old account’s wallets for one-step
            re-approval.
          </div>
        )}

        {/* Section 2 — Commitment */}
        <section className="v10-pca-create-section">
          <h3 className="v10-pca-create-section-title">2 · Commitment</h3>
          <div className="v10-form-group">
            <label className="v10-form-label" htmlFor="pca-create-tokens">Commit amount (TRAC)</label>
            <input
              id="pca-create-tokens"
              data-testid="pca-create-tokens"
              className="v10-form-input"
              type="text"
              inputMode="decimal"
              value={tokens}
              onChange={(e) => setTokens(e.target.value)}
              placeholder="100000"
              autoComplete="off"
            />
          </div>
          {ownerKey !== 'hardware' && ownerTrac != null && (
            <p className="v10-pca-create-balance">
              Owner wallet balance: {formatPcaTrac(ownerTrac)} TRAC
              {insufficient && <span className="v10-pca-create-err"> — exceeds balance</span>}
            </p>
          )}
          {belowMinTier && (
            <div className="v10-modal-warning">
              ⚠ Under 25,000 TRAC earns a 0% discount — you’d lock TRAC for no benefit.
            </div>
          )}
          <DiscountTierLadder committedTrac={amountValid ? amountNum : null} />
        </section>

        {/* Section 3 — Primary node (§3b: the always-visible, REQUIRED staked-node picker) */}
        <section className="v10-pca-create-section" data-testid="pca-create-primary-node">
          <h3 className="v10-pca-create-section-title">3 · Primary node</h3>
          {/* S2b renew (LOW) — the old account's primary node couldn't be read, so the picker
              fell back to THIS node. Surface it rather than silently defaulting. */}
          {replacingAccountId && seed?.primaryNodeUnknown && (
            <p className="v10-pca-create-hint" role="status" data-testid="pca-renew-primary-unknown">
              ⓘ Couldn’t read PCA #{replacingAccountId}’s primary node — defaulting to this node. Pick a
              different staked node below if the replacement should point elsewhere.
            </p>
          )}
          <PrimaryNodePicker
            nodes={stakedNodes}
            loading={nodesLoading}
            error={nodesError}
            onRetry={refreshNodes}
            value={primaryNode}
            onChange={setPrimaryNode}
            ownIdentityId={ownStaked}
            role={nodeStatus?.nodeRole === 'edge' ? 'edge' : nodeStatus?.nodeRole === 'core' ? 'core' : undefined}
            required
          />
        </section>

        {/* Section 4 — Review */}
        <section className="v10-pca-create-section">
          <h3 className="v10-pca-create-section-title">4 · Review</h3>
          <div className="v10-pca-create-review">
            <div><span>Commit</span><strong>{amountValid ? `${formatPcaTrac(tokens)} TRAC` : '—'}</strong></div>
            <div><span>Discount tier</span><strong>{pctFromBps(estTier.bps)}</strong></div>
            <div><span>Primary node</span><strong>{primaryValid ? `#${primaryNode.trim()}` : '—'}</strong></div>
          </div>
          {createOwnerAddress && (
            <div className="v10-pca-create-owner">
              <span className="v10-pca-card-owner-lbl">Owner</span>
              <WalletRow
                address={createOwnerAddress}
                status={hardwareSelected ? 'connected wallet' : 'hot wallet'}
              />
            </div>
          )}
          <p className="v10-pca-create-owner-note">
            Owner = the wallet that signs the create. <strong>Being the owner does not discount your
            own publishes</strong> — you approve your publishing wallets in the next step.
          </p>
          <div className="v10-modal-tip">
            Committed TRAC is locked for the lock period (a global protocol parameter — there’s no
            lock-length input). The owner wallet still needs native gas to create the account.
          </div>
        </section>
      </div>

      <div className="v10-modal-footer">
        <button
          type="button"
          className="v10-modal-btn"
          onClick={() => {
            if (!hardwareDismissDisabled) onClose();
          }}
          disabled={hardwareDismissDisabled}
        >
          Cancel
        </button>
        <button
          type="button"
          className="v10-modal-btn primary"
          data-testid="pca-create-submit"
          onClick={handleCreate}
          disabled={!canSubmit}
        >
          {phase === 'creating' ? <span role="status">Creating…</span> : 'Create PCA'}
        </button>
      </div>
    </PcaModalShell>
  );
}
