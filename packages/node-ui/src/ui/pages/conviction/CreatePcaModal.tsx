import React, { useEffect, useMemo, useState } from 'react';
import { useFetch } from '../../hooks.js';
import {
  fetchWalletsBalances,
  createPca,
  fetchPca,
  describePcaError,
  isPcaFeatureUnavailable,
  HttpError,
  type CreatePcaResult,
  type PcaSnapshot,
} from '../../api.js';
import { useAgentsStore } from '../../stores/agents.js';
import { usePcaStore } from '../../stores/pca.js';
import { DiscountTierLadder, discountTierForTrac, WalletRow } from '../../components/Pca/index.js';
import { PcaModalShell } from './PcaModalShell.js';
import { formatTrac } from '../../lib/formatTrac.js';

type Phase = 'form' | 'creating' | 'success' | 'reconcile';

function pctFromBps(bps: number): string {
  const p = bps / 100;
  return `${p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
}

const AMOUNT_RE = /^\d+(\.\d+)?$/;

/**
 * S2 — Create PCA (single-page, 3 sections; DRIFT-1/2). Commitment + live tier
 * ladder, primary-node prefill, review (owner ≠ coverage), then Create →
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
}: {
  onClose: () => void;
  onApproveOwnWallets: (accountId: string) => void;
  onManage: (accountId: string) => void;
  /** Routes the gated (edge / no-identity) state to S6 Get-sponsored. */
  onGetSponsored: () => void;
}) {
  const nodeStatus = useAgentsStore((s) => s.nodeStatus) as
    | { nodeRole?: string; hasIdentity?: boolean; identityId?: string; blockExplorerUrl?: string | null }
    | null;
  const gated = nodeStatus?.nodeRole === 'edge' || nodeStatus?.hasIdentity === false;
  const explorer = nodeStatus?.blockExplorerUrl ?? null;

  const { data: wb } = useFetch(fetchWalletsBalances, [], 0);
  const wallets = wb?.wallets ?? [];
  const ownerWallet = wallets[0];
  const ownerTrac = wb?.balances?.find((b) => b.address === ownerWallet)?.trac;
  const ownerTracNum = ownerTrac != null ? Number(ownerTrac) : NaN;

  const trackAccount = usePcaStore((s) => s.trackAccount);
  const setCreatePending = usePcaStore((s) => s.setCreatePending);
  const clearCreatePending = usePcaStore((s) => s.clearCreatePending);
  const createPending = usePcaStore.getState().createPending;

  const [tokens, setTokens] = useState('');
  const [primaryNode, setPrimaryNode] = useState('');
  const [advanced, setAdvanced] = useState(false);
  // Resume the reconcile guard if a create is already in flight from a prior
  // session (durable marker) — never drop straight to a retryable form.
  const [phase, setPhase] = useState<Phase>(createPending ? 'reconcile' : 'form');
  const [result, setResult] = useState<(CreatePcaResult & { snapshot: PcaSnapshot | null }) | null>(null);
  const [pendingTxHash, setPendingTxHash] = useState<string | undefined>(createPending?.txHash);
  const [error, setError] = useState<string | null>(null);

  // Prefill the primary node with this node's identity once status resolves.
  useEffect(() => {
    if (!primaryNode && nodeStatus?.identityId && nodeStatus.identityId !== '0') {
      setPrimaryNode(String(nodeStatus.identityId));
    }
  }, [nodeStatus?.identityId, primaryNode]);

  const amountNum = AMOUNT_RE.test(tokens.trim()) ? Number(tokens.trim()) : NaN;
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;
  const insufficient = amountValid && Number.isFinite(ownerTracNum) && amountNum > ownerTracNum;
  const belowMinTier = amountValid && amountNum < 25_000;
  const estTier = useMemo(() => discountTierForTrac(amountValid ? amountNum : null), [amountNum, amountValid]);
  const primaryValid = /^\d+$/.test(primaryNode.trim()) && Number(primaryNode.trim()) > 0;
  // L13: don't allow submit until the owner wallet has loaded — the durable
  // double-mint marker is keyed on `ownerWallet`, so submitting before wallets
  // resolve would skip persisting it (the in-session reconcile would still fire,
  // but the refresh-survival guarantee wouldn't). Cheap belt-and-suspenders.
  const canSubmit = amountValid && !insufficient && primaryValid && !!ownerWallet && phase === 'form';

  const handleCreate = async () => {
    setPhase('creating');
    setError(null);
    // Set the double-mint guard at SUBMIT — before the await — so an ambiguous
    // failure (network drop / 500 / timeout, or the browser closing) AFTER the
    // tx may have broadcast can never silently fall back to a retryable form and
    // mint a second fund-locking PCA. Cleared only on success or a
    // definitely-pre-broadcast error below.
    if (ownerWallet) setCreatePending({ ownerEoa: ownerWallet, submittedAt: Date.now() });
    try {
      const res = await createPca({ tokens: tokens.trim(), primaryNode: primaryNode.trim() });
      trackAccount(res.accountId);
      clearCreatePending();
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
        setError(describePcaError(err)?.message ?? (err as Error)?.message ?? 'Create failed.');
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
          if (ownerWallet) setCreatePending({ ownerEoa: ownerWallet, submittedAt: Date.now(), txHash: body.txHash });
        }
      }
      setPhase('reconcile');
    }
  };

  // ----- Gated (edge / no staked identity) -----
  if (gated) {
    return (
      <PcaModalShell onClose={onClose} testId="pca-create-modal" title="Create needs a staked core-node identity">
        <div className="v10-modal-body">
          <div className="v10-modal-warning">
            Creating a Publishing Conviction Account requires a staked core-node identity to set as its
            primary node — this node has none yet. An edge node gets a publishing discount by being
            <strong> sponsored</strong>: share your operational wallets with a core node and have them
            approve you on their account.
          </div>
        </div>
        <div className="v10-modal-footer">
          <button type="button" className="v10-modal-btn" onClick={onClose}>Close</button>
          <button
            type="button"
            className="v10-modal-btn primary"
            data-testid="pca-gated-get-sponsored"
            onClick={onGetSponsored}
          >
            Get sponsored →
          </button>
        </div>
      </PcaModalShell>
    );
  }

  // ----- Reconcile (double-mint guard) -----
  if (phase === 'reconcile') {
    const txUrl = explorer && pendingTxHash ? `${explorer}/tx/${pendingTxHash}` : undefined;
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
            <p>
              A “create-pending” marker is saved, so this guard survives a refresh. Verify on the
              explorer whether a PCA was minted to <code>{ownerWallet ?? 'your owner wallet'}</code>:
            </p>
            <ul className="v10-pca-create-recon-actions">
              <li>If a PCA <strong>was</strong> minted → close this, then “Track an account by id” on the overview.</li>
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
                <span>Discount <strong>{pctFromBps(realBps)}</strong> (verified on-chain)</span>
              )}
              <span>Committed <strong>{formatTrac(result.committedTokens)} TRAC</strong></span>
            </div>
            {delta && (
              <p className="v10-pca-create-warn">
                Heads up: the on-chain discount ({pctFromBps(realBps!)}) differs from the {pctFromBps(estBps)} estimate.
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
            Approve this node’s operational wallets
          </button>
          <button type="button" className="v10-modal-btn" onClick={() => onManage(result.accountId)}>
            Manage PCA #{result.accountId}
          </button>
        </div>
      </PcaModalShell>
    );
  }

  // ----- Form (3 sections, single page) -----
  return (
    <PcaModalShell
      onClose={onClose}
      testId="pca-create-modal"
      title="Create a Publishing Conviction Account"
      subtitle="Lock TRAC up front to publish at a discount."
    >
      <div className="v10-modal-body">
        {error && <div className="v10-modal-error" role="alert">{error}</div>}

        {/* Section 1 — Commitment */}
        <section className="v10-pca-create-section">
          <h3 className="v10-pca-create-section-title">1 · Commitment</h3>
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
          {ownerTrac != null && (
            <p className="v10-pca-create-balance">
              Owner wallet balance: {formatTrac(ownerTrac)} TRAC
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

        {/* Section 2 — Primary node */}
        <section className="v10-pca-create-section">
          <h3 className="v10-pca-create-section-title">2 · Primary node</h3>
          <div className="v10-form-group">
            <label className="v10-form-label" htmlFor="pca-create-primary-node">
              Primary node (publishing-reward allocation)
            </label>
            <input
              id="pca-create-primary-node"
              data-testid="pca-create-primary-node"
              className="v10-form-input"
              type="text"
              value={primaryNode}
              onChange={(e) => setPrimaryNode(e.target.value)}
              placeholder="node identityId"
              disabled={!advanced && !!nodeStatus?.identityId}
              autoComplete="off"
            />
          </div>
          {nodeStatus?.identityId && primaryNode === String(nodeStatus.identityId) && (
            <p className="v10-pca-create-hint">✓ This node (identityId #{nodeStatus.identityId}).</p>
          )}
          <div className="v10-modal-tip">
            <span className="v10-modal-tip-title">Primary node ≠ who pays and ≠ who’s covered.</span>{' '}
            Pays the discounted cost → this account’s escrow. Covered to publish → the wallets you
            approve. Reward weight → this primary node.
          </div>
          <button
            type="button"
            className="v10-pca-track-toggle"
            aria-expanded={advanced}
            aria-controls="pca-create-advanced"
            onClick={() => setAdvanced((a) => !a)}
          >
            ▸ Advanced: point reward weight at a different node id
          </button>
          {/* F1/L5: the disclosed region carries the id the button references —
              kept in the DOM (hidden when collapsed) so aria-controls resolves. */}
          <div id="pca-create-advanced" hidden={!advanced}>
            {advanced && (
              <p className="v10-pca-create-hint">
                The node id must already be in the sharding table, or creation reverts.
              </p>
            )}
          </div>
        </section>

        {/* Section 3 — Review */}
        <section className="v10-pca-create-section">
          <h3 className="v10-pca-create-section-title">3 · Review</h3>
          <div className="v10-pca-create-review">
            <div><span>Commit</span><strong>{amountValid ? `${formatTrac(tokens)} TRAC` : '—'}</strong></div>
            <div><span>Discount (estimated)</span><strong>{pctFromBps(estTier.bps)}</strong></div>
            <div><span>Primary node</span><strong>{primaryValid ? `#${primaryNode.trim()}` : '—'}</strong></div>
          </div>
          {ownerWallet && (
            <div className="v10-pca-create-owner">
              <span className="v10-pca-card-owner-lbl">Owner</span>
              <WalletRow address={ownerWallet} />
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
        <button type="button" className="v10-modal-btn" onClick={onClose}>Cancel</button>
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
