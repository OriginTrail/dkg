import React, { useState } from 'react';
import { HttpError, describePcaError, type PcaSnapshot } from '../../api.js';
import { usePcaStore } from '../../stores/pca.js';
import {
  describeWalletTxError,
  WalletReceiptRevertedError,
  WalletReceiptWaitError,
  WalletTxStepError,
} from '../../web3/walletTxError.js';
import { formatPcaTrac } from '../../components/Pca/index.js';
import { usePcaAction, type ActionState } from '../../pca/pcaAction.js';
import { usePendingTopUpReconciliation } from '../../pca/usePendingTopUpReconciliation.js';
import type { OwnerActionSubmitter } from '../../pca/ownerActions.js';
import type { WalletTxProgress } from '../../pca/useWalletTxProgress.js';
import type { DetailDeviceAction } from '../../pca/detailWalletTx.js';
import type { DetailOwnerMode } from '../../pca/detailOwnerMode.js';

/** Funding — top-up + the W2 ambiguous-broadcast / pending-receipt honesty. */
export function FundingSection({
  accountId,
  snapshot,
  ownerTrac,
  explorer,
  ownerMode,
  ownerWritesEnabled,
  ownerTitle,
  owner,
  deviceProgress,
  refresh,
}: {
  accountId: string;
  snapshot: PcaSnapshot;
  ownerTrac?: string;
  explorer: string | null;
  ownerMode: DetailOwnerMode;
  ownerWritesEnabled: boolean;
  ownerTitle?: string;
  owner: OwnerActionSubmitter;
  deviceProgress: WalletTxProgress<DetailDeviceAction>;
  refresh: () => void;
}) {
  const topUpPending = usePcaStore((s) => s.topUpPending[accountId] ?? null);
  const setTopUpPending = usePcaStore((s) => s.setTopUpPending);
  const clearTopUpPending = usePcaStore((s) => s.clearTopUpPending);
  const [topUp, setTopUp] = useState('');
  const [fund, setFund] = usePcaAction();

  // M9 — reconcile a pending top-up receipt. This handler owns the WRITE side
  // (persisting the pending marker); the hook owns the poll/reconcile side.
  usePendingTopUpReconciliation({ accountId, setFund, refresh });

  const runFund = async () => {
    if (ownerMode === 'wallet') {
      deviceProgress.begin('topup');
    } else {
      deviceProgress.reset();
    }
    setFund({ busy: true, error: null, result: null, warning: null });
    try {
      const res = await owner.topUp(accountId, topUp.trim());
      clearTopUpPending(accountId);
      setFund({ busy: false, error: null, result: { txHash: res.txHash, message: `Added ${formatPcaTrac(res.addedTokens)} TRAC.` } });
      setTopUp('');
      refresh();
    } catch (err) {
      // W2 — a 504 carrying a broadcast txHash means the top-up MAY be on-chain (the
      // transferFrom already ran). Do NOT say "try again" — a retry would lock a SECOND
      // top-up. Warn + show the tx + let them recheck. A 504 with NO txHash is a genuine
      // pre-broadcast outage ("try again" correct), and 400/403/409 are unchanged.
      if (err instanceof HttpError && err.status === 504) {
        const txHash = (err.body as { txHash?: string } | undefined)?.txHash;
        if (txHash) {
          setTopUpPending({
            accountId,
            ownerEoa: snapshot.owner,
            submittedAt: Date.now(),
            txHash,
            tokens: topUp.trim(),
            previousTopUpBufferTrac: snapshot.topUpBufferTrac,
          });
          setFund({
            busy: false,
            error: null,
            result: null,
            warning: {
              txHash,
              message:
                'Your top-up was submitted but we lost confirmation — it may already be on-chain. Verify on the explorer before adding again; a second top-up would lock additional TRAC.',
            },
          });
          return;
        }
      }
      if (err instanceof WalletReceiptWaitError && err.txStep === 'action' && err.txHash) {
        setTopUpPending({
          accountId,
          ownerEoa: snapshot.owner,
          submittedAt: Date.now(),
          txHash: err.txHash,
          tokens: topUp.trim(),
          previousTopUpBufferTrac: snapshot.topUpBufferTrac,
        });
        setFund({
          busy: false,
          error: null,
          result: null,
          warning: {
            txHash: err.txHash,
            message:
              'Your top-up was submitted but we lost confirmation - it may already be on-chain. This exact transaction is being checked; do not add again until it resolves.',
          },
        });
        return;
      }
      if (ownerMode === 'wallet') {
        const info = describeWalletTxError(
          err,
          err instanceof WalletTxStepError ? err.txStep : err instanceof WalletReceiptWaitError ? err.txStep ?? 'action' : 'action',
        );
        setFund({
          busy: false,
          error: info.message,
          result: null,
          warning: err instanceof WalletReceiptRevertedError ? null : undefined,
        });
        return;
      }
      setFund({ busy: false, error: describePcaError(err, { accountId })?.message ?? (err as Error)?.message ?? 'Top-up failed.', result: null });
    }
  };

  return (
    <section className="v10-pca-detail-section">
      <h3 className="v10-pca-detail-section-title">Funding</h3>
      <p className="v10-pca-detail-hint">
        Top-up raises the spendable buffer. It does <strong>not</strong> extend the lock period —
        when the account expires you create a new one.
      </p>
      {ownerTrac != null && <p className="v10-pca-detail-hint">Owner balance: {formatPcaTrac(ownerTrac)} TRAC</p>}
      <div className="v10-pca-detail-form">
        <input
          className="v10-form-input"
          type="text"
          inputMode="decimal"
          value={topUp}
          onChange={(e) => setTopUp(e.target.value)}
          placeholder="Top up (TRAC)"
          disabled={!ownerWritesEnabled || fund.busy || !!topUpPending}
          aria-label="Top-up amount in TRAC"
        />
        <button
          type="button"
          className="v10-pca-card-btn primary"
          data-testid="pca-topup-btn"
          onClick={runFund}
          disabled={!ownerWritesEnabled || fund.busy || !!topUpPending || !/^\d+(\.\d+)?$/.test(topUp.trim()) || Number(topUp.trim()) <= 0}
          title={ownerTitle}
        >
          {fund.busy ? 'Adding…' : 'Add funds'}
        </button>
      </div>
      <ActionFeedback state={fund} explorer={explorer} onRecheck={refresh} />
      {topUpPending && (
        <p className="v10-pca-create-warn" data-testid="pca-topup-pending" role="alert">
          Top-up transaction <code>{topUpPending.txHash}</code> is pending confirmation. The top-up
          button is disabled while this exact receipt is checked; adding again could lock more TRAC.
          {' '}
          <button type="button" className="v10-pca-card-btn" onClick={refresh}>Recheck account</button>
        </p>
      )}
    </section>
  );
}

function ActionFeedback({
  state,
  explorer,
  onRecheck,
}: {
  state: ActionState;
  explorer: string | null;
  onRecheck?: () => void;
}) {
  if (state.warning) {
    // W2 — ambiguous broadcast: role=alert, tx + recheck, NOT a benign "try again".
    const txUrl = explorer && state.warning.txHash ? `${explorer}/tx/${state.warning.txHash}` : undefined;
    return (
      <p className="v10-pca-create-warn" data-testid="pca-action-warning" role="alert">
        {state.warning.message}{' '}
        {state.warning.txHash &&
          (txUrl ? (
            <a href={txUrl} target="_blank" rel="noreferrer">{state.warning.txHash} ↗</a>
          ) : (
            <code>{state.warning.txHash}</code>
          ))}{' '}
        {onRecheck && (
          <button type="button" className="v10-pca-card-btn" onClick={onRecheck}>Recheck</button>
        )}
      </p>
    );
  }
  if (state.error) return <p className="v10-modal-error" role="alert">{state.error}</p>;
  if (!state.result) return null;
  const txUrl = explorer && state.result.txHash ? `${explorer}/tx/${state.result.txHash}` : undefined;
  return (
    <p className="v10-pca-detail-result" data-testid="pca-action-result" role="status">
      {state.result.message}{' '}
      {txUrl && <a href={txUrl} target="_blank" rel="noreferrer">tx ↗</a>}{' '}
      Still pending? You can close this and verify here.
    </p>
  );
}
